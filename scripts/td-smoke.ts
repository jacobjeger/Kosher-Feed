/**
 * Smoke test for the TorahDownloads adapter — exercises the parser against
 * the live site without touching the database. Run with:
 *   npx tsx scripts/td-smoke.ts
 *
 * Asserts the prompt's expected values for shiur 1030997 (Rabbi Gershon
 * Ribner, Kedoshim) and confirms the speaker-page crawl returns shiur IDs
 * with pagination correctly detected.
 */
import {
  fetchShiurDetail,
  fetchSpeakerShiurPage,
  fetchAllSpeakers,
  parseLength,
  parseGregorianDate,
  extractSpeakerIdFromHref,
  extractCategoryIdFromHref,
  extractShiurIdFromHref,
} from "../server/torahdownloads";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

async function main() {
  console.log("\n[1] Pure-function checks");
  check("parseLength('5 min') === 300", parseLength("5 min") === 300);
  check("parseLength('1 hr 12 min') === 4320", parseLength("1 hr 12 min") === 4320);
  check("parseLength('45 sec') === 45", parseLength("45 sec") === 45);
  check("parseLength('2 hours 3 minutes') === 7380", parseLength("2 hours 3 minutes") === 7380);
  check("parseLength('') === null", parseLength("") === null);
  check("parseLength('not a duration') === null", parseLength("not a duration") === null);

  check("extractSpeakerIdFromHref('/s-430-rabbi-gershon-ribner.html') === 430",
    extractSpeakerIdFromHref("/s-430-rabbi-gershon-ribner.html") === 430);
  check("extractSpeakerIdFromHref('s-430.html') === 430",
    extractSpeakerIdFromHref("s-430.html") === 430);
  check("extractCategoryIdFromHref('/c-186-kedoshim.html') === 186",
    extractCategoryIdFromHref("/c-186-kedoshim.html") === 186);
  check("extractCategoryIdFromHref('/c-186.html') === 186",
    extractCategoryIdFromHref("/c-186.html") === 186);
  check("extractShiurIdFromHref('shiur-1030997.html') === 1030997",
    extractShiurIdFromHref("shiur-1030997.html") === 1030997);
  check("extractShiurIdFromHref('/shiur-1030997') === 1030997",
    extractShiurIdFromHref("/shiur-1030997") === 1030997);

  const may3 = parseGregorianDate("May 3, '26");
  check("parseGregorianDate(\"May 3, '26\") parses to a Date",
    !!may3 && may3.getUTCFullYear() === 2026 && may3.getUTCMonth() === 4 && may3.getUTCDate() === 3,
    may3 ? may3.toISOString() : "null");

  console.log("\n[2] Live: fetchShiurDetail(1030997)");
  const detail = await fetchShiurDetail(1030997);
  if (!detail) {
    console.log("  FAIL  fetchShiurDetail returned null");
    failed++;
  } else {
    check("title is non-empty", !!detail.title && detail.title.length > 0, JSON.stringify(detail.title));
    check("speakerId === 430", detail.speakerId === 430, `got ${detail.speakerId}`);
    check("speakerName === 'Rabbi Gershon Ribner'",
      detail.speakerName === "Rabbi Gershon Ribner", JSON.stringify(detail.speakerName));
    check("categoryId === 186", detail.categoryId === 186, `got ${detail.categoryId}`);
    check("categoryName === 'Kedoshim'",
      detail.categoryName === "Kedoshim", JSON.stringify(detail.categoryName));
    check("language === 'English'",
      detail.language === "English", JSON.stringify(detail.language));
    check("durationSeconds === 300", detail.durationSeconds === 300, `got ${detail.durationSeconds}`);
    check("audioUrl === 'https://torahcdn.net/tdn/1030997.mp3'",
      detail.audioUrl === "https://torahcdn.net/tdn/1030997.mp3", detail.audioUrl);
    check("publishedAt parsed as a Date (page renders 'May 3, '26')",
      detail.publishedAt instanceof Date,
      detail.publishedAt ? detail.publishedAt.toISOString() : "null");
    console.log("  parsed:", JSON.stringify(detail, null, 2));
  }

  console.log("\n[3] Live: fetchSpeakerShiurPage(430, 1)");
  const p1 = await fetchSpeakerShiurPage(430, 1);
  check("page 1 returned shiur IDs", p1.shiurIds.length > 0, `count=${p1.shiurIds.length}`);
  check("page 1 detected hasNextPage", p1.hasNextPage === true);
  console.log(`  page 1: ${p1.shiurIds.length} shiur(s), hasNext=${p1.hasNextPage}`);
  console.log(`  first 5 IDs: ${p1.shiurIds.slice(0, 5).join(", ")}`);

  console.log("\n[4] Live: fetchAllSpeakers() — sanity-check directory parse");
  const speakers = await fetchAllSpeakers();
  check("speaker directory returned >= 100 entries", speakers.length >= 100, `count=${speakers.length}`);
  const ribner = speakers.find(s => s.id === 430);
  check("Rabbi Gershon Ribner (id=430) is present in directory", !!ribner,
    ribner ? `${ribner.name} (count=${ribner.shiurCount})` : "not found");

  console.log(`\n${failed === 0 ? "All checks passed" : `${failed} check(s) FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error("Smoke run threw:", e); process.exit(2); });
