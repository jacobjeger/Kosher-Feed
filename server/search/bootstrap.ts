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

const REQUIRED_INDEXES = [
  "episodes_search_gin",
  "episodes_title_fold_prefix",
  "feeds_search_gin",
  "feeds_name_trgm",
];

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

    const res: any = await db.execute(sql`
      SELECT c.relname, i.indisvalid
      FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = ANY(${REQUIRED_INDEXES}::text[])
    `);
    const present = (res.rows || []) as { relname: string; indisvalid: boolean }[];
    const missing = REQUIRED_INDEXES.filter((n) => !present.some((r) => r.relname === n));
    const invalid = present.filter((r) => !r.indisvalid).map((r) => r.relname);

    const u: any = await db.execute(sql`SELECT count(*)::int AS n FROM episodes WHERE search_tsv IS NULL`);
    const unfolded = Number(u.rows?.[0]?.n || 0);

    const ok = missing.length === 0 && invalid.length === 0 && unfolded === 0;
    if (ok) {
      console.log("Search: schema ready (indexes valid, corpus fully folded)");
    } else {
      console.warn(
        `Search: DEGRADED to ILIKE fallback — missing=[${missing.join(",")}] ` +
        `invalid=[${invalid.join(",")}] unfolded=${unfolded}. ` +
        `Run: DATABASE_URL=... npx tsx scripts/search-bootstrap.ts --step=all`,
      );
    }
    return { ok, missing, invalid, unfolded };
  } catch (e: any) {
    console.error(`Search bootstrap failed: ${e?.message?.slice(0, 200)}`);
    return { ok: false, missing: [], invalid: [], unfolded: -1 };
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(hashtext('shiurpod.search.bootstrap'))`).catch(() => {});
  }
}
