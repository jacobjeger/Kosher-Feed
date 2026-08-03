// Installs the search fold functions and asserts the golden set.
//
// Run this BEFORE any backfill. It only creates the `search` schema and its
// functions — it does not touch episodes/feeds data — so it is safe to run
// against production at any time.
//
//   DATABASE_URL=... npx tsx scripts/search-verify-fold.ts

import pg from "pg";
import { SQL_EXTENSIONS, ALL_FUNCTION_SQL } from "../server/search/sql";

// MUST collide — these are the transliteration variants the whole feature exists for.
const MUST_MATCH: [string, string][] = [
  ["basra", "batra"],
  ["chanukah", "hanukkah"],
  ["shabbos", "shabbat"],
  ["sukkos", "sukkot"],
  ["toldos", "toldot"],
  ["yevamos", "yevamot"],
];

// MUST NOT collide. torah/sarah is the permanent regression test for the
// non-initial restriction on the t->s merge; if someone loosens that rule,
// this is what catches it.
const MUST_NOT_MATCH: [string, string][] = [
  ["torah", "sarah"],
  ["moshe", "mishnah"],
  ["berachos", "bereishis"],
];

const HEBREW: [string, string, string][] = [
  ["nikud stripped", "דְּעָלְמָא", "דעלמא"],
  ["nikud stripped", "שַׁבָּת", "שבת"],
  ["final letter normalised", "ירושלים", "ירושלימ"],
  ["gershayim deleted not split", 'ר"ת', "רת"],
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const c = new pg.Client({ connectionString: url, statement_timeout: 120_000 });
  await c.connect();

  console.log("Installing search schema + fold functions…");
  await c.query(SQL_EXTENSIONS);
  for (const sql of ALL_FUNCTION_SQL) await c.query(sql);
  console.log("  done\n");

  let pass = 0;
  let fail = 0;
  const check = (label: string, ok: boolean, detail: string) => {
    ok ? pass++ : fail++;
    console.log(`${ok ? "ok  " : "FAIL"} ${label}  ${detail}`);
  };

  console.log("--- skeleton: variants MUST merge ---");
  for (const [a, b] of MUST_MATCH) {
    const r = await c.query("select search.skel_token($1) x, search.skel_token($2) y", [a, b]);
    const { x, y } = r.rows[0];
    check(`${a} = ${b}`, x !== null && x === y, `${x} / ${y}`);
  }

  console.log("\n--- skeleton: these MUST NOT merge ---");
  for (const [a, b] of MUST_NOT_MATCH) {
    const r = await c.query("select search.skel_token($1) x, search.skel_token($2) y", [a, b]);
    const { x, y } = r.rows[0];
    check(`${a} != ${b}`, x === null || y === null || x !== y, `${x} / ${y}`);
  }

  console.log("\n--- Hebrew folding ---");
  for (const [label, a, b] of HEBREW) {
    const r = await c.query("select search.fold1($1) x, search.fold1($2) y", [a, b]);
    const { x, y } = r.rows[0];
    check(`${label}: ${a}`, x === y, `"${x}" / "${y}"`);
  }

  console.log("\n--- bilingual title keeps both scripts ---");
  {
    const t = "פרשת חיי שרה - ה' הוא בורא ומנהיג, Parashat Chayei Sara";
    const r = await c.query("select search.fold1($1) f, search.episode_tsv($1,'') v", [t]);
    const f = r.rows[0].f as string;
    check("hebrew retained", /[א-ת]/.test(f), f.slice(0, 40));
    check("latin retained", /parashat/.test(f), f.slice(-40));
  }

  console.log("\n--- tsvector weights (A=title, B=descr, C=skeleton) ---");
  {
    const r = await c.query("select search.episode_tsv('Bava Basra Shiur','A description here') v");
    const v = r.rows[0].v as string;
    check("has A-weighted title", /:\d+A/.test(v), "");
    check("has B-weighted description", /:\d+B/.test(v), "");
    check("has C-weighted skeleton", /:\d+C/.test(v), "");
  }

  console.log("\n--- real corpus: does folding actually connect the variants? ---");
  // NB: skel_token() takes a SINGLE token, so it must be matched against the
  // skeleton's token array — not applied to a whole multi-word title, which
  // correctly returns NULL and would silently filter out every row.
  const REACH: [string, string, number][] = [
    ["batra", "basra", 0.95],
    ["hanukkah", "chanukah", 0.95],
    ["shabbat", "shabbos", 0.95],
  ];
  for (const [q, other, minRatio] of REACH) {
    const hit = await c.query(
      `select count(*) n from episodes
        where title ilike $1
          and search.skel_token($2) = any(
                string_to_array(search.skeleton(search.fold1(title)), ' '))`,
      [`%${other}%`, q],
    );
    const total = await c.query("select count(*) n from episodes where title ilike $1", [`%${other}%`]);
    const n = Number(hit.rows[0].n);
    const t = Number(total.rows[0].n);
    check(
      `"${q}" reaches "${other}" titles`,
      t > 0 && n / t >= minRatio,
      `${n}/${t} (${((n / t) * 100).toFixed(1)}%)`,
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await c.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
