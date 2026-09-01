// Backfill: rewrite stored audio URLs that a phone cannot fetch.
//
// Android has refused cleartext HTTP since targetSdk 28 and our manifest does
// not opt back in, so every `http://` audioUrl in the catalogue is dead on
// device — the platform never dials out. 1,600 rows across 11 feeds were in
// that state; 157 of them were The Rabbi Orlofsky Show, whose listeners saw
// roughly half the archive fail to play.
//
// server/audio-url.ts now normalises at ingest, so this only has to clear the
// rows written before that. Rerunning is harmless: the predicate is
// self-shrinking and normalizeAudioUrl is idempotent.
//
//   DATABASE_URL=... npx tsx scripts/fix-cleartext-audio-urls.ts            # dry run
//   DATABASE_URL=... npx tsx scripts/fix-cleartext-audio-urls.ts --apply
//   DATABASE_URL=... npx tsx scripts/fix-cleartext-audio-urls.ts --apply --verify
//
// `--verify` range-GETs a few samples per host before writing and refuses to
// touch a host whose rewritten URLs do not actually serve audio. Slower, but
// it is the difference between fixing a host and silently breaking it.
//
// It samples several files and passes the host if ANY of them serves audio,
// because the question being asked is "does this host work over TLS", not "is
// every file still there". One sample was not enough: arigoldwag.com happened
// to draw a file the publisher had deleted, and a single 404 would have
// excluded 95 perfectly good episodes. Individually dead files are the
// dead-episode sweep's problem, not this script's.
//
// guid is deliberately left alone. Feed items with no <guid> and no <link> are
// keyed on their raw enclosure URL, and ingest still derives the key from the
// raw value — rewriting the key here would make the whole feed look new on the
// next refresh and duplicate it.

import pg from "pg";
import { normalizeAudioUrl } from "../server/audio-url";

const BATCH = Number(process.env.BACKFILL_BATCH || 500);

const apply = process.argv.includes("--apply");
const verify = process.argv.includes("--verify");

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable)";
  }
}

/** Range-GET a URL. Returns the status, or an error tag on a transport failure. */
async function probe(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { Range: "bytes=0-1", "User-Agent": "ShiurPod-backfill/1.0" },
      signal: AbortSignal.timeout(20000),
    });
    if (res.body) await res.body.cancel();
    return String(res.status);
  } catch (e: any) {
    return `ERR:${e?.cause?.code || e?.name || "unknown"}`;
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const c = new pg.Client({ connectionString: url });
  await c.connect();

  try {
    // Anything not already https is a candidate; normalizeAudioUrl decides.
    // Custom schemes (yt://, and the platform adapters') and server-relative
    // paths fall through it unchanged and are filtered out below.
    const { rows } = await c.query<{ id: string; audio_url: string }>(
      `select id, audio_url from episodes where audio_url not like 'https://%'`,
    );

    const changes = rows
      .map((r) => ({ id: r.id, from: r.audio_url, to: normalizeAudioUrl(r.audio_url) }))
      .filter((r) => r.to !== r.from);

    if (changes.length === 0) {
      console.log("Nothing to do — no stored audio URL needs rewriting.");
      return;
    }

    const byHost = new Map<string, typeof changes>();
    for (const ch of changes) {
      const h = hostOf(ch.from);
      if (!byHost.has(h)) byHost.set(h, []);
      byHost.get(h)!.push(ch);
    }

    console.log(`${changes.length} episode(s) across ${byHost.size} host(s):\n`);
    const ordered = [...byHost.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [host, list] of ordered) {
      console.log(`  ${String(list.length).padStart(5)}  ${host}`);
      console.log(`         ${list[0].from}`);
      console.log(`      -> ${list[0].to}`);
    }

    const skip = new Set<string>();
    if (verify) {
      const SAMPLES = 3;
      console.log(`\nVerifying up to ${SAMPLES} samples per host...`);
      for (const [host, list] of ordered) {
        // Spread the samples across the list rather than taking the first
        // three, which on a chronologically ordered feed would all be the same
        // vintage — and a whole vintage can be missing.
        const step = Math.max(1, Math.floor(list.length / SAMPLES));
        const picks = Array.from({ length: Math.min(SAMPLES, list.length) }, (_, i) => list[i * step]);
        const statuses: string[] = [];
        let ok = false;
        for (const pick of picks) {
          const status = await probe(pick.to);
          statuses.push(status);
          if (/^2\d\d$/.test(status)) {
            ok = true;
            break; // one success proves the host; no need to keep asking
          }
        }
        if (!ok) skip.add(host);
        console.log(`  ${ok ? "ok  " : "SKIP"}  ${host} -> ${statuses.join(", ")}`);
      }
      if (skip.size > 0) {
        console.log(
          `\n${skip.size} host(s) did not serve audio after rewriting and will be left alone.`,
        );
      }
    }

    const toWrite = changes.filter((ch) => !skip.has(hostOf(ch.from)));

    if (!apply) {
      console.log(`\nDry run. ${toWrite.length} row(s) would be updated. Pass --apply to write.`);
      return;
    }

    let written = 0;
    for (let i = 0; i < toWrite.length; i += BATCH) {
      const batch = toWrite.slice(i, i + BATCH);
      // One statement per batch, matched on the old value so a concurrent
      // ingest that already fixed a row is left as it is rather than clobbered.
      const res = await c.query(
        `update episodes e set audio_url = v.new_url
           from (select unnest($1::text[]) as id, unnest($2::text[]) as new_url,
                        unnest($3::text[]) as old_url) v
          where e.id = v.id and e.audio_url = v.old_url`,
        [batch.map((b) => b.id), batch.map((b) => b.to), batch.map((b) => b.from)],
      );
      written += res.rowCount ?? 0;
      console.log(`  ${Math.min(i + BATCH, toWrite.length)}/${toWrite.length}`);
    }

    console.log(`\nUpdated ${written} episode(s).`);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
