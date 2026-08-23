# Changelog

All notable changes to ShiurPod are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); this project has never been
git-tagged, so history before this file starts is in `git log` rather than
reconstructed into version sections here. The app version lives in
`app.json` (currently 2.0.0).

## [Unreleased]

### Fixed

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
