# Finishing the Contributor Program

Phases 1–3 are done: schema live in production (7 tables, 0 rows), R2 verified
(22/22 checks), feed generator written and tested (12 tests). What's missing is
every URL a human or a podcast app can actually hit.

This plan finishes Phases 4–6. Ordered so something real is verifiable at the end
of each step, not just at the end.

---

## Step 0 — Feed URL first (~30 min, do this before anything else)

The feed generator has no caller. Wiring one route turns three phases of untested
integration into something externally verifiable *today*.

1. `GET /feed/:slug.xml` in `server/index.ts` — serve `contributor_shows.feed_xml`
   with `ETag` + `Last-Modified`, `304` on match, `Content-Type: application/rss+xml`.
2. **Add `contribute`, `feed`, `creator` to `SEO_RESERVED`** (`server/index.ts:671`).
   This is the trap in the original plan and it is worse than documented: that set
   guards **two** catch-all routes (`:708` and `:760`), not one. Miss it and
   `/feed/x.xml` 404s via `GET /:speakerSlug` — the same symptom as "not built yet",
   for a completely different reason.
3. Seed one show + 2 episodes by hand in SQL, pointing at real R2 objects.
4. Run it through an external podcast validator (Podbase / Cast Feed Validator).

**Verifies:** the entire RSS half of the project, before a single line of UI.

---

## Step 1 — Phase 4: upload + transcode

Mirror the YouTube pair, which already solves this exact problem:
`server/youtube-media.ts` (371 lines) + `server/youtube-worker.ts` (118 lines) —
`FOR UPDATE SKIP LOCKED`, `running` guard, stall requeue, 4 attempts then terminal
`failed`.

**Dependencies to add:** `ffprobe-static` and `node-id3`. `ffmpeg-static` is already
installed; `ffprobe-static` is not, and duration is currently scraped out of ffmpeg
stderr, which is not good enough when `itunes:duration` has to be right.

`server/contributor-media.ts`:
- presigned PUT (server picks the key — never the client)
- ffprobe validate: real audio, sane duration, decodable
- ffmpeg → MP3 **48 kbps mono 44.1 kHz** (YouTube stays 64 kbps — two deliberate profiles)
- ID3v2 tags (title, artist, album, date)
- **HEAD the stored object for exact byte size** — enclosure length must come from
  storage, never from what the uploader claimed
- delete the raw upload; the original is never served and never kept

`server/contributor-worker.ts`: single concurrency, boot-time requeue, same tick
promotes `scheduled` → `published` and invalidates `feed_xml`.

**The 500 MB cap cannot be enforced on a presigned PUT** (only a POST policy can bind
`content-length-range`). Check client-side, then HEAD in the worker and reject +
delete anything oversized. Treat the client check as a courtesy, not a control.

**Verify:** upload a real 45-min shiur → `ready` → feed enclosure byte count matches
`headObject` exactly → plays over a Range request.

---

## Step 2 — Phase 5: the three surfaces

### 2a. Public application form `/contribute`
Server-rendered template, not an SPA route — keeps the creator surface structurally
unreachable from the mobile app rather than relying on route discipline.

Four wiring steps in `server/index.ts`, none optional:
- `sendFile` route
- `SEO_RESERVED` (already done in Step 0)
- pass-through list (~`:408`)
- `writeLimiter` (`:1545`)

**This is the first real anti-spam in the codebase.** Rate limit + honeypot + length
caps. Nothing currently protects a public write endpoint.

### 2b. Admin review queue
Three-edit pattern in `server/templates/admin.html` (6,796 lines, 22 `switchTab`
refs): nav button with badge like `#ytPendingBadge`, a `#contributorsTab` div, one
line in `switchTab()`. Sample audio inline — approving a rav without hearing him is
the whole point of the queue.

### 2c. Creator dashboard `/creator` + auth
`server/contributor-auth.ts`: opaque `randomBytes(32)`, store **SHA-256 only**,
`Bearer` scheme. Copy `portalAuth` (`server/routes-v1.ts:46`) — **not** `adminAuth`,
whose token is `base64(user:pass)` held in `localStorage` in a file that renders via
`innerHTML`.

`/api/contrib/login` must be explicitly rate-limited and **must not** sit under any
limiter `skip` prefix. `server/index.ts:1543` skips `/api/admin/*` and carves out
`/api/admin/login` by hand — that carve-out is exactly the shape of bug to not repeat.

Drag-drop upload copies the XHR uploader at `admin.html:4086` (the `api()` helper is
JSON-only and can't do progress).

---

## Step 3 — Phase 6: catalog integration + moderation

On publish: write a `cp://show/{showId}` feed row + episodes with `guid = cp-{id}`.
On unpublish/suspend: remove from the catalog directly.

**`cp://` must mirror every `yt://` scheme site — there are 30 references across 6
files** (`routes.ts`, `storage.ts`, `episode-dedup.ts`, `index.ts`, `youtube.ts`,
plus schema). Most collapse into two canonical arrays:

```
server/storage.ts        ["yt://", "alldaf://", "allmishnah://", "allparsha://", "allhalacha://"]
server/episode-dedup.ts  ["yt://", "alldaf://", "allmishnah://", "allparsha://", "allhalacha://"]
```

Miss one and a contributor feed gets fetched over HTTP as RSS by the refresh loop.

Two standing constraints:
- **Never write trigger-owned columns** (`title_fold`, `search_tsv`, `popularity`) on
  catalog inserts — the search triggers own those.
- `feeds.episode_count` is maintained by the popularity job; direct writes must not
  leave it stale.

Directory submission stays manual, with a per-platform checklist and a feed
validation gate before submission.

---

## Verification (the whole thing)

- Seeded feed passes an external validator **before** any real submission
- Publish → appears in app; unpublish → gone from feed **and** catalog
- `search_tsv` populated for a contributor episode (i.e. actually findable)
- **Confirm the mobile app has no route to `/creator` or `/contribute`** — verify, don't assume
- Range request on a contributor MP3 returns 206

## Known risks

1. `cp://` touches 30 sites — grep and mirror every one
2. Trigger-owned columns on catalog inserts
3. `text[]` cannot bind through drizzle ("cannot cast type record to text[]", hit 3×) — hence the topics join table
4. `drizzle-kit push` drops undeclared indexes on every deploy; contributor bootstrap must self-repair like `server/search/bootstrap.ts` does
5. `audio.shiurpod.com` is cross-origin for the player — the offline downloader needs checking
6. R2 free tier is 10 GB — check `/data` usage before planning the YouTube migration

## Still outstanding (operator)

- **Cloudflare cache rule** for `audio.shiurpod.com` (Cache Everything, 30d edge TTL) — my token has `zone (read)` only
- **Email routing** catch-all `show-*@shiurpod.com` → operator inbox. Apple/Spotify send the directory claim code there; without it, submission cannot complete.

---

## Status — all phases complete

| Phase | State | Proof |
|---|---|---|
| 1. Schema | ✅ live | 7 tables in production |
| 2. R2 | ✅ live | `verify-r2.ts` — 22/22 |
| 3. Feed generation | ✅ live | `test-contributor-feed.ts` — 12/12 |
| Step 0. Feed URL | ✅ live | `/feed/{slug}.xml` serving, 304 on If-None-Match |
| 4. Upload + transcode | ✅ live | `verify-contributor-media.ts` — 17/17 |
| 5. Three surfaces | ✅ live | `/contribute`, `/creator`, admin tab all 200 |
| 6. `cp://` catalog | ✅ live | `verify-contributor-e2e.ts` — 30/30 |

### What the audit found that the plan did not predict

1. **Three additional `parseFeed` gates**, not one. `routes.ts:286`, `:760` and
   `:853` each gated a real fetch and would have pulled `cp://show/{id}` over
   HTTP as RSS. Fixed by replacing the inlined scheme lists with
   `isCustomSchemeUrl()` from the new `server/feed-schemes.ts`.
2. **`episodes.duration` is TEXT `"HH:MM:SS"`, not seconds.** Verified against
   production rows. Writing an integer would have shown a wrong duration on
   every contributor episode in the app.
3. **A double-wrapped ETag** shipped in the first feed-route commit
   (`W/"W/"..."" `). No client could match it, so every conditional GET fell
   through to a full 200. Caught by testing the header rather than the status
   code.

### Still outstanding (operator only)

- **Cloudflare cache rule** for `audio.shiurpod.com` — Cache Everything, 30-day
  edge TTL. Performance only.
- **Email routing** catch-all `show-*@shiurpod.com` → operator inbox. Apple and
  Spotify send the directory claim code there; submission cannot complete
  without it.
- **No outbound mail to contributors.** Approval returns a one-time setup link
  that the admin must send by hand. Wiring Resend (already a dependency) would
  close this.
