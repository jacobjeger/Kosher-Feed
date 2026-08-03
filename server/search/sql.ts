// SQL definitions for search: folding, skeletons, tsvectors, triggers.
//
// THE CENTRAL RULE OF THIS FILE: the fold exists ONLY here, in SQL. TypeScript
// never folds a string. Query text is passed raw to Postgres and folded by the
// same functions that folded the corpus.
//
// This is not a convention to remember — it's enforced by construction. If the
// fold were reimplemented in JS, index-time and query-time folding would drift
// the moment either changed, and matching would break silently: no error, just
// results quietly going missing. That failure mode is why every function below
// is SQL and why server/search/query.ts calls search.build_query() rather than
// building a tsquery in JS.
//
// Everything here is idempotent (CREATE OR REPLACE / IF NOT EXISTS) so the
// startup verifier can re-run it safely on every boot.

// --- Extensions -------------------------------------------------------------
// pg_trgm: trigram index, used ONLY on small tables (feeds ~6.7k rows, the term
//   dictionary). Deliberately NOT on episodes — Hebrew roots are 3 letters, so
//   trigram keys like שבת/פרש would have posting lists in the hundreds of
//   thousands across 890k Hebrew titles, which is the pathological case for GIN.
// btree_gin: lets one GIN index cover (feed_id, search_tsv) so the same index
//   serves both global search and in-feed search.
//
// unaccent is deliberately absent: it is STABLE, not IMMUTABLE, and is the
// classic cause of silently-rotting expression indexes. normalize(t, NFKD) is
// in core since PG13 and handles Hebrew nikud, Latin diacritics and Hebrew
// presentation forms in one genuinely-immutable pass.
export const SQL_EXTENSIONS = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE SCHEMA IF NOT EXISTS search;
`;

// --- Stage 0: clean ---------------------------------------------------------
// Strips residual HTML and URLs, then caps length. The cap is the main lever on
// index size and ts_rank cost. Measured avg description length is only ~50
// chars, so 4000 is generous headroom rather than a real constraint — it exists
// to bound the outliers (YouTube descriptions carry chapter lists and link
// boilerplate that would otherwise pollute the term distribution).
export const SQL_CLEAN = `
CREATE OR REPLACE FUNCTION search.clean(t text, cap int DEFAULT 4000)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT left(
    regexp_replace(
      regexp_replace(coalesce(t, ''), '<[^>]*>', ' ', 'g'),
      'https?://[^[:space:]]+|www\\.[^[:space:]]+', ' ', 'g'),
    cap)
$fn$;
`;

// --- Stage 1: conservative fold, both scripts -------------------------------
// Order is load-bearing in two places, both marked below.
export const SQL_FOLD1 = `
CREATE OR REPLACE FUNCTION search.fold1(t text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT btrim(regexp_replace(
    regexp_replace(
      translate(
        regexp_replace(
          translate(
            translate(
              lower(normalize(coalesce(t, ''), NFKD)),
              -- (1) Hebrew word-SEPARATING punctuation -> space.
              -- MUST run before the nikud strip below: maqaf/paseq/sof-pasuq/
              -- nun-hafukha all live inside U+0591-U+05C7 and would otherwise be
              -- deleted, welding two words together (בין־המצרים -> ביןהמצרים).
              U&'\\05BE\\05C0\\05C3\\05C6', '    '),
            -- (2) geresh/gershayim/quotes are DELETED, not spaced, so the
            -- abbreviation ר״ת folds to רת rather than splitting into ר and ת.
            U&'\\05F3\\05F4''"\`', ''),
          -- (3) combining marks: Latin diacritics + Hebrew nikud & te'amim,
          -- plus bidi/invisible controls which are rife in scraped Hebrew.
          U&'[\\0300-\\036F\\0591-\\05C7\\200B-\\200F\\202A-\\202E\\FEFF\\00AD]', '', 'g'),
        -- (4) Hebrew final letters -> base forms: ם ן ץ ף ך -> מ נ צ פ כ
        U&'\\05DD\\05DF\\05E5\\05E3\\05DA',
        U&'\\05DE\\05E0\\05E6\\05E4\\05DB'),
      -- (5) anything not a digit, Latin letter or Hebrew letter -> space
      U&'[^0-9a-z\\05D0-\\05EA]+', ' ', 'g'),
    '[[:space:]]+', ' ', 'g'), ' ')
$fn$;
`;

// --- Stage 2: transliteration skeleton, Latin only --------------------------
// Collapses Ashkenazi/Sephardi and spelling variants to a single token, so
// "batra" and "basra" become the SAME lexeme and match by exact GIN lookup
// rather than edit distance.
//
// Rule 5 (t/s merge) is restricted to NON-INITIAL position, and that restriction
// is the single most important false-positive bound in the whole design. The tav
// that varies between pronunciations essentially never occurs word-initially in
// this vocabulary. Without the restriction:
//     torah -> s,r,h = srh
//     sarah -> s,r,h = srh      <-- Torah and Sarah become the same word
// That collision would be catastrophic and high-frequency. With it, torah->trh
// and sarah->srh stay distinct while every measured variant pair still merges.
// There is a permanent regression test for exactly this in verify.ts.
//
// Uppercase letters act as "already processed" markers so later lowercase rules
// can't rewrite an earlier rule's output (e.g. 'sh'->'X' protects shin from the
// s-merge, since shin is phonemically distinct from samech).
export const SQL_SKEL = `
CREATE OR REPLACE FUNCTION search.skel_token(tok text)
RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
DECLARE s text; head text; tail text;
BEGIN
  -- Length floor of 5: short tokens (rav, daf, bar, tov) produce 2-consonant
  -- skeletons that collide indiscriminately.
  IF tok IS NULL OR length(tok) < 5 THEN RETURN NULL; END IF;
  -- Latin only. Hebrew needs no transliteration skeleton.
  IF tok !~ '^[a-z0-9]+$' THEN RETURN NULL; END IF;

  s := regexp_replace(tok, '(.)\\1+', '\\1', 'g');   -- 0: collapse doubles (hanukkah->hanukah)
  s := replace(s, 'sh', 'X');                       -- 1: protect shin before the s-merge
  s := regexp_replace(s, 'ts|tz|zh|z', 'Z', 'g');   -- 2: tzadi/zayin
  s := regexp_replace(s, 'ch|kh|h', 'H', 'g');      -- 3: ches/chaf/hey (chanukah=hanukkah)
  s := regexp_replace(s, 'ck|q|c|k', 'K', 'g');     -- 4: kuf/kaf

  -- 5: NON-INITIAL t/th/s -> S. See the note above; this split is the guard.
  head := left(s, 1);
  tail := substr(s, 2);
  tail := regexp_replace(tail, 'th|t|s', 'S', 'g');
  s := head || tail;

  s := regexp_replace(s, 'w|v', 'V', 'g');
  s := regexp_replace(s, 'ph|f', 'F', 'g');
  s := regexp_replace(s, 'j|g', 'G', 'g');
  s := regexp_replace(s, '[aeiouy]', '', 'g');      -- 7: Semitic orthography is consonantal
  s := regexp_replace(s, '(.)\\1+', '\\1', 'g');    -- 8: re-collapse
  s := lower(s);

  IF length(s) < 3 THEN RETURN NULL; END IF;
  RETURN s;
END $fn$;
`;

export const SQL_SKELETON = `
CREATE OR REPLACE FUNCTION search.skeleton(folded text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT coalesce(string_agg(s, ' '), '')
  FROM (
    SELECT search.skel_token(tok) AS s
    FROM unnest(string_to_array(coalesce(folded, ''), ' ')) AS tok
  ) x
  WHERE s IS NOT NULL
$fn$;
`;

// --- tsvector assembly ------------------------------------------------------
// 'simple' config, never 'english'. English stemming is useless on the 54% of
// titles that are Hebrew and actively harmful on transliterations.
//
// Weights give the exact > prefix > fuzzy ordering for free at rank time:
//   A = folded title, B = folded description, C = skeleton of title.
// A skeleton hit therefore can never outrank a real title hit.
export const SQL_TSV = `
CREATE OR REPLACE FUNCTION search.episode_tsv(title text, descr text)
RETURNS tsvector LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  WITH tf AS (SELECT search.fold1(search.clean(title, 500)) AS f)
  SELECT setweight(to_tsvector('simple', tf.f), 'A')
      || setweight(to_tsvector('simple', search.fold1(search.clean(descr, 4000))), 'B')
      || setweight(to_tsvector('simple', search.skeleton(tf.f)), 'C')
  FROM tf
$fn$;

CREATE OR REPLACE FUNCTION search.feed_tsv(title text, author text, descr text)
RETURNS tsvector LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  WITH tf AS (
    SELECT search.fold1(search.clean(title, 300))  AS ft,
           search.fold1(search.clean(author, 200)) AS fa
  )
  SELECT setweight(to_tsvector('simple', tf.ft), 'A')
      || setweight(to_tsvector('simple', tf.fa), 'A')
      || setweight(to_tsvector('simple', search.fold1(search.clean(descr, 2000))), 'B')
      || setweight(to_tsvector('simple', search.skeleton(tf.ft || ' ' || tf.fa)), 'C')
  FROM tf
$fn$;
`;

// --- Triggers ---------------------------------------------------------------
// The NOT DISTINCT guard is essential, not defensive noise. The popularity
// refresh job UPDATEs rows across a 1.65M-row table; without this guard every
// one of those updates would recompute a tsvector and rewrite the GIN index,
// turning a cheap counter refresh into a full index churn.
//
// BEFORE UPDATE OF already narrows firing, but `UPDATE OF col` fires on
// MENTION in the SET list, not on actual change — so the inner check is what
// actually does the work.
export const SQL_TRIGGERS = `
CREATE OR REPLACE FUNCTION search.episodes_search_trg() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.title       IS NOT DISTINCT FROM OLD.title
     AND NEW.description IS NOT DISTINCT FROM OLD.description
     AND NEW.search_tsv  IS NOT NULL
  THEN
    RETURN NEW;
  END IF;
  NEW.title_fold := search.fold1(search.clean(NEW.title, 500));
  NEW.search_tsv := search.episode_tsv(NEW.title, NEW.description);
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS episodes_search_biu ON episodes;
CREATE TRIGGER episodes_search_biu
  BEFORE INSERT OR UPDATE OF title, description ON episodes
  FOR EACH ROW EXECUTE FUNCTION search.episodes_search_trg();

CREATE OR REPLACE FUNCTION search.feeds_search_trg() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.title       IS NOT DISTINCT FROM OLD.title
     AND NEW.author      IS NOT DISTINCT FROM OLD.author
     AND NEW.description IS NOT DISTINCT FROM OLD.description
     AND NEW.search_tsv  IS NOT NULL
  THEN
    RETURN NEW;
  END IF;
  NEW.title_fold  := search.fold1(search.clean(NEW.title, 300));
  NEW.author_fold := search.fold1(search.clean(NEW.author, 200));
  NEW.search_tsv  := search.feed_tsv(NEW.title, NEW.author, NEW.description);
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS feeds_search_biu ON feeds;
CREATE TRIGGER feeds_search_biu
  BEFORE INSERT OR UPDATE OF title, author, description ON feeds
  FOR EACH ROW EXECUTE FUNCTION search.feeds_search_trg();
`;

// Columns are added without defaults so the ALTER is metadata-only and instant
// even at 1.65M rows. A GENERATED ALWAYS ... STORED column would force a full
// table rewrite under ACCESS EXCLUSIVE (minutes of total lockout on the busiest
// table) AND could not be recomputed when a fold rule changes without dropping
// and re-adding the column — another rewrite. Trigger + plain column avoids both.
export const SQL_COLUMNS = `
ALTER TABLE episodes
  ADD COLUMN IF NOT EXISTS title_fold text,
  ADD COLUMN IF NOT EXISTS search_tsv tsvector,
  ADD COLUMN IF NOT EXISTS popularity integer NOT NULL DEFAULT 0;

ALTER TABLE feeds
  ADD COLUMN IF NOT EXISTS title_fold    text,
  ADD COLUMN IF NOT EXISTS author_fold   text,
  ADD COLUMN IF NOT EXISTS search_tsv    tsvector,
  ADD COLUMN IF NOT EXISTS popularity    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS episode_count integer NOT NULL DEFAULT 0;
`;

export const ALL_FUNCTION_SQL = [
  SQL_CLEAN,
  SQL_FOLD1,
  SQL_SKEL,
  SQL_SKELETON,
  SQL_TSV,
];
