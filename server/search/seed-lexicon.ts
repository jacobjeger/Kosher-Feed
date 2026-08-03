import { db } from "../db";
import { sql } from "drizzle-orm";
import { ALL_LEXICON_SQL } from "./lexicon-sql";
import lexicon from "@shared/search-lexicon.json";

// Seeds search.lexicon from the JSON in the repo.
//
// The JSON is the source of truth (reviewable in PRs, diffable) and the table
// is the runtime copy — which is what lets an entry be added without a deploy
// when a zero-result query reveals a gap.
//
// Surfaces are inserted RAW. The table's trigger folds them with search.fold1,
// the same function that folded the corpus, so a lexicon entry can never be
// normalised differently from the text it is meant to match.

interface LexGroup {
  kind: string;
  display: string;
  surfaces: string[];
}

export async function seedLexicon(): Promise<{ groups: number; surfaces: number }> {
  for (const stmt of ALL_LEXICON_SQL) {
    await db.execute(sql.raw(stmt));
  }

  const entries = Object.entries(lexicon as Record<string, unknown>)
    .filter(([k]) => !k.startsWith("_")) as [string, LexGroup][];

  // Sent as one JSON document and expanded server-side. Two reasons this isn't
  // a per-row loop: it ran 418 statements on every boot, and binding JS arrays
  // straight into text[] parameters fails outright ("cannot cast type record to
  // text[]"), which is what was making the whole startup bootstrap throw.
  const rows = entries.flatMap(([groupKey, g]) =>
    g.surfaces.map((surface) => ({
      group_key: groupKey, kind: g.kind, surface, display: g.display,
    })),
  );

  await db.execute(sql`
    INSERT INTO search.lexicon (group_key, kind, surface, term_fold, display, enabled)
    SELECT x->>'group_key', x->>'kind', x->>'surface', '', x->>'display', true
    FROM json_array_elements(${JSON.stringify(rows)}::json) x
    ON CONFLICT DO NOTHING
  `);

  // Drop rows whose group is gone from the JSON, so deleting an entry from the
  // file actually removes it instead of leaving it live forever.
  await db.execute(sql`
    DELETE FROM search.lexicon
    WHERE group_key NOT IN (
      SELECT x->>'group_key' FROM json_array_elements(${JSON.stringify(rows)}::json) x
    )
  `);

  return { groups: entries.length, surfaces: rows.length };
}
