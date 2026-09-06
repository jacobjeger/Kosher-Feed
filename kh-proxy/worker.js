// Cloudflare Worker that proxies requests to upstreams whose CDNs block
// Railway's IPs. Currently routes:
//   /api/*  → Kol Halashon API     (www.kolhalashon.com)
//   /td/*   → TorahDownloads CDN   (torahcdn.net)
//
// Deploy: cd kh-proxy && npx wrangler deploy
// Server env: KH_PROXY_URL points to this worker URL.

// Kol Halashon rebuilt their platform in early September 2026. Two things
// changed at once and together they took out 74% of the catalogue:
//
//   1. The API moved off srv.kolhalashon.com to www.kolhalashon.com. The old
//      host answers 404 for every path, which is what /api/audio/kh/* was
//      turning into a 502.
//   2. Audio moved behind a two-step, token-gated flow. See the audio route in
//      server/routes.ts — GetPlayToken then GetFileToPlay.
//
// Overridable so the next move does not need a code change.
const KH_BASE_DEFAULT = "https://www.kolhalashon.com";
const TD_CDN_BASE = "https://torahcdn.net";

/**
 * authorization-site-key is a per-request nonce, NOT a credential.
 *
 * Every request their web app makes carries a different 7-character base-36
 * value — 40 distinct ones across 40 requests in a single page load, all
 * issued in the same millisecond. We used to send one hardcoded string
 * ("Bearer 8ea2pe8") on every request forever, which is why we were
 * distinguishable from a browser and, once they started checking, why we
 * stopped getting served.
 *
 * KH_AUTH_TOKEN still wins if set, so a real issued credential can replace
 * this without a code change.
 */
function siteKey(env) {
  if (env && env.KH_AUTH_TOKEN) return env.KH_AUTH_TOKEN;
  let nonce = "";
  while (nonce.length < 7) nonce += Math.random().toString(36).slice(2);
  return `Bearer ${nonce.slice(0, 7)}`;
}

function khHeaders(env, request) {
  const headers = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "he-IL,he;q=0.9,en-AU;q=0.8,en;q=0.7,en-US;q=0.6",
    "authorization-site-key": siteKey(env),
    "origin": KH_BASE_DEFAULT,
    "referer": `${KH_BASE_DEFAULT}/`,
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };
  // Range must reach the upstream or audio arrives as one 200 with the whole
  // file, which breaks seeking and makes the player buffer the lot.
  const range = request && request.headers.get("range");
  if (range) headers["range"] = range;
  return headers;
}

// torahcdn.net (Cloudflare-fronted S3) returns 1015 / silent drops for
// requests bearing Railway IPs + non-browser UAs. From a worker on
// Cloudflare's own network with browser-like headers, requests succeed.
const TD_HEADERS = {
  "accept": "*/*",
  "accept-language": "en-US,en;q=0.9",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "origin": "https://torahdownloads.com",
  "referer": "https://torahdownloads.com/",
};

/** Headers a ranged media response cannot survive without. */
const MEDIA_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"];

export default {
  async fetch(request, env) {
    // Verify secret to prevent abuse
    const authHeader = request.headers.get("x-proxy-key");
    if (env.PROXY_KEY && authHeader !== env.PROXY_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);

    // /td/ → torahcdn.net passthrough (HEAD or GET)
    if (url.pathname.startsWith("/td/")) {
      const upstream = TD_CDN_BASE + url.pathname.slice(3) + url.search;
      const tdReq = new Request(upstream, {
        method: request.method,
        headers: TD_HEADERS,
      });
      const r = await fetch(tdReq);
      // Forward the headers we care about (Last-Modified, Content-Length,
      // x-amz-meta-cb-modifiedtime). Don't blanket-copy CORS headers from
      // upstream; explicitly allow our origin.
      const out = new Headers();
      for (const k of ["last-modified", "etag", "content-type", "content-length", "accept-ranges", "x-amz-meta-cb-modifiedtime"]) {
        const v = r.headers.get(k);
        if (v) out.set(k, v);
      }
      out.set("access-control-allow-origin", "*");
      out.set("access-control-expose-headers", "last-modified, etag, x-amz-meta-cb-modifiedtime");
      return new Response(r.body, { status: r.status, headers: out });
    }

    // Default: KH API passthrough.
    const base = (env && env.KH_BASE) || KH_BASE_DEFAULT;
    const khUrl = base + url.pathname + url.search;
    const khRequest = new Request(khUrl, {
      method: request.method,
      headers: khHeaders(env, request),
      body: request.method !== "GET" ? await request.text() : undefined,
    });
    const response = await fetch(khRequest);

    // Forward the media headers as well as the content type. This path now
    // carries audio, not just JSON: dropping content-range and accept-ranges
    // turns a 206 into something the player cannot seek in, and dropping
    // content-length makes it impossible to show a duration.
    const out = new Headers();
    for (const k of MEDIA_HEADERS) {
      const v = response.headers.get(k);
      if (v) out.set(k, v);
    }
    if (!out.has("content-type")) out.set("content-type", "application/json");
    out.set("access-control-allow-origin", "*");
    out.set("access-control-expose-headers", "content-length, content-range, accept-ranges");
    return new Response(response.body, { status: response.status, headers: out });
  },
};
