import { db } from "../db";
import { sql } from "drizzle-orm";
import { SQL_EXTENSIONS, SQL_COLUMNS, SQL_TRIGGERS, ALL_FUNCTION_SQL } from "./sql";
import { ALL_LEXICON_SQL } from "./lexicon-sql";
import { seedLexicon } from "./seed-lexicon";

// Startup verifier — the cheap counterpart to scripts/search-bootstrap.ts.
//
// It (re)creates only the sub-second objects: extensions, functions, columns,
// triggers, lexicon. It deliberately does NOT build indexes or backfill — a
// deploy must never block behind a multi-minute index build. Instead it
// VERIFIES the expensive objects and logs loudly if they're missing, so a
// fresh environment degrades to the ILIKE fallback rather than 500ing.
//
// Why this exists at all: railway.toml runs `drizzle-kit push` on every deploy,
// and push may drop indexes it doesn't know about. If that happens we want it
// visible in the logs rather than silently degrading every search to a seq scan.
// (ensureColumns() in server/index.ts is the existing precedent for hand-rolled
// idempotent DDL for the same reason.)

// Index DDL kept here, not only in scripts/search-bootstrap.ts, because these
// have been dropped in production once already: drizzle-kit push runs at build
// time on every deploy and removes indexes it doesn't know about. Drizzle can't
// express GIN with operator classes, so declaring them in shared/schema.ts is
// not an option — self-repair is.
//
// The failure is silent: ftsReady() sees the missing index, search falls back
// to ILIKE, and the only symptom is that queries get slow again. Worth
// repairing automatically rather than waiting to notice.
const REQUIRED_INDEXES: Record<string, string> = {
  episodes_search_gin: `CREATE INDEX CONCURRENTLY IF NOT EXISTS episodes_search_gin
                          ON episodes USING gin (feed_id, search_tsv)`,
  episodes_title_fold_prefix: `CREATE INDEX CONCURRENTLY IF NOT EXISTS episodes_title_fold_prefix
                          ON episodes (title_fold text_pattern_ops)`,
  feeds_search_gin: `CREATE INDEX CONCURRENTLY IF NOT EXISTS feeds_search_gin
                          ON feeds USING gin (search_tsv)`,
  feeds_name_trgm: `CREATE INDEX CONCURRENTLY IF NOT EXISTS feeds_name_trgm
                          ON feeds USING gin (title_fold gin_trgm_ops, author_fold gin_trgm_ops)`,
};

const REQUIRED_INDEX_NAMES = Object.keys(REQUIRED_INDEXES);

// Rebuilds missing/invalid indexes AFTER boot, never during it — a deploy must
// not block on an index build. CONCURRENTLY so reads and writes continue; it
// cannot run inside a transaction, which db.execute satisfies (autocommit).
async function repairIndexes(names: string[]): Promise<void> {
  for (const name of names) {
    const ddl = REQUIRED_INDEXES[name];
    if (!ddl) continue;
    try {
      const t0 = Date.now();
      // A previous CONCURRENTLY failure can leave an INVALID index behind that
      // is never used; drop it first or the create is a no-op.
      await db.execute(sql.raw(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`)).catch(() => {});
      await db.execute(sql.raw(ddl));
      console.log(`Search: rebuilt ${name} in ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e: any) {
      console.error(`Search: failed to rebuild ${name} — ${e?.message?.slice(0, 160)}`);
    }
  }
}

export interface SearchBootstrapResult {
  ok: boolean;
  missing: string[];
  invalid: string[];
  unfolded: number;
}

export async function bootstrapSearch(): Promise<SearchBootstrapResult> {
  // Advisory lock so two replicas can't race the DDL.
  const lock: any = await db.execute(
    sql`SELECT pg_try_advisory_lock(hashtext('shiurpod.search.bootstrap')) AS got`,
  );
  if (!lock.rows?.[0]?.got) {
    return { ok: true, missing: [], invalid: [], unfolded: 0 };
  }

  try {
    await db.execute(sql.raw(SQL_EXTENSIONS));
    for (const stmt of ALL_FUNCTION_SQL) await db.execute(sql.raw(stmt));
    await db.execute(sql.raw(SQL_COLUMNS));
    await db.execute(sql.raw(SQL_TRIGGERS));
    for (const stmt of ALL_LEXICON_SQL) await db.execute(sql.raw(stmt));
    await seedLexicon();

    // JSON rather than binding a JS array to text[] — drizzle serialises the
    // array as a record, and Postgres rejects it with "cannot cast type record
    // to text[]", which silently failed the whole bootstrap.
    const res: any = await db.execute(sql`
      SELECT c.relname, i.indisvalid
      FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname IN (
        SELECT json_array_elements_text(${JSON.stringify(REQUIRED_INDEX_NAMES)}::json)
      )
    `);
    const present = (res.rows || []) as { relname: string; indisvalid: boolean }[];
    const missing = REQUIRED_INDEX_NAMES.filter((n) => !present.some((r) => r.relname === n));
    const invalid = present.filter((r) => !r.indisvalid).map((r) => r.relname);

    const u: any = await db.execute(sql`SELECT count(*)::int AS n FROM episodes WHERE search_tsv IS NULL`);
    const unfolded = Number(u.rows?.[0]?.n || 0);

    const ok = missing.length === 0 && invalid.length === 0 && unfolded === 0;
    if (ok) {
      console.log("Search: schema ready (indexes valid, corpus fully folded)");
    } else {
      console.warn(
        `Search: DEGRADED to ILIKE fallback — missing=[${missing.join(",")}] ` +
        `invalid=[${invalid.join(",")}] unfolded=${unfolded}`,
      );
      // Self-repair the indexes in the background. Deliberately not awaited:
      // boot continues and search serves via the ILIKE fallback until the
      // rebuild lands (~25s for the full set at 1.65M rows).
      const broken = [...missing, ...invalid];
      if (broken.length > 0) {
        console.warn(`Search: rebuilding ${broken.length} index(es) in the background`);
        void repairIndexes(broken);
      }
      // A NULL search_tsv means the corpus itself needs re-folding, which is a
      // ~19-minute job and deliberately NOT automatic — that stays a decision.
      if (unfolded > 0) {
        console.warn(
          `Search: ${unfolded} unfolded row(s) — run ` +
          `DATABASE_URL=... npx tsx scripts/search-bootstrap.ts --step=backfill`,
        );
      }
    }
    return { ok, missing, invalid, unfolded };
  } catch (e: any) {
    console.error(`Search bootstrap failed: ${e?.message?.slice(0, 200)}`);
    return { ok: false, missing: [], invalid: [], unfolded: -1 };
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(hashtext('shiurpod.search.bootstrap'))`).catch(() => {});
  }
}
