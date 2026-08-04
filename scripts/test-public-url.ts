// The canonical public origin must never be a vendor hostname.
//
//   npx tsx --test scripts/test-public-url.ts
//
// This is a permanent-damage bug class, not a cosmetic one: feed and enclosure
// URLs live in subscribers' podcast apps for years. A railway.app hostname in a
// published feed cannot be taken back.
//
// It was live — EXPO_PUBLIC_API_URL on Railway is set to
// https://kosher-feed-production.up.railway.app, and the contributor feed
// resolved its base URL from it.

import { test } from "node:test";
import assert from "node:assert/strict";

const ENV_KEYS = ["PUBLIC_BASE_URL", "RAILWAY_PUBLIC_DOMAIN", "EXPO_PUBLIC_API_URL"] as const;

/**
 * Run `fn` with exactly `vars` set, and return ITS result.
 *
 * The assertions have to happen inside the callback: an earlier version of this
 * helper restored the environment in `finally` and then let the caller evaluate
 * afterwards, so every case silently tested the default. Three of them still
 * "passed" because the fallback happened to be the expected value — a test that
 * cannot fail is worse than no test.
 */
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: (mod: typeof import("../server/public-url")) => T | Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;

  const mod = await import("../server/public-url");
  try {
    return await fn(mod);
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("EXPO_PUBLIC_API_URL is ignored even when it is the only thing set", async () => {
  await withEnv({ EXPO_PUBLIC_API_URL: "https://kosher-feed-production.up.railway.app" }, (mod) => {
    const base = mod.canonicalBaseUrl();
    assert.ok(!base.includes("railway.app"), `leaked vendor host: ${base}`);
    assert.equal(base, "https://shiurpod.com");
  });
});

test("RAILWAY_PUBLIC_DOMAIN is used — Railway sets it to the custom domain", async () => {
  await withEnv({ RAILWAY_PUBLIC_DOMAIN: "shiurpod.com" }, (mod) =>
    assert.equal(mod.canonicalBaseUrl(), "https://shiurpod.com"));
});

test("a vendor host in RAILWAY_PUBLIC_DOMAIN falls back rather than leaking", async () => {
  await withEnv({ RAILWAY_PUBLIC_DOMAIN: "kosher-feed-production.up.railway.app" }, (mod) =>
    assert.equal(mod.canonicalBaseUrl(), "https://shiurpod.com"));
});

test("PUBLIC_BASE_URL wins when it is a real domain", async () => {
  await withEnv({ PUBLIC_BASE_URL: "https://example.org" }, (mod) =>
    assert.equal(mod.canonicalBaseUrl(), "https://example.org"));
});

test("PUBLIC_BASE_URL set to a vendor host is treated as a mistake, not an intent", async () => {
  await withEnv({ PUBLIC_BASE_URL: "https://foo.up.railway.app", RAILWAY_PUBLIC_DOMAIN: "shiurpod.com" }, (mod) =>
    assert.equal(mod.canonicalBaseUrl(), "https://shiurpod.com"));
});

test("trailing slashes are stripped so URLs never double up", async () => {
  await withEnv({ PUBLIC_BASE_URL: "https://example.org///" }, (mod) =>
    assert.equal(mod.canonicalBaseUrl(), "https://example.org"));
});

test("a value with no scheme is rejected", async () => {
  await withEnv({ PUBLIC_BASE_URL: "shiurpod.com" }, (mod) =>
    assert.equal(mod.canonicalBaseUrl(), "https://shiurpod.com"));
});

test("nothing configured still yields the real domain", async () => {
  await withEnv({}, (mod) =>
    assert.equal(mod.canonicalBaseUrl(), "https://shiurpod.com"));
});

test("isVendorHost catches the hosts that must never be persisted", async () => {
  await withEnv({}, (mod) => {
  for (const bad of [
    "https://kosher-feed-production.up.railway.app/feed/x.xml",
    "https://pub-abc123.r2.dev/audio/x.mp3",
    "http://localhost:5000/feed/x.xml",
    "https://something.vercel.app",
  ]) {
    assert.equal(mod.isVendorHost(bad), true, `should be flagged: ${bad}`);
  }
  for (const good of ["https://shiurpod.com/feed/x.xml", "https://audio.shiurpod.com/a.mp3"]) {
    assert.equal(mod.isVendorHost(good), false, `should be allowed: ${good}`);
  }
  });
});
