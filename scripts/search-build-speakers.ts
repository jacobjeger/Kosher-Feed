// Builds search.speakers and reports what merged.
//
//   DATABASE_URL=... npx tsx scripts/search-build-speakers.ts

import { rebuildSpeakers } from "../server/search/speakers";
import { db } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("--- merge-key sanity ---");
  const frand: any = await db.execute(sql`
    SELECT author, search.speaker_key(author) k, search.fold1(author) f
    FROM feeds WHERE author ILIKE '%frand%' ORDER BY author
  `);
  for (const r of frand.rows) console.log(`  ${String(r.author).padEnd(28)} skel="${r.k}"  fold="${r.f}"`);

  console.log("\nRebuilding…");
  const t0 = Date.now();
  const r = await rebuildSpeakers();
  console.log(`  ${r.authors.toLocaleString()} author strings -> ${r.speakers.toLocaleString()} speakers`);
  console.log(`  ${r.merged.toLocaleString()} speakers had multiple spellings merged  (${Date.now() - t0}ms)`);

  console.log("\n--- biggest merges ---");
  const m: any = await db.execute(sql`
    SELECT display_name, array_length(aliases,1) n, episode_count, aliases
    FROM search.speakers WHERE array_length(aliases,1) > 1
    ORDER BY episode_count DESC LIMIT 8
  `);
  for (const r2 of m.rows) {
    console.log(`  ${String(r2.display_name).slice(0, 32).padEnd(34)} ${r2.n} spellings, ${Number(r2.episode_count).toLocaleString()} episodes`);
    console.log(`      ${r2.aliases.slice(0, 3).join("  |  ")}`);
  }

  console.log("\n--- Frand ---");
  const f: any = await db.execute(sql`
    SELECT display_name, aliases, feed_count, episode_count
    FROM search.speakers WHERE name_fold LIKE '%frand%' OR name_fold LIKE '%freund%'
    ORDER BY episode_count DESC
  `);
  for (const r3 of f.rows) {
    console.log(`  ${r3.display_name}: ${r3.feed_count} feeds, ${Number(r3.episode_count).toLocaleString()} episodes`);
    console.log(`      ${r3.aliases.join(" | ")}`);
  }

  console.log("\n--- merge suggestions for human review (NOT auto-merged) ---");
  for (const sg of r.suggestions.slice(0, 8)) {
    console.log(`  "${sg.a}" (${sg.aEpisodes.toLocaleString()} eps)  <->  "${sg.b}" (${sg.bEpisodes.toLocaleString()} eps)`);
  }
  console.log(`  ${r.suggestions.length} suggestion(s) total`);

  console.log("\n--- did Frand and Freund stay separate? ---");
  const sep: any = await db.execute(sql`
    SELECT count(*) n FROM search.speakers WHERE name_fold LIKE '%frnd%' OR name_fold LIKE '%frand%' OR name_fold LIKE '%freund%'
  `);
  console.log(`  ${Number(sep.rows[0].n)} distinct speaker rows matching frand/freund`);

  process.exit(0);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
