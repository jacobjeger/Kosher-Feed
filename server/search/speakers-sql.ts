// Speaker identity: collapsing the same person's many spellings into one.
//
// The problem, measured in production: Rabbi Yissocher Frand exists as THREE
// separate "speakers" —
//     "Rabbi Yissocher Frand"    308 episodes
//     "Frand, Harav Yissochor"   167 episodes
//     "R' Yissocher Frand"        71 episodes
// — so 546 shiurim are split three ways. A user searching "Frand" gets three
// results, follows one, and silently misses two thirds of his shiurim. This
// pattern repeats across 5,476 distinct author strings.
//
// Three things have to be normalised away to merge those:
//   1. honorifics        Rabbi / Rav / Harav / R'
//   2. name order        "Frand, Yissochor" vs "Yissocher Frand"
//   3. transliteration   Yissoch-E-r vs Yissoch-O-r
//
// (1) is a token strip, (2) is a token sort, and (3) is already solved — it's
// the same skeleton that makes "batra" find "basra". All three verified to
// collapse to the key "frnd shr".
//
// Like every other fold in this feature, this lives in SQL so the key computed
// when building the table is identical to the key computed at query time.

export const SQL_SPEAKER_KEY = `
-- Titles and suffixes that carry no identity. Deliberately conservative: this
-- runs AFTER fold1, so everything here is already lowercased and punctuation
-- has become spaces (so "r'" arrives as the bare token "r").
CREATE OR REPLACE FUNCTION search.speaker_stopword(tok text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT tok IS NULL
      OR length(tok) < 2                       -- initials: "r", "a"
      OR tok IN (
        'rabbi','rav','harav','hagaon','reb','rebbe','rebbetzin','rabbanit',
        'mrs','mr','dr','prof','shlita','zatzal','ztl','zl','hy','osb',
        'הרב','הגאון','רב','מורנו','הרבנית',
        'shiur','shiurim','lectures','lecture','podcast','audio','series'
      )
$fn$;

-- The identity key. Two author strings that produce the same key are treated
-- as the same person.
--
-- Skeletons are used per token so transliteration variants merge, but a token
-- falls back to its folded form when the skeleton is NULL — skel_token()
-- refuses tokens under 5 chars, and short surnames (Katz, Cohn) are exactly
-- the ones we must not drop.
CREATE OR REPLACE FUNCTION search.speaker_key(name text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT coalesce(string_agg(k, ' ' ORDER BY k), '')
  FROM (
    SELECT DISTINCT coalesce(search.skel_token(tok), tok) AS k
    FROM unnest(string_to_array(search.fold1(coalesce(name, '')), ' ')) AS tok
    WHERE NOT search.speaker_stopword(tok)
  ) x
$fn$;
`;

// The conservative identity form: fold, drop honorifics, sort tokens. No
// skeleton, so NO vowel-dropping and no s/t merging.
//
// Two names with the same speaker_norm differ only in honorifics, punctuation
// or word order — "Rabbi Yissocher Frand", "R' Yissocher Frand" and
// "Frand, Yissocher" all become "frand yissocher". Those are certainly the
// same person, so they merge automatically.
//
// Anything beyond that (a different SPELLING, like Yissocher/Yissochor) is a
// judgement call, and the evidence says it can't be made safely by edit
// distance alone: Rosenberg/Rotenberg and Shwartz/Shwirtz are distance 1 too,
// and may well be different people. Those surface as review suggestions rather
// than being merged silently — matching how feed merges already work here
// (mergeFeedIntoFeed + feed_merge_history).
export const SQL_SPEAKER_NORM = `
CREATE OR REPLACE FUNCTION search.speaker_norm(name text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT coalesce(string_agg(tok, ' ' ORDER BY tok), '')
  FROM (
    SELECT DISTINCT tok
    FROM unnest(string_to_array(search.fold1(coalesce(name, '')), ' ')) AS tok
    WHERE NOT search.speaker_stopword(tok)
  ) x
$fn$;
`;

export const SQL_SPEAKERS_TABLE = `
CREATE TABLE IF NOT EXISTS search.speakers (
  id            serial PRIMARY KEY,
  merge_key     text UNIQUE NOT NULL,
  display_name  text NOT NULL,
  name_fold     text NOT NULL,
  search_tsv    tsvector NOT NULL,
  aliases       text[] NOT NULL DEFAULT '{}',
  feed_ids      text[] NOT NULL DEFAULT '{}',
  feed_count    integer NOT NULL DEFAULT 0,
  episode_count integer NOT NULL DEFAULT 0,
  popularity    integer NOT NULL DEFAULT 0,
  image_url     text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS speakers_gin  ON search.speakers USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS speakers_trgm ON search.speakers USING gin (name_fold gin_trgm_ops);
CREATE INDEX IF NOT EXISTS speakers_pop  ON search.speakers (popularity DESC, episode_count DESC);
`;

// Rebuilds the whole table from feeds. Cheap enough to do wholesale (5,476
// authors over 6,729 feeds) and far simpler to reason about than incremental
// maintenance — a speaker's identity can change when any of their feeds is
// renamed, added or removed, so targeted invalidation would be subtle.
//
// display_name picks the variant with the most episodes: that's the spelling
// the largest body of content already uses, and it avoids surfacing a stub
// entry as the canonical name.
export const SQL_REBUILD_SPEAKERS = `
WITH by_author AS (
  SELECT f.author,
         search.speaker_key(f.author) AS merge_key,
         count(*)::int                AS feed_count,
         coalesce(sum(f.episode_count), 0)::int AS episode_count,
         coalesce(max(f.popularity), 0)::int    AS popularity,
         array_agg(f.id)              AS feed_ids,
         (array_agg(f.image_url ORDER BY f.episode_count DESC NULLS LAST)
            FILTER (WHERE f.image_url IS NOT NULL))[1] AS image_url
  FROM feeds f
  WHERE f.author IS NOT NULL
    AND btrim(f.author) <> ''
    AND (f.is_active OR f.rss_url LIKE 'kh://%')
  GROUP BY f.author
),
merged AS (
  SELECT merge_key,
         (array_agg(author ORDER BY episode_count DESC, author))[1] AS display_name,
         array_agg(DISTINCT author)                                  AS aliases,
         sum(feed_count)::int                                        AS feed_count,
         sum(episode_count)::int                                     AS episode_count,
         max(popularity)::int                                        AS popularity,
         (SELECT array_agg(x) FROM (
            SELECT unnest(array_agg(feed_ids)) AS x) t WHERE x IS NOT NULL) AS feed_ids,
         (array_agg(image_url ORDER BY episode_count DESC NULLS LAST)
            FILTER (WHERE image_url IS NOT NULL))[1] AS image_url
  FROM by_author
  WHERE merge_key <> ''
  GROUP BY merge_key
)
INSERT INTO search.speakers
  (merge_key, display_name, name_fold, search_tsv, aliases, feed_ids,
   feed_count, episode_count, popularity, image_url, updated_at)
SELECT m.merge_key,
       m.display_name,
       search.fold1(m.display_name),
       -- All spellings go into the tsvector, so searching ANY alias finds the
       -- merged speaker. The skeleton at weight C carries the transliteration
       -- variants on top of that.
       setweight(to_tsvector('simple', search.fold1(array_to_string(m.aliases, ' '))), 'A')
         || setweight(to_tsvector('simple',
              search.skeleton(search.fold1(array_to_string(m.aliases, ' ')))), 'C'),
       m.aliases, m.feed_ids, m.feed_count, m.episode_count, m.popularity,
       m.image_url, now()
FROM merged m
ON CONFLICT (merge_key) DO UPDATE SET
  display_name  = EXCLUDED.display_name,
  name_fold     = EXCLUDED.name_fold,
  search_tsv    = EXCLUDED.search_tsv,
  aliases       = EXCLUDED.aliases,
  feed_ids      = EXCLUDED.feed_ids,
  feed_count    = EXCLUDED.feed_count,
  episode_count = EXCLUDED.episode_count,
  popularity    = EXCLUDED.popularity,
  image_url     = EXCLUDED.image_url,
  updated_at    = now();
`;

// Remove speakers whose feeds are all gone (deleted or deactivated).
export const SQL_PRUNE_SPEAKERS = `
DELETE FROM search.speakers s
WHERE s.updated_at < now() - interval '5 minutes';
`;

// Human decisions about near-miss pairs.
//
// These MUST persist independently of search.speakers, which is truncated and
// rebuilt from feeds.author on every refresh. Without a separate record, every
// confirmed merge would be silently undone within 30 minutes.
//
// Keyed on speaker_norm rather than the raw author string so a decision
// survives cosmetic edits to a feed's author field.
//
// Rejections are stored too, not just merges — otherwise a pair a human has
// already looked at and declined would reappear in the queue on every rebuild.
export const SQL_SPEAKER_DECISIONS = `
CREATE TABLE IF NOT EXISTS search.speaker_decisions (
  id         serial PRIMARY KEY,
  a_norm     text NOT NULL,
  b_norm     text NOT NULL,
  decision   text NOT NULL CHECK (decision IN ('merge','reject')),
  decided_by text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (a_norm, b_norm)
);

-- Suggestions are recomputed on every rebuild and read by the admin UI, so
-- they live in a table rather than being recalculated per request.
CREATE TABLE IF NOT EXISTS search.speaker_suggestions (
  a_norm     text NOT NULL,
  b_norm     text NOT NULL,
  a_name     text NOT NULL,
  b_name     text NOT NULL,
  a_episodes integer NOT NULL DEFAULT 0,
  b_episodes integer NOT NULL DEFAULT 0,
  PRIMARY KEY (a_norm, b_norm)
);
`;

export const ALL_SPEAKER_SQL = [
  SQL_SPEAKER_KEY,
  SQL_SPEAKER_NORM,
  SQL_SPEAKERS_TABLE,
  SQL_SPEAKER_DECISIONS,
];
