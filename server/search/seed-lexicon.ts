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

  let surfaces = 0;
  for (const [groupKey, g] of entries) {
    for (const surface of g.surfaces) {
      await db.execute(sql`
        INSERT INTO search.lexicon (group_key, kind, surface, term_fold, display, enabled)
        VALUES (${groupKey}, ${g.kind}, ${surface}, '', ${g.display}, true)
        ON CONFLICT DO NOTHING
      `);
      surfaces++;
    }
  }

  // Drop rows whose group no longer exists in the JSON, so deleting an entry
  // from the file actually removes it rather than leaving it live forever.
  const keys = entries.map(([k]) => k);
  await db.execute(sql`
    DELETE FROM search.lexicon WHERE group_key <> ALL(${keys}::text[])
  `);

  return { groups: entries.length, surfaces };
}
