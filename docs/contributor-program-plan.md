# Contributor Program & Self-Hosted RSS — Implementation Plan

## Context

ShiurPod aggregates other platforms' feeds. This lets a rav publish *through* us: he
applies, is approved, uploads shiurim in a dashboard, and we generate a spec-compliant
podcast feed. That feed is submitted once to Apple/Spotify so his shiurim reach every
podcast app, and it also appears in ShiurPod's own catalog.

Audio is self-hosted on Cloudflare R2 — not a third-party podcast host.

Three surfaces: a public application form, an admin review queue, and a creator
dashboard behind login.

**Source spec:** `~/Downloads/shiurpod-contributor-rss-spec.md`.
The spec's own instruction is *"work in reviewable chunks — schema first, then feed
generation with seeded data, then upload pipeline, then the UI. Don't build it all in
one pass."* This plan follows that.

---

## Decisions

The spec left several things open. These are the calls I'm making, with reasoning.
The three marked ⚠️ change the shape of the work and are worth confirming before I start.

### ⚠️ 1. Catalog integration: direct write, not RSS self-ingestion

The spec asks that contributor feeds flow through the existing RSS path, then adds:
*"if a direct write to the catalog tables is meaningfully simpler, propose that and
explain the tradeoff."*

**One requirement makes self-ingestion impossible.** The spec requires that unpublishing
an episode removes it *"from the feed **and our catalog**."* Removing an item from an RSS
feed is invisible to a pull-based ingester — nothing tells the catalog to delete. Three
more problems compound it:

| Problem | Cause |
|---|---|
| Edits never propagate | `upsertEpisodes` is insert-only — no `onConflictDoUpdate` exists anywhere in the codebase |
| Up to 30 min publish latency | `STALE_INTERVALS.rss` (`server/index.ts:1037`) |
| Our CDATA HTML is destroyed | `parseFeed` runs descriptions through `stripHtml` (`server/rss.ts:319`) |
| Pushes silently suppressed | `PUSH_BACKFILL_THRESHOLD = 5` (`server/push.ts:171`) |

**This is not special-casing** — it's the pattern already used for self-hosted media.
The `feeds` row gets `rssUrl = 'cp://show/{showId}'`, which `refreshOneFeed` early-returns
on (`server/index.ts:945`), exactly as `yt://` does. On publish we insert into `episodes`
with `guid = 'cp-{showEpisodeId}'`, mirroring `createEpisodeForStoredYouTubeMedia`.

It also composes correctly with the now-live search triggers: a direct insert fires
`BEFORE INSERT`, so contributor episodes get `title_fold`/`search_tsv` computed and are
searchable for free. An edit fires `BEFORE UPDATE` and recomputes — precisely what RSS
ingestion *cannot* do.

**Cost, honestly:** `cp://` must be added to ~8 scheme-checking sites (`server/feed-utils.ts`,
`getFeedType`, `refreshOneFeed`, `isApiOnlyUrl`, `isMergedFeed`, plus ad-hoc lists in
`routes.ts`). Bounded, and no adapter is needed — the only behaviour required is "skip RSS."

**Never do both.** Registering the `https://` feed *and* writing directly would race two
rows for the same content under different GUIDs.

### ⚠️ 2. Creator dashboard is a server-rendered template, not an SPA route

There is no `Linking.openURL` and no WebView anywhere in `app/`, `components/` or `lib/` —
a deliberate kosher-firmware property. Putting the dashboard in the `/app` SPA risks that
constraint and ships creator code into the mobile bundle. A server-rendered
`server/templates/creator.html` keeps it structurally unreachable from the app rather than
relying on route discipline.

### ⚠️ 3. Table naming: `contributor_shows`, not `shows`

`shows` is very generic for the `public` schema alongside `feeds`/`episodes`. Renaming later
is expensive; deciding now is free.

### Smaller calls

| # | Decision | Why |
|---|---|---|
| 4 | Topics in a **join table**, not `text[]` | Binding a JS array to `text[]` via drizzle fails with *"cannot cast type record to text[]"* — hit three times this session. A join table also gives indexed browse-by-topic, which the spec wants. |
| 5 | Add **`ffprobe-static`** | `ffmpeg-static` ships no ffprobe; duration is currently scraped from ffmpeg stderr, which yields whole seconds and no format detail. The spec needs real validation ("reject anything that isn't valid audio") and exact duration. New dependency — flagging. |
| 6 | Tests via **`node:test` + tsx** | Zero new dependencies; matches the existing `scripts/*.ts` convention. There is no test runner today. |
| 7 | **48 kbps mono 44.1 kHz** for contributor audio | Per spec. YouTube's pipeline stays at 64 kbps — two deliberate profiles, not an accident. |
| 8 | **Defer download analytics** | Genuinely hard: if the server never streams and R2 serves via custom domain, we have no request visibility. Cloudflare per-object logs are Enterprise. Ship show-level aggregates; revisit with a Worker if it matters. |
| 9 | **YouTube→R2 migration is a separate follow-on** | Build R2 once for contributors, prove it, then migrate. Migrating first means building the plumbing twice. |
| 10 | Search columns declared in `shared/schema.ts` | **Already done** (`855e143`) — they were undeclared and at risk of being dropped by `drizzle-kit push`. |
| 11 | `show-*@shiurpod.com` inbound catch-all | **Operator task.** Cloudflare Email Routing, since Cloudflare already fronts the domain. Blocks directory submission, not development. |

---

## Phase 0 — Cloudflare setup (operator)

These are yours; everything else is automated. Deliverable from me: `scripts/setup-r2.md`
restating this, and `scripts/verify-r2.ts` to prove it works.

1. **Bucket** `shiurpod-audio`, location hint **North America East**.
2. **Scoped API token** — R2 → Manage API Tokens → Object Read & Write, **restricted to this
   one bucket**. Not account-wide. Save Access Key ID, Secret Access Key, Account ID.
3. **Custom domain** `audio.shiurpod.com` (Settings → Public Access → Custom Domains).
   **Leave the `r2.dev` dev URL disabled.** Every enclosure URL in every published feed points
   here forever; if storage ever moves we repoint DNS and existing feeds keep working.
4. **Cache rule** for `audio.shiurpod.com`: Cache Everything, Edge TTL 30 days.
5. **Email Routing**: catch-all `show-*@shiurpod.com` → your inbox. This is where Apple and
   Spotify send directory claim codes.

Then hand me the three credentials **as a file path** (like the cookies) so they stay out of
the transcript. I'll set them as Railway variables without printing them:
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL`.

**Bucket CORS** (I'll apply via Wrangler). The spec's suggested origins are wrong for this
repo — real local origins are Express on **5000** and Metro on **8081**, not 3000:

```json
[{ "AllowedOrigins": ["https://shiurpod.com", "http://localhost:5000", "http://localhost:8081"],
   "AllowedMethods": ["PUT", "GET", "HEAD"],
   "AllowedHeaders": ["Content-Type", "Content-Length"],
   "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
```

---

## Phase 1 — Schema

Seven tables appended to `shared/schema.ts`, created by an idempotent
`server/contributor/bootstrap.ts` called right after `bootstrapSearch()` in `server/index.ts`.

**Why bootstrap rather than relying on `drizzle-kit push`:** push runs at build time and
treats undeclared objects as drop candidates. `server/search/bootstrap.ts` is a working,
deployed precedent for idempotent startup DDL. Tables are declared in `shared/schema.ts` too,
purely for typed queries — push then finds them present and does nothing.

| Table | Purpose |
|---|---|
| `contributor_applications` | public form submissions; status pending/approved/rejected |
| `contributors` | the rav's account; bcrypt `password_hash`, real contact email |
| `contributor_sessions` | opaque bearer tokens — **SHA-256 only**, never the token itself |
| `contributor_shows` | one podcast; `slug` immutable once live; cached `feed_xml` |
| `contributor_episodes` | `guid` UUID minted by DB default and never rewritten; transcode job columns |
| `contributor_episode_topics` | free-form tags, join table |
| `contributor_directory_submissions` | per-platform claim tracking |

**Two constraints that must hold:**

- **No new columns on `episodes` or `feeds`.** The search triggers own
  `title_fold`/`search_tsv`/`popularity` there. The only link into the catalog is
  `contributor_episodes.catalog_episode_id`.
- **Never write the trigger-owned columns explicitly** when inserting catalog rows — let the
  trigger compute them.

Fields the spec calls out specifically:

- `owner_email` is **always** `show-{slug}@shiurpod.com`, never the rav's address — it's
  where Apple/Spotify send the claim code, and the operator needs to receive it.
- `byte_size` from an **R2 HEAD after upload**, never estimated. Apple rejects feeds on this.
- `review_required` **defaults true** for new contributors.
- Torah metadata (`series_name`, `masechta`, `daf`, `parsha`) optional and additive; not in
  the RSS, surfaced in our UI.

---

## Phase 2 — R2 client

`server/r2.ts` is the **only** module importing `@aws-sdk/client-s3`:
`presignUpload` · `putObject` · `deleteObject` · `headObject` · `publicUrl`.
That single-module rule is what makes swapping storage later a one-file change.

Config: `region: "auto"`, `endpoint: https://{ACCOUNT_ID}.r2.cloudflarestorage.com`,
`forcePathStyle: true`. Key layout:

```
audio/{showId}/{episodeId}.mp3
artwork/show/{showId}.jpg
artwork/episode/{episodeId}.jpg
```

Rules: presigned PUTs expire in 1 hour, are generated server-side only, and are **scoped to a
key the server chooses — the client never picks its own key**. Deleting an episode deletes the
object. Content-Type set correctly on write.

`scripts/verify-r2.ts` proves it end to end: put an object → fetch through the custom domain →
presign a PUT and upload from another origin → **confirm a Range request returns 206** → clean
up. Range matters because podcast clients seek constantly.

**Known gap:** the spec's 500 MB cap **cannot** be enforced on a presigned PUT — only a POST
policy can bind `content-length-range`. Practical answer: check client-side, then HEAD in the
worker and reject + delete anything oversized. Nobody should assume a cap that isn't there.

---

## Phase 3 — Feed generation

`server/contributor-feed.ts`, hand-written per the spec (*"I want to be able to read and fix
it"*): `xmlEscape()`, `cdata()`, `rfc2822()`, `renderShowFeed()`, `validateFeed()`.

Route `GET /feed/:slug.xml`, `application/rss+xml; charset=utf-8`, ETag + Last-Modified,
served from the cached `feed_xml` column and invalidated on publish. Cached in the row rather
than memory so it survives restarts and a second replica.

**The five rules that break feeds if wrong:**

1. `enclosure length` is the **exact byte count**. Apple rejects feeds over this.
2. `guid isPermaLink="false"`, permanent and independent of the URL. If it changes, every
   subscriber re-downloads the episode as new.
3. Only `published` episodes, newest first; **scheduled stay out until `pub_date` passes**.
4. `pubDate` in RFC 2822.
5. UTF-8 throughout — **Hebrew and Yiddish titles must round-trip**.

Namespaces: `itunes`, `atom`, `content`, `podcast`. Channel needs `atom:link rel="self"`,
`itunes:image`, `itunes:category` (Religion & Spirituality → Judaism), `itunes:owner`,
`itunes:type`.

**Artwork validated at upload** — square, JPEG/PNG, RGB, 1400×1400 to 3000×3000. New code using
the existing `sharp` dependency. Do **not** extend `imageResizeHandler` — it forces square via
`fit: "cover"` rather than validating, and caps at 1024. For display derivatives, point at the
existing `/api/images/resize` instead of generating them.

**Tests** (`node:test` + tsx), the five the spec requires: feed XML validity; exact enclosure
byte length; GUID stability across edits; Hebrew/Yiddish encoding; correct exclusion of
unpublished and scheduled episodes.

---

## Phase 4 — Upload & transcode

`server/contributor-media.ts` + `server/contributor-worker.ts`, mirroring
`youtube-media.ts` / `youtube-worker.ts` — same `FOR UPDATE SKIP LOCKED` claim, `running`
guard, stall requeue, 4 attempts then terminal `failed`.

Pipeline: presigned PUT → `ffprobe` validate → `ffmpeg` to **MP3 48 kbps mono 44.1 kHz** →
ID3v2 tags (title, artist, album, year, cover) → **HEAD for exact byte size** → upload → discard
original → mark `ready`.

Failures must be **visible** — the creator sees `processing`/`ready`/`failed` with a reason,
not a silent hang.

The same tick handles `scheduled` → `published`, which is time-based and has no triggering
event.

---

## Phase 5 — The three surfaces

**Public form** — `/contribute`, server-rendered template. Four wiring steps in
`server/index.ts`, none optional: register the `sendFile` route; **add `contribute` (and `feed`,
`creator`) to `SEO_RESERVED` (`:668`)** or the greedy `GET /:speakerSlug` catch-all swallows it;
add to the pass-through list at `:408`; add `POST /api/contribute` to `writeLimiter`.

**This means writing the first real anti-spam in the codebase.** `POST /api/contact` today has
no length caps, no email validation, no honeypot. Minimum here: rate limit + honeypot +
server-side length caps.

**Admin queue** — a new tab in `admin.html` via the established three-edit pattern (nav button
with a pending badge like `#ytPendingBadge`, a `#contributorsTab` div, one line in
`switchTab()`). Sample audio playable inline. Approval creates the contributor, an empty show,
sends a setup email, and flags the show for directory submission.

**Creator dashboard** — `server/templates/creator.html`. Show settings, episode list with
status, drag-drop upload with progress (copy the XHR uploader at `admin.html:4086` — the `api()`
helper is JSON-only), metadata editing, scheduling, and the feed URL prominently with a copy
button.

**Auth** — `server/contributor-auth.ts`. Opaque tokens (`crypto.randomBytes(32)`), store only
`sha256`, `Authorization: Bearer`. Copy `portalAuth` (`routes-v1.ts:44-67`), not `adminAuth`.

Two hard rules:
- **Do not copy `POST /api/admin/login`.** It returns `base64(user:pass)` as the token, held
  indefinitely in `localStorage` in a 6,620-line file that renders via `innerHTML`. Any XSS
  there yields plaintext credentials. Tolerable for one operator; not for external rabbanim.
- **Privilege separation**: creators edit their own show with Bearer; only admin Basic can
  suspend a show or flip `review_required`. Precedent at `routes-v1.ts:342-345`, where
  `ota/promote` rejects Bearer for its one destructive operation.
- `/api/contrib/login` **must** be explicitly rate-limited and must not sit under any prefix a
  limiter `skip` covers — that's exactly how `/api/admin/login` ended up unthrottled.

---

## Phase 6 — Catalog integration & moderation

On publish: create/reuse the `cp://show/{showId}` feed row, insert the episode with
`guid = cp-{id}`, artwork and R2 URL. On unpublish or suspend: remove from the catalog directly.

Moderation per spec: `review_required` per show (default on), an admin view of everything queued
across all shows, and unpublish/suspend that takes effect in the feed **and** the catalog.

Contributor shows are visually identifiable in the app — **derived from `contributor_shows.feed_id`**,
not a column on the 1.65M-row `episodes` table.

**Directory submission is not automated** (Spotify has no publishing API). An admin checklist per
show tracks Apple, Spotify, Amazon and Podcast Index — submitted date, status, resulting URL —
plus a **feed validation check** so a feed can be confirmed ready before submitting.

---

## Verification

- `scripts/verify-r2.ts` — put/get/presign/Range 206/cleanup end to end
- Five feed tests via `node:test`, including real Hebrew strings
- A seeded show rendering a feed that passes an external podcast validator before any real
  submission
- Publish → episode appears in the app; unpublish → it disappears from both feed and catalog
- Confirm the search trigger populated `search_tsv` for a contributor episode, i.e. it's findable
- Confirm the mobile app has no route to `/creator` or `/contribute`

---

## Risks

1. **`cp://` touches ~8 scheme sites.** Miss one and a contributor feed gets treated as RSS and
   fetched over HTTP. Grep for `yt://` and mirror every hit.
2. **Never write trigger-owned columns** on catalog inserts.
3. **`text[]` binding fails through drizzle** — hence the join table. If any array column is added
   later, inserts must expand JSON server-side.
4. **`feeds.episode_count`** is maintained by the popularity refresh job; a `cp://` feed gaining
   episodes by direct write must not leave it stale.
5. **The creator surface must stay off the mobile app.** Verify, don't assume.
6. **R2 free tier is 10 GB.** Check current `/data` usage before planning the YouTube migration.
7. **`audio.shiurpod.com` is cross-origin for the player.** `lib/audio-url.ts` now absolutises
   relative URLs and passes absolute ones through, so it should be fine — but the offline
   downloader needs checking.
