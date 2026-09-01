# Changelog

All notable changes to ShiurPod are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); this project has never been
git-tagged, so history before this file starts is in `git log` rather than
reconstructed into version sections here. The app version lives in
`app.json` (currently 2.0.0).

## [Unreleased]

### Fixed

- Episodes stored with an `http://` audio URL play instead of failing. Android
  has refused cleartext HTTP since targetSdk 28 and our manifest does not opt
  back in, so those episodes never left the phone — 1,600 of them across 11
  feeds, including 157 of the 353 Rabbi Orlofsky Show episodes and 452 of
  R' Aryeh Lebowitz's. Every one of those hosts serves the identical path over
  TLS. URLs are now normalised at ingest, existing rows are fixed by
  `scripts/fix-cleartext-audio-urls.ts`, and the same rewrite ships to
  installed apps through `/api/config` so a device repairs a stale URL itself.
  Also covers S3 buckets whose name contains a dot, which cannot be reached
  over TLS at all in virtual-hosted form and now use the path-style URL.
- Episodes the publisher has retired are removed instead of sitting in the show
  failing for everyone who taps them. Ingest only ever adds, so an episode
  deleted at the source kept its place forever: "R' Yoshe Ber: A Talmid's
  Perspective - Part 2 (Ep. 342)" of The Rabbi Orlofsky Show was 404 at the
  origin and gone from the publisher's feed, yet stayed second from the top of
  the show and failed 44 times across 17 devices in a month. A daily sweep now
  removes an episode only when playback telemetry flagged it, the origin
  answers 404/410 twice, and it is absent from a fresh parse of the feed —
  with per-feed and per-sweep caps, and every verdict recorded in
  `episode_health`.
- Android Auto browse lists return in seconds instead of stalling. Artwork was
  downloaded and decoded inline, one image at a time, inside the loop that
  built each list: a nine-item category took 24 seconds and a fifteen-item
  feed never returned at all, leaving the car on "Getting your selection..."
  Images are now fetched in parallel with a 2.5s budget, on their own thread
  pool, and anything slower fills in on the next browse. Measured in a head
  unit: 24.4s to 3.4s, and the feed list that never finished now takes 2.0s.
- Android Auto plays shiurim chosen more than 30 seconds after opening the
  app. The media session was built with a player the code treated as a
  disposable placeholder and released on a 30-second timer — but nothing else
  ever replaced it in a car, so the session was left holding a released
  player and every later tap hung forever. Browsing for half a minute before
  picking something is normal, so this failed for essentially every real use.
- Empty lists in Android Auto no longer look like errors. Rows with no artwork
  get Android Auto's alert-triangle icon, so "nothing here yet" rendered as a
  failed screen. Empty states now carry the ShiurPod logo and say what they
  mean — "No saved shiurim", "Nothing played yet" — with a line explaining
  how to fill them.

### Changed

- Gradle builds get enough Metaspace to lint React Native. `lintVitalRelease`
  runs on every release build and died with an OutOfMemoryError at Expo's
  default 512m, taking the whole build with it.

- Android Auto shows content again instead of "Error loading". Some episodes
  carry `"imageUrl": null`, and Android's `org.json` hands back the literal
  string `"null"` for an explicit JSON null, so the Auto service tried to
  fetch `URL("null")`. The handler for that failure then wrote a null into a
  `ConcurrentHashMap`, which forbids null values — throwing a second
  exception out of the `catch` block, past the artwork code, and into the
  list builder, which replaced the entire list with an error item. One
  episode missing a thumbnail blanked a whole browse screen. Artwork is now
  decoration that cannot fail a list, and the cache's documented 200-entry
  bound is actually enforced.

- Android Auto plays Kol Halashon shiurim instead of erroring on them. The
  Auto service handed ExoPlayer the stored `audioUrl` as-is, while every
  other player rewrites vendor URLs onto our own proxy first — and Kol
  Halashon, 74% of the catalogue, answers 403 to anyone but that proxy. So
  roughly three of every four shiurim failed to play in a car. Google Play
  rejected version code 9 for this in August 2026 ("all the tracks returned
  error") and version code 2 in April 2026. The service now applies the same
  rewrite rules the app uses, read from `/api/config` so a future vendor
  change won't need another store submission.

- Admin analytics no longer counts drive-by web visitors as users. The web
  build mints a fresh device id per browser and registers it on load, so
  crawlers and proxy traffic were arriving as "users" — about 1,600 of them
  on 12–13 Aug 2026 in twelve hours, which is what made the device-model
  chart read ~1,600 "Unknown". A device now counts once it is an app install
  (Android/iOS) or a web device that came back at least a day later. Applied
  to every device- and listen-derived number so the dashboard stays
  consistent: total devices 2,329 → 681, 30-day actives 1,737 → 231,
  listens 15,597 → 14,056. The app's trending shelf uses the same rule, so a
  flood of one-shot visitors can't vote an episode onto it.
- Visitor IP addresses are read from Cloudflare's `CF-Connecting-IP` header
  instead of `X-Forwarded-For`. Railway's edge rewrites XFF to the peer it
  sees, so every request was recorded with a Cloudflare edge address: the
  geo lookup returned whichever Cloudflare colo the visitor reached rather
  than their location, and the 200-req/min rate limiter put every visitor
  behind a colo in a single bucket.
