// Feed generation tests. No DB, no network — pure rendering against seeded rows.
//
//   npx tsx --test scripts/test-contributor-feed.ts
//
// Uses node:test rather than adding a runner dependency; this repo has none and
// the spec asks for exactly five behaviours to be covered.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContributorShow, ContributorEpisode } from "../shared/schema";
import {
  renderShowFeed,
  validateFeed,
  publicEpisodes,
  rfc2822,
  formatDuration,
  xmlEscape,
  cdata,
} from "../server/contributor-feed";

const BASE = "https://shiurpod.com";

function show(over: Partial<ContributorShow> = {}): ContributorShow {
  return {
    id: "show-1", contributorId: "c-1", feedId: null,
    slug: "rav-example", title: "Daily Shiur", description: "A daily shiur.",
    language: "en", author: "Rabbi Example", ownerName: "Rabbi Example",
    ownerEmail: "show-rav-example@shiurpod.com", copyright: null, link: null,
    artworkKey: "artwork/show/show-1.jpg", artworkWidth: 3000, artworkHeight: 3000,
    categoryId: null, itunesCategory: "Religion & Spirituality", itunesSubcategory: "Judaism",
    itunesType: "episodic", explicit: false, reviewRequired: true, status: "live",
    feedXml: null, feedEtag: null, feedBuiltAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  } as ContributorShow;
}

function ep(over: Partial<ContributorEpisode> = {}): ContributorEpisode {
  return {
    id: "e-1", showId: "show-1", guid: "11111111-1111-1111-1111-111111111111",
    title: "Episode One", description: "<p>Shiur notes</p>",
    audioKey: "audio/show-1/e-1.mp3", byteSize: 16123456, durationSeconds: 2705,
    pubDate: new Date("2026-07-15T09:00:00Z"), episodeNumber: 1, seasonNumber: null,
    artworkKey: null, explicit: false, status: "published",
    publishedAt: new Date("2026-07-15T09:00:00Z"),
    seriesName: null, masechta: null, daf: null, parsha: null,
    uploadKey: null, uploadBytes: null, mediaStatus: "ready", mediaError: null,
    mediaAttempts: 0, mediaUpdatedAt: null, catalogEpisodeId: null,
    reviewedAt: null, reviewedBy: null, reviewNote: null,
    createdAt: new Date("2026-07-15T09:00:00Z"), updatedAt: new Date("2026-07-15T09:00:00Z"),
    ...over,
  } as ContributorEpisode;
}

// ── 1. Feed XML validity ──────────────────────────────────────────────────
test("renders a well-formed channel with the required iTunes fields", () => {
  const { xml } = renderShowFeed(show(), [ep()], BASE);

  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /xmlns:itunes="http:\/\/www\.itunes\.com\/dtds\/podcast-1\.0\.dtd"/);
  assert.match(xml, /xmlns:atom="http:\/\/www\.w3\.org\/2005\/Atom"/);
  // rel="self" must point at the feed's own URL — Apple uses it to detect moves
  assert.match(xml, /<atom:link href="https:\/\/shiurpod\.com\/feed\/rav-example\.xml" rel="self"/);
  assert.match(xml, /<itunes:category text="Religion &amp; Spirituality">/);
  assert.match(xml, /<itunes:category text="Judaism"\/>/);
  assert.match(xml, /<itunes:owner>/);
  assert.match(xml, /<itunes:email>show-rav-example@shiurpod\.com<\/itunes:email>/);
  assert.match(xml, /<itunes:type>episodic<\/itunes:type>/);

  // Tags must balance — a stray unclosed element invalidates the whole feed.
  const open = (xml.match(/<item>/g) || []).length;
  const close = (xml.match(/<\/item>/g) || []).length;
  assert.equal(open, close);
  assert.equal(open, 1);
});

test("escapes XML metacharacters and neutralises a CDATA break-out", () => {
  assert.equal(xmlEscape(`a & b < c > d " e ' f`), "a &amp; b &lt; c &gt; d &quot; e &apos; f");
  // "]]>" inside free text would otherwise close the section early
  const out = cdata("danger ]]> here");
  assert.ok(!/]]>\s*here/.test(out.replace("<![CDATA[", "")));
  assert.match(out, /\]\]\]\]><!\[CDATA\[>/);
});

// ── 2. Exact enclosure byte length ────────────────────────────────────────
test("enclosure length is the exact byte count, never rounded or zero", () => {
  const { xml } = renderShowFeed(show(), [ep({ byteSize: 16123456 })], BASE);
  assert.match(xml, /<enclosure url="[^"]+" length="16123456" type="audio\/mpeg"\/>/);
  assert.ok(!xml.includes('length="0"'));
});

test("an episode with no byte size is excluded rather than emitted broken", () => {
  const { xml, episodeCount } = renderShowFeed(show(), [ep({ byteSize: null })], BASE);
  assert.equal(episodeCount, 0);
  assert.ok(!xml.includes("<enclosure"));
});

// ── 3. GUID stability across edits ────────────────────────────────────────
test("GUID is permanent and independent of title, URL and publish date", () => {
  const original = ep();
  const first = renderShowFeed(show(), [original], BASE).xml;

  // Everything a creator can edit, changed at once.
  const edited = ep({
    title: "Episode One (revised)",
    description: "<p>Rewritten</p>",
    audioKey: "audio/show-1/e-1-v2.mp3",
    pubDate: new Date("2026-07-20T09:00:00Z"),
    byteSize: 17000000,
  });
  const second = renderShowFeed(show(), [edited], BASE).xml;

  const guidOf = (x: string) => x.match(/<guid isPermaLink="false">([^<]+)<\/guid>/)?.[1];
  assert.equal(guidOf(first), original.guid);
  assert.equal(guidOf(second), original.guid, "GUID must survive edits or subscribers re-download");
  assert.match(first, /isPermaLink="false"/);
});

// ── 4. Hebrew / Yiddish encoding ──────────────────────────────────────────
test("Hebrew and Yiddish round-trip byte for byte", () => {
  const he = "פרשת חיי שרה — שיעור יומי";
  const yi = "אַ גוטן שבת";
  const bilingual = "פרשת תולדות, Parashat Toldos";

  const { xml } = renderShowFeed(
    show({ title: he, description: yi, author: "הרב ישראל" }),
    [ep({ title: bilingual })],
    BASE,
  );

  assert.ok(xml.includes(he), "Hebrew show title must survive");
  assert.ok(xml.includes(yi), "Yiddish description must survive");
  assert.ok(xml.includes(bilingual), "bilingual episode title must survive");
  // And survive an actual UTF-8 encode/decode round trip, not just string identity
  assert.equal(Buffer.from(xml, "utf8").toString("utf8"), xml);
  assert.match(xml, /encoding="UTF-8"/);
});

// ── 5. Unpublished and scheduled exclusion ────────────────────────────────
test("only published, due episodes appear — newest first", () => {
  const now = new Date("2026-07-20T00:00:00Z");
  const eps = [
    ep({ id: "a", guid: "g-a", title: "Published older", pubDate: new Date("2026-07-01T00:00:00Z") }),
    ep({ id: "b", guid: "g-b", title: "Published newer", pubDate: new Date("2026-07-10T00:00:00Z") }),
    ep({ id: "c", guid: "g-c", title: "Draft", status: "draft" }),
    ep({ id: "d", guid: "g-d", title: "Unpublished", status: "unpublished" }),
    ep({ id: "e", guid: "g-e", title: "Still processing", status: "processing" }),
    // status says published but the date is in the future — must stay hidden
    ep({ id: "f", guid: "g-f", title: "Scheduled", pubDate: new Date("2026-08-01T00:00:00Z") }),
  ];

  const visible = publicEpisodes(eps, now);
  assert.deepEqual(visible.map((e) => e.title), ["Published newer", "Published older"]);

  const { xml, episodeCount } = renderShowFeed(show(), eps, now === null ? undefined as any : BASE, now);
  assert.equal(episodeCount, 2);
  for (const hidden of ["Draft", "Unpublished", "Still processing", "Scheduled"]) {
    assert.ok(!xml.includes(hidden), `${hidden} must not appear in the feed`);
  }
});

test("a scheduled episode appears once its pubDate passes, with no other change", () => {
  const scheduled = ep({ pubDate: new Date("2026-08-01T00:00:00Z") });
  assert.equal(publicEpisodes([scheduled], new Date("2026-07-31T23:59:00Z")).length, 0);
  assert.equal(publicEpisodes([scheduled], new Date("2026-08-01T00:00:01Z")).length, 1);
});

// ── Supporting format rules ───────────────────────────────────────────────
test("pubDate is RFC 2822 with a numeric offset", () => {
  assert.equal(rfc2822(new Date("2026-07-15T09:00:00Z")), "Wed, 15 Jul 2026 09:00:00 +0000");
  // Not "GMT" — some validators reject the obsolete form toUTCString() emits
  assert.ok(!rfc2822(new Date()).includes("GMT"));
});

test("itunes:duration formats correctly either side of an hour", () => {
  assert.equal(formatDuration(2705), "45:05");
  assert.equal(formatDuration(3661), "1:01:01");
  assert.equal(formatDuration(0), null);
  assert.equal(formatDuration(null), null);
});

test("ETag is content-derived: stable when nothing changed, different when it did", () => {
  const a = renderShowFeed(show(), [ep()], BASE);
  const b = renderShowFeed(show(), [ep()], BASE);
  const c = renderShowFeed(show(), [ep({ title: "Different" })], BASE);
  assert.equal(a.etag, b.etag);
  assert.notEqual(a.etag, c.etag);
});

// ── Pre-submission validation ─────────────────────────────────────────────
test("validateFeed catches what Apple would reject", () => {
  const ok = validateFeed(show(), [ep()]);
  assert.deepEqual(ok.filter((i) => i.level === "error"), [], "a good show should have no errors");

  const errs = (is: ReturnType<typeof validateFeed>) => is.filter((i) => i.level === "error").map((i) => i.message);

  assert.ok(errs(validateFeed(show({ artworkKey: null }), [ep()])).some((m) => /Artwork is required/.test(m)));
  assert.ok(errs(validateFeed(show({ artworkWidth: 800, artworkHeight: 800 }), [ep()])).some((m) => /1400/.test(m)));
  assert.ok(errs(validateFeed(show({ artworkWidth: 2000, artworkHeight: 1500 }), [ep()])).some((m) => /square/.test(m)));
  assert.ok(errs(validateFeed(show(), [])).some((m) => /No published episodes/.test(m)));

  // Duplicate GUIDs make clients silently drop episodes
  const dupes = [ep({ id: "x", guid: "same" }), ep({ id: "y", guid: "same" })];
  assert.ok(errs(validateFeed(show(), dupes)).some((m) => /Duplicate GUID/.test(m)));
});
