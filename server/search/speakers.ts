import { db } from "../db";
import { sql } from "drizzle-orm";
import { SQL_SPEAKER_KEY, SQL_SPEAKER_NORM, SQL_SPEAKERS_TABLE } from "./speakers-sql";

// Builds search.speakers: one row per real person, not per author string.
//
// Why grouping happens here in TS rather than in one big SQL statement: the
// merge rule needs a pairwise edit-distance check within each candidate group,
// which is awkward in set-based SQL and trivial here. It's a batch job over
// ~5,500 rows, so the cost is irrelevant.
//
// THE MERGE RULE — and why it is narrower than it first looks.
//
// Automatic merging happens ONLY on speaker_norm equality: fold, drop
// honorifics, sort tokens. That collapses honorific, punctuation and word-order
// differences, which are certainly the same person:
//     "Rabbi Yissocher Frand" / "R' Yissocher Frand" / "Frand, Yissocher"
//         -> all "frand yissocher"
//
// It deliberately does NOT merge different spellings. I tried edit distance for
// that and the production data killed it: "Yissocher"/"Yissochor" is distance 1
// and is the same person, but so are "Rosenberg"/"Rotenberg" and
// "Shwartz"/"Shwirtz" — which may well be different people. Distance cannot
// tell a typo from a real surname, and the skeleton is worse still, since its
// vowel-dropping maps Frand and Freund (two different rabbis) to "frnd".
//
// So near-misses are recorded as SUGGESTIONS for a human, not merged silently.
// A split speaker is a discoverability problem; a wrongly merged one attributes
// shiurim to the wrong rav, which is worse and much harder to notice. This also
// matches how feed merging already works here — reviewed, with history.

const SUGGEST_DISTANCE = 1;

export interface MergeSuggestion {
  a: string;
  b: string;
  aEpisodes: number;
  bEpisodes: number;
  distance: number;
}

interface AuthorRow {
  author: string;
  skel: string;
  norm: string;
  fold: string;
  feedCount: number;
  episodeCount: number;
  popularity: number;
  feedIds: string[];
  imageUrl: string | null;
}

interface SpeakerGroup {
  members: AuthorRow[];
  skel: string;
}

// Standard Levenshtein with early exit once the budget is blown.
function withinDistance(a: string, b: string, max: number): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > max) return false;
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return false;
    [prev, cur] = [cur, prev];
  }
  return prev[n] <= max;
}

export async function rebuildSpeakers(): Promise<{
  authors: number;
  speakers: number;
  merged: number;
  suggestions: MergeSuggestion[];
}> {
  await db.execute(sql.raw(SQL_SPEAKER_KEY));
  await db.execute(sql.raw(SQL_SPEAKER_NORM));
  await db.execute(sql.raw(SQL_SPEAKERS_TABLE));

  const res: any = await db.execute(sql`
    SELECT f.author,
           search.speaker_key(f.author)  AS skel,
           search.speaker_norm(f.author) AS norm,
           search.fold1(f.author)        AS fold,
           count(*)::int                                  AS feed_count,
           coalesce(sum(f.episode_count), 0)::int         AS episode_count,
           coalesce(max(f.popularity), 0)::int            AS popularity,
           array_agg(f.id)                                AS feed_ids,
           (array_agg(f.image_url ORDER BY f.episode_count DESC NULLS LAST)
              FILTER (WHERE f.image_url IS NOT NULL))[1]  AS image_url
    FROM feeds f
    WHERE f.author IS NOT NULL
      AND btrim(f.author) <> ''
      AND (f.is_active OR f.rss_url LIKE 'kh://%')
    GROUP BY f.author
  `);

  const rows: AuthorRow[] = (res.rows || [])
    .map((r: any) => ({
      author: r.author,
      skel: r.skel || "",
      norm: r.norm || "",
      fold: r.fold || "",
      feedCount: Number(r.feed_count),
      episodeCount: Number(r.episode_count),
      popularity: Number(r.popularity),
      feedIds: r.feed_ids || [],
      imageUrl: r.image_url,
    }))
    .filter((r: AuthorRow) => r.norm !== "");

  // Automatic merge: exact speaker_norm equality only.
  const byNorm = new Map<string, AuthorRow[]>();
  for (const r of rows) {
    if (!byNorm.has(r.norm)) byNorm.set(r.norm, []);
    byNorm.get(r.norm)!.push(r);
  }
  const groups: SpeakerGroup[] = [...byNorm.values()].map((members) => ({
    members,
    skel: members[0].skel,
  }));

  // Near-misses, for human review rather than automatic action. Bucketed by
  // skeleton first so this stays O(bucket^2) instead of O(n^2) over ~5,500.
  const suggestions: MergeSuggestion[] = [];
  const bySkel = new Map<string, SpeakerGroup[]>();
  for (const g of groups) {
    if (!bySkel.has(g.skel)) bySkel.set(g.skel, []);
    bySkel.get(g.skel)!.push(g);
  }
  for (const bucket of bySkel.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i].members[0];
        const b = bucket[j].members[0];
        if (withinDistance(a.norm, b.norm, SUGGEST_DISTANCE)) {
          suggestions.push({
            a: a.author,
            b: b.author,
            aEpisodes: bucket[i].members.reduce((s, m) => s + m.episodeCount, 0),
            bEpisodes: bucket[j].members.reduce((s, m) => s + m.episodeCount, 0),
            distance: 1,
          });
        }
      }
    }
  }
  suggestions.sort((x, y) => (y.aEpisodes + y.bEpisodes) - (x.aEpisodes + x.bEpisodes));

  let merged = 0;
  await db.execute(sql`TRUNCATE search.speakers`);

  // Built as JSON and expanded server-side. Passing JS arrays straight into a
  // text[] parameter is fragile (an author containing a comma or quote breaks
  // the array literal); json_array_elements_text is unambiguous.
  const payload = groups.map((g) => {
    const members = [...g.members].sort((a, b) => b.episodeCount - a.episodeCount);
    if (members.length > 1) merged++;
    return {
      // Key on the anchor's fold, not the skeleton alone — two clusters can
      // share a skeleton (Frand / Freund) and must stay separate rows.
      merge_key: members[0].norm,
      display_name: members[0].author,
      aliases: members.map((m) => m.author),
      feed_ids: members.flatMap((m) => m.feedIds),
      feed_count: members.reduce((a, m) => a + m.feedCount, 0),
      episode_count: members.reduce((a, m) => a + m.episodeCount, 0),
      popularity: Math.max(...members.map((m) => m.popularity)),
      image_url: members.find((m) => m.imageUrl)?.imageUrl ?? null,
    };
  });

  const CHUNK = 500;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const chunk = JSON.stringify(payload.slice(i, i + CHUNK));
    await db.execute(sql`
      INSERT INTO search.speakers
        (merge_key, display_name, name_fold, search_tsv, aliases, feed_ids,
         feed_count, episode_count, popularity, image_url, updated_at)
      SELECT s.merge_key,
             s.display_name,
             search.fold1(s.display_name),
             -- Every spelling goes into the tsvector, so searching ANY alias
             -- finds the merged speaker; the skeleton at weight C carries the
             -- transliteration variants.
             setweight(to_tsvector('simple', search.fold1(s.alias_text)), 'A')
               || setweight(to_tsvector('simple', search.skeleton(search.fold1(s.alias_text))), 'C'),
             s.aliases, s.feed_ids, s.feed_count, s.episode_count,
             s.popularity, s.image_url, now()
      FROM (
        SELECT x->>'merge_key'    AS merge_key,
               x->>'display_name' AS display_name,
               x->>'image_url'    AS image_url,
               (x->>'feed_count')::int    AS feed_count,
               (x->>'episode_count')::int AS episode_count,
               (x->>'popularity')::int    AS popularity,
               ARRAY(SELECT json_array_elements_text(x->'aliases'))  AS aliases,
               ARRAY(SELECT json_array_elements_text(x->'feed_ids')) AS feed_ids,
               (SELECT string_agg(v, ' ') FROM json_array_elements_text(x->'aliases') v) AS alias_text
        FROM json_array_elements(${chunk}::json) x
      ) s
      ON CONFLICT (merge_key) DO UPDATE SET
        display_name  = EXCLUDED.display_name,
        aliases       = EXCLUDED.aliases,
        feed_ids      = EXCLUDED.feed_ids,
        feed_count    = EXCLUDED.feed_count,
        episode_count = EXCLUDED.episode_count,
        popularity    = EXCLUDED.popularity,
        image_url     = EXCLUDED.image_url,
        updated_at    = now()
    `);
  }

  return { authors: rows.length, speakers: groups.length, merged, suggestions };
}
