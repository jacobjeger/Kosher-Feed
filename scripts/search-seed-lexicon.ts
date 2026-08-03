// Seeds search.lexicon and verifies query expansion, including cross-language.
//
//   DATABASE_URL=... npx tsx scripts/search-seed-lexicon.ts

import pg from "pg";
import { ALL_LEXICON_SQL } from "../server/search/lexicon-sql";
import lexicon from "../shared/search-lexicon.json";

interface LexGroup { kind: string; display: string; surfaces: string[] }

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const c = new pg.Client({ connectionString: url, statement_timeout: 120_000 });
  await c.connect();

  console.log("Installing lexicon table + build_query…");
  for (const stmt of ALL_LEXICON_SQL) await c.query(stmt);

  const entries = Object.entries(lexicon as Record<string, unknown>)
    .filter(([k]) => !k.startsWith("_")) as [string, LexGroup][];

  let n = 0;
  for (const [groupKey, g] of entries) {
    for (const surface of g.surfaces) {
      await c.query(
        `INSERT INTO search.lexicon (group_key, kind, surface, term_fold, display, enabled)
         VALUES ($1,$2,$3,'',$4,true) ON CONFLICT DO NOTHING`,
        [groupKey, g.kind, surface, g.display],
      );
      n++;
    }
  }
  await c.query(`DELETE FROM search.lexicon WHERE group_key <> ALL($1::text[])`, [entries.map(([k]) => k)]);
  const { rows: [cnt] } = await c.query("select count(*) n from search.lexicon");
  console.log(`  ${entries.length} groups, ${n} surfaces submitted, ${cnt.n} rows live\n`);

  let pass = 0, fail = 0;
  const check = (l: string, ok: boolean, d: string) => {
    ok ? pass++ : fail++;
    console.log(`${ok ? "ok  " : "FAIL"} ${l}  ${d}`);
  };

  console.log("--- query expansion ---");
  for (const q of ["toldos", "bava batra", "hanukkah", "shabbat", "תולדות"]) {
    const { rows: [r] } = await c.query(
      "select q_fold, strict_tsq::text s, fuzzy_tsq::text f from search.build_query($1, false)", [q]);
    console.log(`  "${q}" -> fold="${r.q_fold}"`);
    console.log(`      strict: ${String(r.s).slice(0, 150)}`);
    if (r.f) console.log(`      fuzzy : ${String(r.f).slice(0, 80)}`);
  }

  console.log("\n--- cross-language: does an English query reach Hebrew titles? ---");
  for (const [q, heb] of [["toldos", "תולדות"], ["hanukkah", "חנוכה"], ["bava batra", "בבא בתרא"]]) {
    const { rows: [r] } = await c.query("select strict_tsq::text s from search.build_query($1, false)", [q]);
    check(`"${q}" expands to include ${heb}`, String(r.s).includes(heb.split(" ")[0]), String(r.s).slice(0, 90));
  }

  console.log("\n--- Hebrew query reaches English titles ---");
  {
    const { rows: [r] } = await c.query("select strict_tsq::text s from search.build_query($1, false)", ["תולדות"]);
    check("תולדות expands to include toldos", String(r.s).includes("toldos"), String(r.s).slice(0, 90));
  }

  console.log("\n--- injection safety (tsquery operators must not break it) ---");
  for (const evil of ["a & b | !c", "foo:*)(", "'; drop table episodes; --", "!!!", "()"]) {
    try {
      await c.query("select * from search.build_query($1, true)", [evil]);
      check(`handles ${JSON.stringify(evil)}`, true, "no throw");
    } catch (e: any) {
      check(`handles ${JSON.stringify(evil)}`, false, e.message.slice(0, 60));
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await c.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
