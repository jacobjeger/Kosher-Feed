// Lexicon storage and the query builder.
//
// The lexicon is applied at QUERY time, never at index time. That decision is
// about staleness, not performance: expanding at index time would mean every
// new lexicon entry requires re-folding 1.65M episode rows. Since the lexicon
// will be edited continuously for months (driven by real zero-result queries),
// index-time expansion would turn every edit into a migration. Query-time
// expansion makes an edit take effect on the next search.
//
// build_query() is the single choke point where a raw user string becomes a
// tsquery. Folding, tokenising, lexicon expansion and skeletonisation all
// happen inside it, in SQL — so query-time normalisation is guaranteed to be
// byte-identical to what was indexed.

export const SQL_LEXICON_TABLE = `
CREATE TABLE IF NOT EXISTS search.lexicon (
  id         serial PRIMARY KEY,
  group_key  text NOT NULL,
  kind       text NOT NULL,
  surface    text NOT NULL,
  term_fold  text NOT NULL,
  display    text NOT NULL,
  enabled    boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS lexicon_uq   ON search.lexicon (term_fold, group_key);
CREATE INDEX        IF NOT EXISTS lexicon_term ON search.lexicon (term_fold) WHERE enabled;

-- term_fold is derived by the SAME fold as the corpus, by construction: the
-- seeder inserts raw surfaces and this trigger folds them. Never pre-fold in TS.
CREATE OR REPLACE FUNCTION search.lexicon_trg() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.term_fold := search.fold1(NEW.surface);
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS lexicon_biu ON search.lexicon;
CREATE TRIGGER lexicon_biu BEFORE INSERT OR UPDATE OF surface ON search.lexicon
  FOR EACH ROW EXECUTE FUNCTION search.lexicon_trg();
`;

// fold1 guarantees output contains only [0-9a-z], Hebrew letters and spaces, so
// a token can never carry a tsquery operator (& | ! ( ) : *). Quoting is still
// applied rather than relied upon being unnecessary — unquoted user input is
// both a crash source (to_tsquery throws on stray operators) and a DoS vector.
export const SQL_TSQ_LIT = `
CREATE OR REPLACE FUNCTION search.tsq_lit(tok text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT '''' || replace(tok, '''', '''''') || ''''
$fn$;
`;

// Returns three tsqueries:
//   strict_tsq  weights A|B  — folded tokens + lexicon alternates (incl. Hebrew)
//   fuzzy_tsq   weight  C    — transliteration skeletons
//   rank_tsq                 — union of both, used only for scoring
//
// BOTH tiers are always issued. Tiering by result count was considered and
// rejected: "batra" returns 929 strict hits, which already exceeds any page
// size, so a count-gated fallback would never fire and the user would never see
// the 42,592 "basra" results — defeating the entire point of the feature.
export const SQL_BUILD_QUERY = `
CREATE OR REPLACE FUNCTION search.build_query(raw text, allow_prefix boolean DEFAULT true)
RETURNS TABLE (q_fold text, strict_tsq tsquery, fuzzy_tsq tsquery, rank_tsq tsquery)
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  f      text   := search.fold1(search.clean(raw, 200));
  toks   text[];
  n      int;
  parts  text[] := '{}';
  skels  text[] := '{}';
  i      int;
  alts   text[];
  phrase text[];
BEGIN
  q_fold := f;
  IF f = '' THEN
    strict_tsq := NULL; fuzzy_tsq := NULL; rank_tsq := NULL;
    RETURN NEXT; RETURN;
  END IF;

  toks := string_to_array(f, ' ');
  n := coalesce(array_length(toks, 1), 0);

  -- Whole-query phrase lookup first. Multi-word surfaces ("bava basra",
  -- "chayei sara") are single lexicon rows, so a per-token lookup alone would
  -- miss them entirely.
  SELECT array_agg(DISTINCT l2.term_fold)
    INTO phrase
    FROM search.lexicon l1
    JOIN search.lexicon l2 USING (group_key)
   WHERE l1.term_fold = f AND l1.enabled AND l2.enabled;

  IF phrase IS NOT NULL AND cardinality(phrase) > 0 THEN
    -- Each alternate may itself be multi-word, so AND its tokens together and
    -- OR the alternates: (bava & basra) | (בבא & בתרא) | ...
    strict_tsq := to_tsquery('simple', array_to_string(ARRAY(
      SELECT '(' || array_to_string(ARRAY(
        SELECT search.tsq_lit(x) || ':AB'
        FROM unnest(string_to_array(alt, ' ')) x WHERE x <> ''
      ), ' & ') || ')'
      FROM unnest(phrase) alt
    ), ' | '));
  ELSE
    FOR i IN 1..n LOOP
      SELECT array_agg(DISTINCT l2.term_fold)
        INTO alts
        FROM search.lexicon l1
        JOIN search.lexicon l2 USING (group_key)
       WHERE l1.term_fold = toks[i] AND l1.enabled AND l2.enabled;
      alts := coalesce(alts, ARRAY[]::text[]);

      IF allow_prefix AND i = n AND length(toks[i]) >= 3 AND cardinality(alts) = 0 THEN
        -- Prefix wildcard on the trailing token only, for as-you-type.
        parts := parts || ('(' || search.tsq_lit(toks[i]) || ':*AB)');
      ELSE
        parts := parts || ('(' || array_to_string(ARRAY(
          SELECT '(' || array_to_string(ARRAY(
            SELECT search.tsq_lit(y) || ':AB'
            FROM unnest(string_to_array(x, ' ')) y WHERE y <> ''
          ), ' & ') || ')'
          FROM unnest(ARRAY[toks[i]] || alts) x
        ), ' | ') || ')');
      END IF;
    END LOOP;
    strict_tsq := to_tsquery('simple', array_to_string(parts, ' & '));
  END IF;

  -- Skeleton tier: this is what makes "batra" find "basra".
  FOR i IN 1..n LOOP
    IF search.skel_token(toks[i]) IS NOT NULL THEN
      skels := skels || (search.tsq_lit(search.skel_token(toks[i])) || ':C');
    END IF;
  END LOOP;

  fuzzy_tsq := CASE WHEN cardinality(skels) = 0 THEN NULL
                    ELSE to_tsquery('simple', array_to_string(skels, ' & ')) END;
  rank_tsq  := CASE WHEN fuzzy_tsq IS NULL THEN strict_tsq ELSE strict_tsq || fuzzy_tsq END;
  RETURN NEXT;
END $fn$;
`;

export const ALL_LEXICON_SQL = [SQL_LEXICON_TABLE, SQL_TSQ_LIT, SQL_BUILD_QUERY];
