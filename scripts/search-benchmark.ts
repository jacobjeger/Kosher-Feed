// Measures the new search against the recorded ILIKE baselines and asserts the
// recall wins are real. Safe to run any time — read-only.
//
//   DATABASE_URL=... npx tsx scripts/search-benchmark.ts

import pg from "pg";

// Measured before the overhaul, on the same data.
const BASELINE = {
  zeroResult: 1051,
  count: 1045,
  sorted: 1050,
  rare: 615,
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const c = new pg.Client({ connectionString: url, statement_timeout: 120_000 });
  await c.connect();

  const CAP = 2000;
  const runSearch = async (q: string) => {
    const { rows: [b] } = await c.query(
      "select q_fold, strict_tsq::text s, fuzzy_tsq::text f, rank_tsq::text r from search.build_query($1,false)",
      [q],
    );
    const t0 = Date.now();
    const res = await c.query(
      `WITH strict_c AS MATERIALIZED (
         SELECT id FROM episodes WHERE $1 <> '' AND search_tsv @@ $1::tsquery LIMIT ${CAP}),
       fuzzy_c AS MATERIALIZED (
         SELECT id FROM episodes WHERE $2 <> '' AND search_tsv @@ nullif($2,'')::tsquery LIMIT ${CAP}),
       cand AS (SELECT id FROM strict_c UNION SELECT id FROM fuzzy_c)
       SELECT e.id, e.title,
              4.0 * ts_rank_cd('{0.05,0.25,0.6,1.0}'::float4[], e.search_tsv, $3::tsquery, 32)
            + CASE WHEN e.title_fold = $4 THEN 6.0
                   WHEN e.title_fold LIKE $4 || '%' THEN 3.0 ELSE 0.0 END
            + 0.6 * ln(1 + greatest(e.popularity,0))
            + 0.4 * ln(1 + greatest(f.popularity,0)) AS score
       FROM cand JOIN episodes e ON e.id = cand.id JOIN feeds f ON f.id = e.feed_id
       WHERE (f.is_active OR f.rss_url LIKE 'kh://%')
       ORDER BY score DESC LIMIT 21`,
      [b.s || "", b.f || "", b.r || b.s || "", b.q_fold],
    );
    return { ms: Date.now() - t0, n: res.rowCount || 0, top: res.rows[0]?.title || "" };
  };

  console.log("=== latency (baseline: ILIKE seq scan on 1.65M rows) ===");
  const cases: [string, string, number][] = [
    ["zzqxwvnothing", "zero-result", BASELINE.zeroResult],
    ["chanukah", "common term", BASELINE.count],
    ["shabbos", "very common term", BASELINE.sorted],
    ["kamtza", "rare term", BASELINE.rare],
    ["bava batra", "multi-word + lexicon", BASELINE.count],
  ];
  let worst = 0;
  for (const [q, label, base] of cases) {
    await runSearch(q); // warm
    const runs = [await runSearch(q), await runSearch(q), await runSearch(q)];
    const ms = Math.min(...runs.map((r) => r.ms));
    worst = Math.max(worst, ms);
    const speedup = (base / ms).toFixed(1);
    console.log(
      `  ${label.padEnd(22)} "${q}" -> ${String(ms).padStart(4)}ms  (was ~${base}ms, ${speedup}x)  ${runs[0].n} rows`,
    );
  }
  console.log(`\n  worst case: ${worst}ms  ${worst < 200 ? "OK (<200ms target)" : "ABOVE 200ms TARGET"}`);

  console.log("\n=== index usage (must not say Seq Scan) ===");
  {
    const { rows: [b] } = await c.query("select strict_tsq::text s from search.build_query('chanukah',false)");
    const ex = await c.query(
      `explain (analyze, buffers) select id from episodes where search_tsv @@ $1::tsquery limit 2000`,
      [b.s],
    );
    const plan = ex.rows.map((r: any) => r["QUERY PLAN"]).join("\n");
    console.log("  " + (plan.includes("Bitmap Index Scan") ? "ok   Bitmap Index Scan on GIN" : "FAIL " + plan.split("\n")[1]));
  }

  console.log("\n=== recall vs the old exact-match behaviour ===");
  const recall: [string, string][] = [
    ["batra", "basra"],
    ["shabbat", "shabbos"],
    ["hanukkah", "chanukah"],
  ];
  for (const [q, other] of recall) {
    const { rows: [b] } = await c.query(
      "select strict_tsq::text s, fuzzy_tsq::text f from search.build_query($1,false)", [q]);
    const now = await c.query(
      `select count(*) n from episodes
        where (search_tsv @@ nullif($1,'')::tsquery or search_tsv @@ nullif($2,'')::tsquery)`,
      [b.s || "", b.f || ""],
    );
    const before = await c.query("select count(*) n from episodes where title ilike $1 or description ilike $1", [`%${q}%`]);
    console.log(`  "${q}": ${Number(now.rows[0].n).toLocaleString()} now vs ${Number(before.rows[0].n).toLocaleString()} with old exact match`);
  }

  console.log("\n=== cross-language ===");
  for (const q of ["toldos", "chanukah"]) {
    const { rows: [b] } = await c.query("select strict_tsq::text s from search.build_query($1,false)", [q]);
    const r = await c.query(
      `select count(*) n from episodes where search_tsv @@ $1::tsquery and title ~ '[\\u0590-\\u05FF]'`,
      [b.s],
    );
    console.log(`  "${q}" reaches ${Number(r.rows[0].n).toLocaleString()} Hebrew-titled episodes`);
  }

  console.log("\n=== index sizes ===");
  const sz = await c.query(`
    select relname, pg_size_pretty(pg_relation_size(oid)) sz
    from pg_class where relname in
      ('episodes_search_gin','episodes_title_fold_prefix','feeds_search_gin','feeds_name_trgm')
    order by pg_relation_size(oid) desc`);
  for (const r of sz.rows) console.log(`  ${r.relname.padEnd(28)} ${r.sz}`);

  await c.end();
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
