// End-to-end proof that R2 works before any real shiur audio touches it.
//
//   npx tsx scripts/verify-r2.ts
//
// Every check here corresponds to something that silently breaks podcast
// playback if it's wrong, so none of them are optional:
//
//   1. Server-side PUT              — the transcode worker's write path
//   2. Public GET on the custom domain — what a podcast app fetches
//   3. Correct Content-Type         — Apple's validator checks the enclosure
//   4. HEAD returns exact bytes     — enclosure length must be byte-exact
//   5. RANGE returns 206            — every podcast client seeks; a 200 here
//                                     means scrubbing is broken app-wide
//   6. Presigned PUT cross-origin   — the creator dashboard's upload path
//   7. CORS preflight               — a browser upload dies without it
//   8. r2.dev stays disabled        — enclosure URLs must only ever be ours
//   9. Cleanup                      — leaves the bucket as it was found
//
// Exits non-zero on any failure so it can gate a deploy.

import {
  putObject,
  deleteObject,
  headObject,
  publicUrl,
  presignUpload,
  isR2Configured,
  r2Status,
} from "../server/r2";

const PREFIX = "_verify";
const ORIGIN = "https://shiurpod.com"; // a real allowed origin, for CORS checks

let failures = 0;
const created: string[] = [];

function pass(name: string, detail = "") {
  console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name: string, detail: string) {
  failures++;
  console.log(`  \x1b[31m✗\x1b[0m ${name} — ${detail}`);
}

function check(name: string, ok: boolean, detail = "") {
  ok ? pass(name, detail) : fail(name, detail || "assertion failed");
  return ok;
}

// A real MP3 frame header so the object isn't just arbitrary bytes — the
// transcode worker will be writing actual audio and Content-Type sniffing
// downstream should see something plausible.
function fakeMp3(sizeBytes: number): Buffer {
  const buf = Buffer.alloc(sizeBytes, 0);
  buf.write("ID3\x03\x00\x00\x00\x00\x00\x00", 0, "binary");
  buf[10] = 0xff; // frame sync
  buf[11] = 0xfb;
  return buf;
}

async function main() {
  console.log("\nR2 verification\n");

  const status = r2Status();
  console.log(
    `  bucket=${status.bucket} publicUrl=${status.publicUrl} account=${status.accountId}\n`,
  );

  if (!isR2Configured()) {
    console.error(
      "R2 is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,\n" +
        "R2_SECRET_ACCESS_KEY, R2_BUCKET in the environment first.\n",
    );
    process.exit(1);
  }

  // Unique per run so two concurrent runs can't delete each other's objects.
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const audioTestKey = `${PREFIX}/${stamp}/audio.mp3`;
  const presignTestKey = `${PREFIX}/${stamp}/presigned.mp3`;

  // ── 1. Server-side PUT ──────────────────────────────────────────────────
  const body = fakeMp3(64 * 1024);
  try {
    await putObject(audioTestKey, body, "audio/mpeg");
    created.push(audioTestKey);
    pass("server-side PUT", `${body.length} bytes`);
  } catch (e: any) {
    fail("server-side PUT", e?.message?.slice(0, 200) || String(e));
    // Nothing downstream can work; report and stop.
    return;
  }

  // ── 2. HEAD returns the exact byte count ────────────────────────────────
  // This is where enclosure length comes from. Wrong here = broken feed.
  const head = await headObject(audioTestKey);
  check("HEAD exists", head.exists);
  check(
    "HEAD byte size is exact",
    head.size === body.length,
    `got ${head.size}, expected ${body.length}`,
  );
  check(
    "HEAD content-type preserved",
    head.contentType === "audio/mpeg",
    `got ${head.contentType}`,
  );

  // R2 needs a moment for a fresh object to be readable on the edge.
  await new Promise((r) => setTimeout(r, 1500));

  // ── 3. Public GET over the custom domain ────────────────────────────────
  const url = publicUrl(audioTestKey);
  check("public URL is the custom domain", url.startsWith("https://audio.shiurpod.com/"), url);

  let getOk = false;
  try {
    const res = await fetch(url);
    getOk = check("public GET", res.status === 200, `http ${res.status}`);
    if (getOk) {
      const bytes = Buffer.from(await res.arrayBuffer());
      check("public GET body matches", bytes.length === body.length, `${bytes.length} bytes`);
      check(
        "public GET content-type",
        (res.headers.get("content-type") || "").includes("audio/mpeg"),
        res.headers.get("content-type") || "(none)",
      );
      // Asserted on the 200, not the 206: accept-ranges is a capability
      // advertisement, and R2 (correctly) omits it from a response that
      // already IS a range response.
      check(
        "accept-ranges advertised on 200",
        (res.headers.get("accept-ranges") || "").includes("bytes"),
        res.headers.get("accept-ranges") || "(none)",
      );
      // Not fatal — the cache rule may not be applied yet.
      const cf = res.headers.get("cf-cache-status");
      console.log(`    cf-cache-status: ${cf || "(none — cache rule not applied yet)"}`);
    }
  } catch (e: any) {
    fail("public GET", e?.message?.slice(0, 200) || String(e));
  }

  // ── 4. RANGE must return 206 ────────────────────────────────────────────
  // The single most important check. A 200 here means every seek in the
  // player re-downloads the whole file, and podcast apps resume-from-position
  // on open — this would be felt on the very first shiur.
  try {
    const res = await fetch(url, { headers: { Range: "bytes=100-199" } });
    const ok = check("RANGE returns 206", res.status === 206, `http ${res.status}`);
    if (ok) {
      const bytes = Buffer.from(await res.arrayBuffer());
      check("RANGE returns exactly the requested slice", bytes.length === 100, `${bytes.length} bytes`);
      check(
        "content-range header present",
        !!res.headers.get("content-range"),
        res.headers.get("content-range") || "(none)",
      );
    }
  } catch (e: any) {
    fail("RANGE returns 206", e?.message?.slice(0, 200) || String(e));
  }

  // ── 5. Presigned PUT, uploaded cross-origin ─────────────────────────────
  // This is exactly what the creator dashboard does from the browser.
  try {
    const signed = await presignUpload(presignTestKey, "audio/mpeg");
    check("presigned URL issued", !!signed.url && signed.key === presignTestKey);
    check(
      "presigned URL expires within the hour",
      signed.expiresAt.getTime() - Date.now() <= 60 * 60 * 1000 + 5000,
      signed.expiresAt.toISOString(),
    );

    const upBody = fakeMp3(8 * 1024);
    const up = await fetch(signed.url, {
      method: "PUT",
      headers: { "Content-Type": "audio/mpeg", Origin: ORIGIN },
      body: upBody,
    });
    const upOk = check("presigned PUT upload", up.ok, `http ${up.status}`);
    if (upOk) {
      created.push(presignTestKey);
      const h2 = await headObject(presignTestKey);
      check("presigned upload readable + exact size", h2.exists && h2.size === upBody.length,
        `${h2.size} bytes`);
      check(
        "CORS allows shiurpod.com on the PUT",
        up.headers.get("access-control-allow-origin") === ORIGIN,
        up.headers.get("access-control-allow-origin") || "(no ACAO header)",
      );
    }
  } catch (e: any) {
    fail("presigned PUT", e?.message?.slice(0, 200) || String(e));
  }

  // ── 6. CORS preflight ───────────────────────────────────────────────────
  // A browser sends OPTIONS before a PUT with Content-Type. If this fails the
  // upload dies before a single byte moves, with only a console error.
  try {
    const signed = await presignUpload(`${PREFIX}/${stamp}/preflight.mp3`, "audio/mpeg");
    const pre = await fetch(signed.url, {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    check("CORS preflight accepted", pre.status >= 200 && pre.status < 300, `http ${pre.status}`);
    check(
      "preflight allows the origin",
      pre.headers.get("access-control-allow-origin") === ORIGIN,
      pre.headers.get("access-control-allow-origin") || "(none)",
    );
    check(
      "preflight allows PUT",
      (pre.headers.get("access-control-allow-methods") || "").toUpperCase().includes("PUT"),
      pre.headers.get("access-control-allow-methods") || "(none)",
    );
  } catch (e: any) {
    fail("CORS preflight", e?.message?.slice(0, 200) || String(e));
  }

  // ── 7. r2.dev must stay disabled ────────────────────────────────────────
  // Enclosure URLs live in subscribers' podcast apps for years. If the r2.dev
  // hostname ever works, one could leak into a feed and become permanent.
  try {
    const devUrl = `https://pub-${(process.env.R2_ACCOUNT_ID || "").slice(0, 32)}.r2.dev/${audioTestKey}`;
    const res = await fetch(devUrl, { redirect: "manual" });
    check("r2.dev public URL is disabled", res.status !== 200, `http ${res.status}`);
  } catch {
    pass("r2.dev public URL is disabled", "host does not resolve");
  }

  // ── 8. Cleanup ──────────────────────────────────────────────────────────
  console.log("");
  for (const key of created) {
    try {
      await deleteObject(key);
      pass("deleted", key);
    } catch (e: any) {
      fail("delete", `${key}: ${e?.message?.slice(0, 120)}`);
    }
  }
  // Preflight never uploaded a body, but delete defensively in case a retry did.
  await deleteObject(`${PREFIX}/${stamp}/preflight.mp3`).catch(() => {});

  const gone = await headObject(audioTestKey);
  check("bucket left clean", !gone.exists);
}

main()
  .then(() => {
    console.log(
      failures === 0
        ? "\n\x1b[32mAll R2 checks passed.\x1b[0m\n"
        : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
    );
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error("\nverify-r2 crashed:", e);
    process.exit(1);
  });
