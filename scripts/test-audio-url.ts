// normalizeAudioUrl decides what URL a phone is handed for every episode in
// the catalogue, so its blast radius is the whole app.
//
//   npx tsx --test scripts/test-audio-url.ts
//
// Two failure modes are worth guarding against. Rewriting too little leaves
// http:// URLs stored, which Android refuses outright — that is the bug this
// was written for: 1,600 episodes, including 157 of the 353 Rabbi Orlofsky
// Show episodes, unplayable on device. Rewriting too much is worse, because it
// would break URLs that work today, so every case below that must pass through
// untouched is asserted byte-for-byte.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAudioUrl, needsAudioUrlNormalization } from "../server/audio-url";

test("upgrades cleartext to TLS, path untouched", () => {
  // A real stored URL, and one Android will not even attempt. Note the %20,
  // the parentheses and the apostrophe: the path must survive verbatim, since
  // Backblaze 404s on any re-encoding of it.
  assert.equal(
    normalizeAudioUrl(
      "http://media.blubrry.com/rabbi_orlofsky_show/f000.backblazeb2.com/file/rabbi-orlofsky-show/episodes/Nissan-%20Stayin'%20Alive%20(Ep.%20167).mp3",
    ),
    "https://media.blubrry.com/rabbi_orlofsky_show/f000.backblazeb2.com/file/rabbi-orlofsky-show/episodes/Nissan-%20Stayin'%20Alive%20(Ep.%20167).mp3",
  );
  assert.equal(
    normalizeAudioUrl("http://download.yutorah.org/2024/1053/1013268.MP3"),
    "https://download.yutorah.org/2024/1053/1013268.MP3",
  );
});

test("query strings and ports survive the upgrade", () => {
  assert.equal(
    normalizeAudioUrl("http://example.com:8080/a/b.mp3?token=1&x=2#t=30"),
    "https://example.com:8080/a/b.mp3?token=1&x=2#t=30",
  );
});

test("a dotted S3 bucket goes path-style, not just https", () => {
  // Virtual-hosted TLS fails the handshake here — the wildcard cert on
  // *.s3.amazonaws.com does not cover a host with more dots to its left — so a
  // plain scheme upgrade would swap a blocked request for a TLS error.
  assert.equal(
    normalizeAudioUrl("http://mishnaaudio.joelpadowitz.com.s3.amazonaws.com/sukkah/sukkah3-10.mp3"),
    "https://s3.amazonaws.com/mishnaaudio.joelpadowitz.com/sukkah/sukkah3-10.mp3",
  );
  // Already https and still broken for the same reason.
  assert.equal(
    normalizeAudioUrl("https://my.dotted.bucket.s3.amazonaws.com/k/e.mp3"),
    "https://s3.amazonaws.com/my.dotted.bucket/k/e.mp3",
  );
  // Regional endpoints keep their region.
  assert.equal(
    normalizeAudioUrl("http://my.bucket.s3.us-east-1.amazonaws.com/k/e.mp3"),
    "https://s3.us-east-1.amazonaws.com/my.bucket/k/e.mp3",
  );
});

test("an undotted S3 bucket is only scheme-upgraded", () => {
  // The wildcard cert covers this one, so virtual-hosted style is fine and
  // rewriting the hostname would be a gratuitous change.
  assert.equal(
    normalizeAudioUrl("http://jewishpodcasts-prod.s3.amazonaws.com/a/b.mp3"),
    "https://jewishpodcasts-prod.s3.amazonaws.com/a/b.mp3",
  );
});

test("leaves alone everything that already works", () => {
  const untouched = [
    "https://traffic.libsyn.com/secure/show/episode.mp3",
    "https://srv.kolhalashon.com/api/files/GetMp3FileToPlay/42165267",
    "yt://audio/dQw4w9WgXcQ",
    "/api/media/yt/dQw4w9WgXcQ.mp3",
    "tat://lecture/123",
    "cp://show/abc",
  ];
  for (const url of untouched) {
    assert.equal(normalizeAudioUrl(url), url, url);
    assert.equal(needsAudioUrlNormalization(url), false, url);
  }
});

test("is idempotent — a second pass changes nothing", () => {
  const inputs = [
    "http://media.blubrry.com/x/y.mp3",
    "http://mishnaaudio.joelpadowitz.com.s3.amazonaws.com/sukkah/sukkah3-10.mp3",
    "https://traffic.libsyn.com/secure/show/episode.mp3",
  ];
  for (const url of inputs) {
    const once = normalizeAudioUrl(url);
    assert.equal(normalizeAudioUrl(once), once, url);
    assert.equal(needsAudioUrlNormalization(once), false, once);
  }
});

test("handles empty and whitespace-only input without throwing", () => {
  assert.equal(normalizeAudioUrl(""), "");
  assert.equal(normalizeAudioUrl("   "), "");
});

test("does not mistake an http:// substring for a scheme", () => {
  // Blubrry embeds the origin URL in the path, sometimes with its own scheme.
  // Only the leading scheme may be rewritten; the inner one is part of the
  // path and changing it would produce a URL Blubrry does not serve.
  assert.equal(
    normalizeAudioUrl("https://media.blubrry.com/3131462/http://f000.backblazeb2.com/file/x.mp3"),
    "https://media.blubrry.com/3131462/http://f000.backblazeb2.com/file/x.mp3",
  );
});
