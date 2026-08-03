import { db } from "../db";
import { sql } from "drizzle-orm";

// Creates the contributor tables with idempotent DDL at startup.
//
// Why not rely on `drizzle-kit push`: it runs at BUILD time, non-interactively,
// and treats anything in the database it doesn't recognise as a drop candidate.
// The tables are declared in shared/schema.ts too — but only so drizzle gives
// typed queries and $inferSelect. Creating them here means the feature does not
// depend on how push behaves in a non-TTY build.
//
// server/search/bootstrap.ts is the deployed precedent for exactly this, and
// ensureColumns() in server/index.ts is the older one. Safe to re-run on every
// boot: every statement is IF NOT EXISTS.

const DDL = `
CREATE TABLE IF NOT EXISTS contributor_applications (
  id                    varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  email                 text NOT NULL,
  phone                 text,
  organization          text,
  proposed_title        text NOT NULL,
  proposed_description  text NOT NULL,
  language              text NOT NULL DEFAULT 'en',
  bio                   text,
  sample_audio_key      text,
  sample_audio_url      text,
  status                text NOT NULL DEFAULT 'pending',
  review_notes          text,
  reviewed_at           timestamp,
  reviewed_by           text,
  contributor_id        varchar,
  ip_address            text,
  user_agent            text,
  created_at            timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contributor_applications_status_idx
  ON contributor_applications (status, created_at);
CREATE INDEX IF NOT EXISTS contributor_applications_email_idx
  ON contributor_applications (email);

CREATE TABLE IF NOT EXISTS contributors (
  id             varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name   text NOT NULL,
  contact_email  text NOT NULL UNIQUE,
  password_hash  text,
  status         text NOT NULL DEFAULT 'active',
  application_id varchar REFERENCES contributor_applications(id) ON DELETE SET NULL,
  last_login_at  timestamp,
  created_at     timestamp NOT NULL DEFAULT now()
);

-- Only the SHA-256 of a token is stored, so a database leak cannot be replayed
-- as a live session. Deliberately unlike admin auth, whose "token" is
-- base64(user:pass) held in localStorage indefinitely.
CREATE TABLE IF NOT EXISTS contributor_sessions (
  token_hash     text PRIMARY KEY,
  contributor_id varchar NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  purpose        text NOT NULL DEFAULT 'session',
  expires_at     timestamp NOT NULL,
  used_at        timestamp,
  created_at     timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contributor_sessions_contributor_idx
  ON contributor_sessions (contributor_id);
CREATE INDEX IF NOT EXISTS contributor_sessions_expires_idx
  ON contributor_sessions (expires_at);

CREATE TABLE IF NOT EXISTS contributor_shows (
  id                 varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  contributor_id     varchar NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  feed_id            varchar REFERENCES feeds(id) ON DELETE SET NULL,
  slug               text NOT NULL UNIQUE,
  title              text NOT NULL,
  description        text NOT NULL,
  language           text NOT NULL DEFAULT 'en',
  author             text NOT NULL,
  owner_name         text NOT NULL,
  owner_email        text NOT NULL,
  copyright          text,
  link               text,
  artwork_key        text,
  artwork_width      integer,
  artwork_height     integer,
  category_id        varchar REFERENCES categories(id),
  itunes_category    text NOT NULL DEFAULT 'Religion & Spirituality',
  itunes_subcategory text NOT NULL DEFAULT 'Judaism',
  itunes_type        text NOT NULL DEFAULT 'episodic',
  explicit           boolean NOT NULL DEFAULT false,
  review_required    boolean NOT NULL DEFAULT true,
  status             text NOT NULL DEFAULT 'draft',
  feed_xml           text,
  feed_etag          text,
  feed_built_at      timestamp,
  created_at         timestamp NOT NULL DEFAULT now(),
  updated_at         timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contributor_shows_contributor_idx
  ON contributor_shows (contributor_id);
CREATE INDEX IF NOT EXISTS contributor_shows_status_idx
  ON contributor_shows (status);

CREATE TABLE IF NOT EXISTS contributor_episodes (
  id                 varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id            varchar NOT NULL REFERENCES contributor_shows(id) ON DELETE CASCADE,
  -- Minted once by this default and never rewritten. If a guid changes, every
  -- subscriber re-downloads the shiur as a new episode.
  guid               varchar NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  title              text NOT NULL,
  description        text,
  audio_key          text,
  byte_size          integer,
  duration_seconds   integer,
  pub_date           timestamp,
  episode_number     integer,
  season_number      integer,
  artwork_key        text,
  explicit           boolean NOT NULL DEFAULT false,
  status             text NOT NULL DEFAULT 'draft',
  published_at       timestamp,
  series_name        text,
  masechta           text,
  daf                text,
  parsha             text,
  upload_key         text,
  upload_bytes       integer,
  media_status       text,
  media_error        text,
  media_attempts     integer NOT NULL DEFAULT 0,
  media_updated_at   timestamp,
  catalog_episode_id varchar REFERENCES episodes(id) ON DELETE SET NULL,
  reviewed_at        timestamp,
  reviewed_by        text,
  review_note        text,
  created_at         timestamp NOT NULL DEFAULT now(),
  updated_at         timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contributor_episodes_show_status_idx
  ON contributor_episodes (show_id, status, pub_date);
CREATE INDEX IF NOT EXISTS contributor_episodes_media_status_idx
  ON contributor_episodes (media_status);
CREATE INDEX IF NOT EXISTS contributor_episodes_scheduled_idx
  ON contributor_episodes (status, pub_date);

-- A join table rather than text[]: drizzle cannot bind a JS array to a text[]
-- parameter ("cannot cast type record to text[]"), and this gives a plain
-- btree for browse-by-topic.
CREATE TABLE IF NOT EXISTS contributor_episode_topics (
  episode_id varchar NOT NULL REFERENCES contributor_episodes(id) ON DELETE CASCADE,
  topic      text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS contributor_episode_topics_ep_topic_idx
  ON contributor_episode_topics (episode_id, topic);
CREATE INDEX IF NOT EXISTS contributor_episode_topics_topic_idx
  ON contributor_episode_topics (topic);

CREATE TABLE IF NOT EXISTS contributor_directory_submissions (
  id           varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id      varchar NOT NULL REFERENCES contributor_shows(id) ON DELETE CASCADE,
  platform     text NOT NULL,
  status       text NOT NULL DEFAULT 'not_submitted',
  submitted_at timestamp,
  show_url     text,
  note         text,
  updated_at   timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS contributor_directory_show_platform_idx
  ON contributor_directory_submissions (show_id, platform);
`;

const TABLES = [
  "contributor_applications",
  "contributors",
  "contributor_sessions",
  "contributor_shows",
  "contributor_episodes",
  "contributor_episode_topics",
  "contributor_directory_submissions",
];

export interface ContributorBootstrapResult {
  ok: boolean;
  missing: string[];
}

export async function bootstrapContributorSchema(): Promise<ContributorBootstrapResult> {
  // Advisory lock so two replicas can't race the DDL, matching the search
  // bootstrap. A different key so the two don't block each other.
  const lock: any = await db.execute(
    sql`SELECT pg_try_advisory_lock(hashtext('shiurpod.contributor.bootstrap')) AS got`,
  );
  if (!lock.rows?.[0]?.got) return { ok: true, missing: [] };

  try {
    await db.execute(sql.raw(DDL));

    // JSON rather than binding a JS array to text[] — that fails with
    // "cannot cast type record to text[]".
    const res: any = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (SELECT json_array_elements_text(${JSON.stringify(TABLES)}::json))
    `);
    const present = new Set((res.rows || []).map((r: any) => r.table_name));
    const missing = TABLES.filter((t) => !present.has(t));

    if (missing.length === 0) {
      console.log("Contributor: schema ready");
    } else {
      console.warn(`Contributor: schema INCOMPLETE — missing [${missing.join(", ")}]`);
    }
    return { ok: missing.length === 0, missing };
  } catch (e: any) {
    console.error(`Contributor bootstrap failed: ${e?.message?.slice(0, 200)}`);
    return { ok: false, missing: TABLES };
  } finally {
    await db
      .execute(sql`SELECT pg_advisory_unlock(hashtext('shiurpod.contributor.bootstrap'))`)
      .catch(() => {});
  }
}
