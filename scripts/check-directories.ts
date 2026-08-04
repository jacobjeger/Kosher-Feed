// Has a contributor show actually landed in Apple Podcasts yet?
//
//   npx tsx scripts/check-directories.ts                    # every live show
//   npx tsx scripts/check-directories.ts demo-validation-show
//
// Submission to Apple and Spotify cannot be automated (see below), but
// CHECKING can: Apple's iTunes Search API is public and unauthenticated, and
// returns the feedUrl of every show it has indexed. Matching on feedUrl rather
// than title is what makes this reliable — titles collide, feed URLs do not.
//
// Why submission itself is manual:
//   * Apple has "Delegated Delivery", which is exactly this automation — but it
//     is limited to approved hosting providers (Acast, Blubrry, Buzzsprout,
//     Libsyn, RSS.com and similar). Becoming one is an application, not an API
//     key you can request.
//   * Spotify has no public submission API at all. Its own developer forum
//     answer to this question is that the endpoint does not exist.
//
// So the workflow is: submit once by hand per show, then let this tell you when
// it goes live instead of checking by hand for days.

import { eq } from "drizzle-orm";
import { db } from "../server/db";
import { contributorShows } from "@shared/schema";
import { canonicalBaseUrl } from "../server/public-url";

const ITUNES_SEARCH = "https://itunes.apple.com/search";
const ITUNES_LOOKUP = "https://itunes.apple.com/lookup";

interface AppleResult {
  collectionId: number;
  collectionName: string;
  feedUrl?: string;
  trackViewUrl?: string;
  artistName?: string;
  releaseDate?: string;
  trackCount?: number;
}

async function appleSearch(term: string): Promise<AppleResult[]> {
  const url = `${ITUNES_SEARCH}?term=${encodeURIComponent(term)}&entity=podcast&limit=50&country=US`;
  const res = await fetch(url, { headers: { "User-Agent": "ShiurPod/1.0 (directory check)" } });
  if (!res.ok) throw new Error(`iTunes search HTTP ${res.status}`);
  const json: any = await res.json();
  return (json.results || []) as AppleResult[];
}

/** Confirm a show is still listed, once its Apple id is known. */
async function appleLookup(collectionId: number): Promise<AppleResult | null> {
  const res = await fetch(`${ITUNES_LOOKUP}?id=${collectionId}&entity=podcast`);
  if (!res.ok) return null;
  const json: any = await res.json();
  return (json.results || [])[0] || null;
}

function normaliseFeedUrl(u: string | undefined | null): string {
  return (u || "").trim().replace(/\/+$/, "").toLowerCase();
}

async function checkShow(slug: string, title: string, feedUrl: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m  (${slug})`);
  console.log(`  feed: ${feedUrl}`);

  // Is the feed even reachable? A directory cannot index what it cannot fetch.
  try {
    const r = await fetch(feedUrl, { headers: { "User-Agent": "ShiurPod/1.0" } });
    const ct = r.headers.get("content-type") || "";
    console.log(`  reachable: http ${r.status}${ct ? ` (${ct.split(";")[0]})` : ""}`);
    if (!r.ok) {
      console.log("  \x1b[31mfeed is not serving — fix this before submitting\x1b[0m");
      return;
    }
  } catch (e: any) {
    console.log(`  \x1b[31mfeed unreachable: ${e?.message?.slice(0, 80)}\x1b[0m`);
    return;
  }

  // Apple indexes by feed URL; search by title, then match the feed.
  let results: AppleResult[] = [];
  try {
    results = await appleSearch(title);
  } catch (e: any) {
    console.log(`  apple: search failed — ${e?.message?.slice(0, 80)}`);
    return;
  }

  const want = normaliseFeedUrl(feedUrl);
  const exact = results.find((r) => normaliseFeedUrl(r.feedUrl) === want);

  if (exact) {
    console.log(`  \x1b[32mapple: LISTED\x1b[0m`);
    console.log(`    id:      ${exact.collectionId}`);
    console.log(`    listing: ${exact.trackViewUrl}`);
    console.log(`    episodes Apple can see: ${exact.trackCount ?? "?"}`);
    const live = await appleLookup(exact.collectionId);
    if (live && normaliseFeedUrl(live.feedUrl) !== want) {
      // Apple keeps whatever feed URL it was given. If they diverge, Apple is
      // polling a URL we no longer control or serve.
      console.log(`    \x1b[33mwarning: Apple is polling ${live.feedUrl}\x1b[0m`);
    }
    return;
  }

  // A title match with a different feed usually means someone submitted a
  // different feed for the same show — worth seeing rather than hiding.
  const titleMatch = results.filter(
    (r) => r.collectionName?.toLowerCase().trim() === title.toLowerCase().trim(),
  );
  console.log(`  apple: \x1b[33mnot listed\x1b[0m`);
  if (titleMatch.length) {
    console.log(`    (${titleMatch.length} show(s) share this title but a different feed:)`);
    for (const t of titleMatch.slice(0, 3)) console.log(`      ${t.feedUrl}`);
  }
  console.log(`    submit at https://podcastsconnect.apple.com — the claim code goes to`);
  console.log(`    show-${slug}@shiurpod.com`);
}

async function main() {
  const arg = process.argv[2];
  const base = canonicalBaseUrl();

  const shows = arg
    ? await db.select().from(contributorShows).where(eq(contributorShows.slug, arg))
    : await db.select().from(contributorShows).where(eq(contributorShows.status, "live"));

  if (!shows.length) {
    console.log(arg ? `No show with slug "${arg}".` : "No live shows.");
    return;
  }

  console.log(`Checking ${shows.length} show(s) against Apple Podcasts…`);
  for (const s of shows) {
    await checkShow(s.slug, s.title, `${base}/feed/${s.slug}.xml`);
    // Apple rate-limits the search API at roughly 20 calls/minute.
    await new Promise((r) => setTimeout(r, 3500));
  }
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("check failed:", e);
    process.exit(1);
  });
