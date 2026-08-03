import { db } from "../db";
import { sql } from "drizzle-orm";

// The search service. One entry point, typed and ranked results.
//
// Latency comes from RANKING, not matching. "shabbos" folded together with
// "shabbat" is ~42.5k rows, and scoring 42.5k rows costs hundreds of ms with
// any index. So each tier is capped at CANDIDATE_CAP and we re-rank that
// bounded set.
//
// Consequence, stated plainly: broad-term search is NOT exhaustive. We return
// the best of the top ~4,000 matches, not the global top 20. For a podcast app
// that is invisible; it is the one place quality is traded for latency.

const CANDIDATE_CAP = 2000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export type SearchType = "episode" | "feed" | "speaker" | "category";

export interface SearchTiming {
  tookMs: number;
  impl: "fts" | "ilike";
}

export interface EpisodeHit {
  id: string;
  feedId: string;
  title: string;
  description: string | null;
  audioUrl: string;
  duration: string | null;
  publishedAt: Date | null;
  imageUrl: string | null;
  score: number;
  // Denormalised so the client never has to look the feed up in a local list.
  // The old client did exactly that and silently rendered nothing when the feed
  // wasn't loaded — a search could return 20 rows and show an empty state.
  feedTitle: string | null;
  feedAuthor: string | null;
  feedImageUrl: string | null;
}

export interface FeedHit {
  id: string;
  title: string;
  author: string | null;
  imageUrl: string | null;
  description: string | null;
  score: number;
}

export interface SpeakerHit {
  author: string;
  feedCount: number;
  imageUrl: string | null;
  score: number;
}

export interface CategoryHit {
  id: string;
  name: string;
  slug: string;
}

export interface SearchResult {
  query: string;
  queryFold: string;
  episodes: { items: EpisodeHit[]; hasMore: boolean };
  feeds: { items: FeedHit[]; hasMore: boolean };
  speakers: { items: SpeakerHit[]; hasMore: boolean };
  categories: CategoryHit[];
  tookMs: number;
  impl: "fts" | "ilike";
}

interface BuiltQuery {
  qFold: string;
  strictTsq: string | null;
  fuzzyTsq: string | null;
  rankTsq: string | null;
}

// The ONLY place a raw query string becomes a tsquery. Note there is no folding
// in TypeScript here — the raw string is handed to Postgres and folded by the
// same function that folded the corpus. Reimplementing the fold in JS would let
// index-time and query-time drift apart silently.
export async function buildQuery(raw: string, allowPrefix = true): Promise<BuiltQuery> {
  const res: any = await db.execute(sql`
    SELECT q_fold, strict_tsq::text AS strict, fuzzy_tsq::text AS fuzzy, rank_tsq::text AS rank
    FROM search.build_query(${raw}, ${allowPrefix})
  `);
  const r = res.rows?.[0];
  return {
    qFold: r?.q_fold || "",
    strictTsq: r?.strict || null,
    fuzzyTsq: r?.fuzzy || null,
    rankTsq: r?.rank || null,
  };
}

function clampLimit(n?: number): number {
  if (!n || Number.isNaN(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

export async function searchEpisodesRanked(
  q: BuiltQuery,
  limit: number,
  feedId?: string,
): Promise<{ items: EpisodeHit[]; hasMore: boolean }> {
  if (!q.strictTsq && !q.fuzzyTsq) return { items: [], hasMore: false };
  const fetch = limit + 1; // limit+1 instead of a COUNT: the old pagination
                           // COUNT measured 1045ms and can never short-circuit.

  const feedFilter = feedId ? sql`AND e.feed_id = ${feedId}` : sql``;
  const strict = q.strictTsq
    ? sql`SELECT id FROM episodes e WHERE e.search_tsv @@ ${q.strictTsq}::tsquery ${feedFilter} LIMIT ${CANDIDATE_CAP}`
    : sql`SELECT NULL::varchar AS id WHERE false`;
  const fuzzy = q.fuzzyTsq
    ? sql`SELECT id FROM episodes e WHERE e.search_tsv @@ ${q.fuzzyTsq}::tsquery ${feedFilter} LIMIT ${CANDIDATE_CAP}`
    : sql`SELECT NULL::varchar AS id WHERE false`;

  const res: any = await db.execute(sql`
    WITH strict_c AS MATERIALIZED (${strict}),
         fuzzy_c  AS MATERIALIZED (${fuzzy}),
         cand AS (SELECT id FROM strict_c UNION SELECT id FROM fuzzy_c)
    SELECT e.id, e.feed_id, e.title, e.description, e.audio_url, e.duration,
           e.published_at, e.image_url,
           f.title AS feed_title, f.author AS feed_author, f.image_url AS feed_image_url,
           (
               4.0 * ts_rank_cd('{0.05,0.25,0.6,1.0}'::float4[], e.search_tsv, ${q.rankTsq}::tsquery, 32)
             + CASE
                 WHEN e.title_fold = ${q.qFold} THEN 6.0
                 WHEN e.title_fold LIKE ${q.qFold + "%"} THEN 3.0
                 WHEN strpos(' ' || e.title_fold || ' ', ' ' || ${q.qFold} || ' ') > 0 THEN 2.0
                 ELSE 0.0
               END
             + 0.6 * ln(1 + greatest(e.popularity, 0))
             + 0.4 * ln(1 + greatest(f.popularity, 0))
             + CASE WHEN e.published_at IS NULL THEN 0.0
                    ELSE 1.5 * exp(-EXTRACT(epoch FROM now() - e.published_at) / (86400.0 * 540))
               END
           ) AS score
    FROM cand
    JOIN episodes e ON e.id = cand.id
    JOIN feeds f ON f.id = e.feed_id
    -- Join + filter that the old searchEpisodes lacked. Without it, episodes on
    -- inactive feeds were returned and then silently dropped by the client.
    WHERE (f.is_active OR f.rss_url LIKE 'kh://%')
    ORDER BY score DESC, e.published_at DESC NULLS LAST, e.id DESC
    LIMIT ${fetch}
  `);

  const rows = (res.rows || []) as any[];
  const hasMore = rows.length > limit;
  return {
    items: rows.slice(0, limit).map((r) => ({
      id: r.id,
      feedId: r.feed_id,
      title: r.title,
      description: r.description,
      audioUrl: r.audio_url,
      duration: r.duration,
      publishedAt: r.published_at,
      imageUrl: r.image_url,
      score: Number(r.score),
      feedTitle: r.feed_title,
      feedAuthor: r.feed_author,
      feedImageUrl: r.feed_image_url,
    })),
    hasMore,
  };
}

export async function searchFeedsRanked(
  q: BuiltQuery,
  limit: number,
): Promise<{ items: FeedHit[]; hasMore: boolean }> {
  if (!q.rankTsq) return { items: [], hasMore: false };
  const fetch = limit + 1;
  const res: any = await db.execute(sql`
    SELECT f.id, f.title, f.author, f.image_url, f.description,
           (
               4.0 * ts_rank_cd('{0.05,0.25,0.6,1.0}'::float4[], f.search_tsv, ${q.rankTsq}::tsquery, 32)
             + CASE
                 WHEN f.title_fold = ${q.qFold} OR f.author_fold = ${q.qFold} THEN 6.0
                 WHEN f.title_fold LIKE ${q.qFold + "%"} OR f.author_fold LIKE ${q.qFold + "%"} THEN 3.0
                 ELSE 0.0
               END
             + 0.8 * ln(1 + greatest(f.popularity, 0))
           ) AS score
    FROM feeds f
    WHERE f.search_tsv @@ ${q.rankTsq}::tsquery
      -- Inactive KH feeds stay discoverable so hidden speakers can be followed,
      -- matching the behaviour of the endpoint this replaces.
      AND (f.is_active OR f.rss_url LIKE 'kh://%')
    ORDER BY score DESC, f.title ASC
    LIMIT ${fetch}
  `);
  const rows = (res.rows || []) as any[];
  return {
    items: rows.slice(0, limit).map((r) => ({
      id: r.id,
      title: r.title,
      author: r.author,
      imageUrl: r.image_url,
      description: r.description,
      score: Number(r.score),
    })),
    hasMore: rows.length > limit,
  };
}

// Reads the derived search.speakers table (one row per person), falling back to
// grouping feeds.author on the fly if the table hasn't been built yet.
//
// The table matters for correctness, not just speed: the same rav appears under
// several author strings, so grouping raw authors shows him as several separate
// speakers and each one looks complete while holding a fraction of his shiurim.
// It also replaces /api/feeds/maggid-shiur loading 5,624 feed rows and grouping
// them in JS on every request.
export async function searchSpeakersRanked(
  q: BuiltQuery,
  limit: number,
): Promise<{ items: SpeakerHit[]; hasMore: boolean }> {
  if (!q.rankTsq) return { items: [], hasMore: false };
  const fetch = limit + 1;

  try {
    const res: any = await db.execute(sql`
      SELECT s.display_name AS author, s.feed_count, s.image_url, s.episode_count,
             (
                 4.0 * ts_rank_cd('{0.05,0.25,0.6,1.0}'::float4[], s.search_tsv, ${q.rankTsq}::tsquery, 32)
               + CASE WHEN s.name_fold = ${q.qFold} THEN 6.0
                      WHEN s.name_fold LIKE ${q.qFold + "%"} THEN 3.0
                      ELSE 0.0 END
               + 0.8 * ln(1 + greatest(s.popularity, 0))
               + 0.3 * ln(1 + greatest(s.episode_count, 0))
             ) AS score
      FROM search.speakers s
      WHERE s.search_tsv @@ ${q.rankTsq}::tsquery
      ORDER BY score DESC, s.episode_count DESC
      LIMIT ${fetch}
    `);
    const rows = (res.rows || []) as any[];
    return {
      items: rows.slice(0, limit).map((r) => ({
        author: r.author,
        feedCount: Number(r.feed_count),
        imageUrl: r.image_url,
        score: Number(r.score),
      })),
      hasMore: rows.length > limit,
    };
  } catch {
    // Table not built yet — group on the fly so speaker search still works.
    const res: any = await db.execute(sql`
      SELECT f.author, count(*)::int AS feed_count,
             (array_agg(f.image_url ORDER BY f.popularity DESC NULLS LAST))[1] AS image_url,
             max(4.0 * ts_rank_cd('{0.05,0.25,0.6,1.0}'::float4[], f.search_tsv, ${q.rankTsq}::tsquery, 32)
                 + 0.8 * ln(1 + greatest(f.popularity, 0))) AS score
      FROM feeds f
      WHERE f.author IS NOT NULL
        AND f.search_tsv @@ ${q.rankTsq}::tsquery
        AND (f.is_active OR f.rss_url LIKE 'kh://%')
      GROUP BY f.author
      ORDER BY score DESC, feed_count DESC
      LIMIT ${fetch}
    `);
    const rows = (res.rows || []) as any[];
    return {
      items: rows.slice(0, limit).map((r) => ({
        author: r.author,
        feedCount: Number(r.feed_count),
        imageUrl: r.image_url,
        score: Number(r.score),
      })),
      hasMore: rows.length > limit,
    };
  }
}

// Only 13 categories, so a plain ILIKE on the folded name is fine and needs no
// index.
export async function searchCategoriesRanked(q: BuiltQuery): Promise<CategoryHit[]> {
  if (!q.qFold) return [];
  const res: any = await db.execute(sql`
    SELECT id, name, slug FROM categories
    WHERE search.fold1(name) LIKE ${"%" + q.qFold + "%"}
    ORDER BY name
    LIMIT 5
  `);
  return (res.rows || []).map((r: any) => ({ id: r.id, name: r.name, slug: r.slug }));
}

export async function search(opts: {
  q: string;
  types?: SearchType[];
  limit?: number;
  feedId?: string;
  allowPrefix?: boolean;
}): Promise<SearchResult> {
  const t0 = Date.now();
  const limit = clampLimit(opts.limit);
  const types = opts.types?.length ? opts.types : (["episode", "feed", "speaker", "category"] as SearchType[]);
  const built = await buildQuery(opts.q, opts.allowPrefix ?? true);

  const empty = { items: [] as any[], hasMore: false };
  const [episodes, feeds, speakers, categories] = await Promise.all([
    types.includes("episode") ? searchEpisodesRanked(built, limit, opts.feedId) : Promise.resolve(empty),
    types.includes("feed") ? searchFeedsRanked(built, limit) : Promise.resolve(empty),
    types.includes("speaker") ? searchSpeakersRanked(built, Math.min(limit, 10)) : Promise.resolve(empty),
    types.includes("category") ? searchCategoriesRanked(built) : Promise.resolve([]),
  ]);

  return {
    query: opts.q,
    queryFold: built.qFold,
    episodes: episodes as { items: EpisodeHit[]; hasMore: boolean },
    feeds: feeds as { items: FeedHit[]; hasMore: boolean },
    speakers: speakers as { items: SpeakerHit[]; hasMore: boolean },
    categories: categories as CategoryHit[],
    tookMs: Date.now() - t0,
    impl: "fts",
  };
}
