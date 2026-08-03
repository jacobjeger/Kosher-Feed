// One-off bootstrap for search: columns, triggers, backfill, GIN indexes.
//
// Deliberately a SCRIPT, not part of the deploy. A deploy must never be blocked
// behind a multi-minute index build. server/search/bootstrap.ts is the cheap
// startup counterpart: it creates/replaces the sub-second objects and VERIFIES
// the expensive ones exist, degrading gracefully if they don't.
//
//   DATABASE_URL=... npx tsx scripts/search-bootstrap.ts --step=all
//   DATABASE_URL=... npx tsx scripts/search-bootstrap.ts --step=backfill
//
// Every step is idempotent and resumable. The backfill in particular can be
// killed and restarted at any point — its own predicate (search_tsv IS NULL)
// shrinks monotonically.

import pg from "pg";
import {
  SQL_EXTENSIONS,
  SQL_COLUMNS,
  SQL_TRIGGERS,
  ALL_FUNCTION_SQL,
} from "../server/search/sql";

const BATCH = Number(process.env.SEARCH_BACKFILL_BATCH || 2000);
const PAUSE_MS = Number(process.env.SEARCH_BACKFILL_PAUSE_MS || 150);
const MAX_LAG_MS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function client() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  // No statement_timeout: CREATE INDEX CONCURRENTLY on 1.65M rows takes minutes.
  return new pg.Client({ connectionString: url });
}

async function stepSchema(c: pg.Client) {
  console.log("\n== schema: extensions, functions, columns, triggers ==");
  await c.query(SQL_EXTENSIONS);
  for (const sql of ALL_FUNCTION_SQL) await c.query(sql);
  console.log("  functions installed");

  // ADD COLUMN with no default is metadata-only and instant even at 1.65M rows.
  // (A GENERATED ... STORED column would instead force a full table rewrite
  // under ACCESS EXCLUSIVE — minutes of hard lockout on the busiest table.)
  const t0 = Date.now();
  await c.query(SQL_COLUMNS);
  console.log(`  columns added in ${Date.now() - t0}ms`);

  // Triggers BEFORE the backfill, deliberately: with them live, every newly
  // ingested episode is folded on arrival, so the backfill only ever has to
  // close the historical gap and can never "finish" into a moving target.
  await c.query(SQL_TRIGGERS);
  console.log("  triggers installed (new rows now fold on write)");
}

async function stepBackfillIndex(c: pg.Client) {
  console.log("\n== backfill accelerator index ==");
  // Without this, batch 800 has to seq-scan past 1.6M already-done rows to find
  // the next 2000 nulls. With it, each batch is O(BATCH).
  const t0 = Date.now();
  await c.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS episodes_backfill_tmp
      ON episodes (id) WHERE search_tsv IS NULL
  `);
  console.log(`  built in ${Math.round((Date.now() - t0) / 1000)}s`);
}

async function backfillTable(
  c: pg.Client,
  table: "episodes" | "feeds",
  update: string,
) {
  const { rows: [{ n: remaining }] } = await c.query(
    `select count(*)::int n from ${table} where search_tsv is null`,
  );
  if (remaining === 0) {
    console.log(`  ${table}: already complete`);
    return 0;
  }
  console.log(`  ${table}: ${remaining.toLocaleString()} rows to fold`);

  let done = 0;
  let pause = PAUSE_MS;
  const start = Date.now();

  for (let i = 0; ; i++) {
    const t0 = Date.now();
    // SKIP LOCKED so the backfill neither blocks nor is blocked by live ingest.
    const res = await c.query(`
      WITH batch AS (
        SELECT id FROM ${table}
        WHERE search_tsv IS NULL
        ORDER BY id
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ${table} t SET ${update}
      FROM batch WHERE t.id = batch.id
    `);
    const n = res.rowCount || 0;
    if (n === 0) break;
    done += n;

    // Adaptive throttle: if the DB starts feeling the load, back off.
    if (i % 20 === 19) {
      const p0 = Date.now();
      await c.query("select 1");
      const lag = Date.now() - p0;
      if (lag > MAX_LAG_MS) {
        pause = Math.min(pause * 2, 5000);
        console.log(`    lag ${lag}ms -> pause now ${pause}ms`);
      }
    }

    if (i % 25 === 0) {
      const pct = ((done / remaining) * 100).toFixed(1);
      const rate = Math.round(done / ((Date.now() - start) / 1000));
      console.log(
        `    ${done.toLocaleString()}/${remaining.toLocaleString()} (${pct}%) ~${rate}/s, last batch ${Date.now() - t0}ms`,
      );
    }
    await sleep(pause);
  }

  console.log(`  ${table}: folded ${done.toLocaleString()} in ${Math.round((Date.now() - start) / 1000)}s`);
  return done;
}

async function stepBackfill(c: pg.Client) {
  console.log("\n== backfill ==");
  console.log("  NOTE: this rewrites every tuple; the table will roughly double");
  console.log("        on disk until autovacuum reclaims. VACUUM runs after.");
  await backfillTable(
    c,
    "feeds",
    `title_fold = search.fold1(search.clean(t.title, 300)),
     author_fold = search.fold1(search.clean(t.author, 200)),
     search_tsv = search.feed_tsv(t.title, t.author, t.description)`,
  );
  await backfillTable(
    c,
    "episodes",
    `title_fold = search.fold1(search.clean(t.title, 500)),
     search_tsv = search.episode_tsv(t.title, t.description)`,
  );
}

async function stepIndexes(c: pg.Client) {
  console.log("\n== GIN indexes (CONCURRENTLY — minutes, reads/writes continue) ==");
  // CIC cannot run inside a transaction. node-postgres is autocommit by
  // default, so these bare queries are fine — but they must never be moved
  // inside a db.transaction().
  const idx: [string, string][] = [
    [
      "episodes_search_gin",
      // btree_gin lets the one index serve BOTH global search (tsv only) and
      // in-feed search (feed_id + tsv).
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS episodes_search_gin
         ON episodes USING gin (feed_id, search_tsv)`,
    ],
    [
      "episodes_title_fold_prefix",
      // text_pattern_ops so LIKE 'x%' is index-usable for the prefix boost.
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS episodes_title_fold_prefix
         ON episodes (title_fold text_pattern_ops)`,
    ],
    [
      "feeds_search_gin",
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS feeds_search_gin
         ON feeds USING gin (search_tsv)`,
    ],
    [
      "feeds_name_trgm",
      // Trigram is used ONLY here, on 6.7k rows, where it behaves well. It is
      // deliberately NOT on episodes: Hebrew roots are 3 letters, so trigram
      // keys like שבת would have posting lists in the hundreds of thousands
      // across 890k Hebrew titles — the pathological case for GIN.
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS feeds_name_trgm
         ON feeds USING gin (title_fold gin_trgm_ops, author_fold gin_trgm_ops)`,
    ],
  ];

  for (const [name, sql] of idx) {
    const t0 = Date.now();
    process.stdout.write(`  ${name} … `);
    try {
      await c.query(sql);
      console.log(`${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e: any) {
      console.log(`FAILED: ${e.message}`);
    }
  }

  // CIC can fail and leave an INVALID index, which is silently never used —
  // you'd just quietly fall back to seq scans. Always verify, always repair.
  const { rows } = await c.query(`
    SELECT c.relname, i.indisvalid
    FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relname = ANY($1)
  `, [idx.map(([n]) => n)]);

  for (const r of rows) {
    if (!r.indisvalid) {
      console.log(`  ${r.relname} is INVALID — dropping and retrying`);
      await c.query(`DROP INDEX CONCURRENTLY IF EXISTS ${r.relname}`);
      const retry = idx.find(([n]) => n === r.relname);
      if (retry) await c.query(retry[1]);
    }
  }
  const missing = idx.map(([n]) => n).filter((n) => !rows.some((r) => r.relname === n));
  if (missing.length) console.log(`  MISSING: ${missing.join(", ")}`);
  else console.log("  all indexes present and valid");

  await c.query(`DROP INDEX CONCURRENTLY IF EXISTS episodes_backfill_tmp`);
  console.log("  dropped backfill accelerator");
}

async function stepVacuum(c: pg.Client) {
  console.log("\n== vacuum analyze (reclaims backfill bloat, refreshes stats) ==");
  for (const t of ["feeds", "episodes"]) {
    const t0 = Date.now();
    await c.query(`VACUUM (ANALYZE) ${t}`);
    console.log(`  ${t}: ${Math.round((Date.now() - t0) / 1000)}s`);
  }
}

async function stepVerify(c: pg.Client) {
  console.log("\n== verify ==");
  const q = async (label: string, sql: string, want: (n: number) => boolean) => {
    const { rows: [r] } = await c.query(sql);
    const n = Number(Object.values(r)[0]);
    console.log(`  ${want(n) ? "ok  " : "FAIL"} ${label}: ${n.toLocaleString()}`);
    return want(n);
  };
  await q("episodes unfolded (want 0)", "select count(*) from episodes where search_tsv is null", (n) => n === 0);
  await q("feeds unfolded (want 0)", "select count(*) from feeds where search_tsv is null", (n) => n === 0);
  // Fold-drift check: if a fold rule ever changes without a re-backfill, this
  // is what catches it. Sampled so it stays cheap enough to run nightly.
  await q(
    "fold drift on 1% sample (want 0)",
    `select count(*) from episodes tablesample system (1)
      where search_tsv is distinct from search.episode_tsv(title, description)`,
    (n) => n === 0,
  );
  await q(
    "invalid indexes (want 0)",
    `select count(*) from pg_class c join pg_index i on i.indexrelid=c.oid
      where c.relname like '%search%' and not i.indisvalid`,
    (n) => n === 0,
  );
}

async function main() {
  const step = (process.argv.find((a) => a.startsWith("--step=")) || "--step=all").split("=")[1];
  const c = client();
  await c.connect();
  const t0 = Date.now();
  try {
    if (step === "all" || step === "schema") await stepSchema(c);
    if (step === "all" || step === "backfill") {
      await stepBackfillIndex(c);
      await stepBackfill(c);
    }
    if (step === "all" || step === "indexes") await stepIndexes(c);
    if (step === "all" || step === "vacuum") await stepVacuum(c);
    if (step === "all" || step === "verify") await stepVerify(c);
    console.log(`\ndone in ${Math.round((Date.now() - t0) / 1000)}s`);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error("BOOTSTRAP FAILED:", e.message);
  process.exit(1);
});
