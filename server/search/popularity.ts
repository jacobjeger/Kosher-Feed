import { db } from "../db";
import { sql } from "drizzle-orm";

// Denormalises popularity onto feeds/episodes so ranking never joins an
// aggregate at query time.
//
// This also fixes a pre-existing cost unrelated to search: getAllFeedStats()
// runs three unbounded GROUP BYs — one of which joins episode_listens against
// all 1.65M episodes — and /api/feeds?sort=popular called it on EVERY request.
//
// The formula matches the one it replaces (routes.ts: subscriberCount*3 +
// listenCount) so ordering stays familiar to users.
//
// ln(1+p) is used at rank time rather than raw p: listen counts are power-law
// distributed, and a linear term would let the single most-listened feed
// dominate every query regardless of relevance.

export async function refreshSearchPopularity(): Promise<{ episodes: number; feeds: number }> {
  // Episodes: only rows that actually have listens (a small subset of 1.65M),
  // and only those whose value changed. The IS DISTINCT FROM guard matters —
  // without it this would touch every row, and the search trigger would
  // recompute every tsvector and rewrite the GIN index on each run.
  const ep: any = await db.execute(sql`
    UPDATE episodes e SET popularity = c.n
    FROM (
      SELECT episode_id, count(*)::int AS n
      FROM episode_listens
      WHERE listened_at > now() - interval '180 days'
      GROUP BY episode_id
    ) c
    WHERE e.id = c.episode_id AND e.popularity IS DISTINCT FROM c.n
  `);

  const fd: any = await db.execute(sql`
    UPDATE feeds f
    SET popularity = x.score, episode_count = x.eps
    FROM (
      SELECT f2.id,
             (coalesce(s.n,0) * 3 + coalesce(l.n,0))::int AS score,
             coalesce(e.n,0)::int AS eps
      FROM feeds f2
      LEFT JOIN (SELECT feed_id, count(*) n FROM subscriptions GROUP BY 1) s ON s.feed_id = f2.id
      LEFT JOIN (SELECT feed_id, count(*) n FROM episodes GROUP BY 1) e ON e.feed_id = f2.id
      LEFT JOIN (SELECT ep.feed_id, count(*) n
                   FROM episode_listens el JOIN episodes ep ON ep.id = el.episode_id
                  GROUP BY 1) l ON l.feed_id = f2.id
    ) x
    WHERE f.id = x.id
      AND (f.popularity IS DISTINCT FROM x.score OR f.episode_count IS DISTINCT FROM x.eps)
  `);

  return { episodes: ep.rowCount || 0, feeds: fd.rowCount || 0 };
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startPopularityRefresh(): void {
  if (timer) return;
  const run = async () => {
    try {
      const t0 = Date.now();
      const r = await refreshSearchPopularity();
      if (r.episodes > 0 || r.feeds > 0) {
        console.log(
          `Search popularity: ${r.episodes} episode(s), ${r.feeds} feed(s) updated in ${Date.now() - t0}ms`,
        );
      }
    } catch (e: any) {
      console.error(`Search popularity refresh failed: ${e?.message?.slice(0, 160)}`);
    }
  };
  timer = setInterval(run, 30 * 60 * 1000);
  // Delay the first run so it doesn't compete with boot-time work.
  setTimeout(run, 90_000);
}
