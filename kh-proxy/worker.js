// Cloudflare Worker that proxies requests to upstreams whose CDNs block
// Railway's IPs. Currently routes:
//   /api/*  → Kol Halashon API     (srv.kolhalashon.com)
//   /td/*   → TorahDownloads CDN   (torahcdn.net)
//
// Deploy: cd kh-proxy && npx wrangler deploy
// Server env: KH_PROXY_URL points to this worker URL.

const KH_BASE = "https://srv.kolhalashon.com";
const TD_CDN_BASE = "https://torahcdn.net";

const KH_HEADERS = {
  "accept": "application/json, text/plain, */*",
  "accept-language": "he-IL,he;q=0.9,en-AU;q=0.8,en;q=0.7,en-US;q=0.6",
  "authorization-site-key": "Bearer 8ea2pe8", // TODO: move to env.KH_AUTH_TOKEN wrangler secret
  "content-type": "application/json",
  "origin": "https://www2.kolhalashon.com",
  "referer": "https://www2.kolhalashon.com/",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

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

    // Default: KH API passthrough (existing behavior)
    const khUrl = KH_BASE + url.pathname + url.search;
    const khRequest = new Request(khUrl, {
      method: request.method,
      headers: KH_HEADERS,
      body: request.method !== "GET" ? await request.text() : undefined,
    });
    const response = await fetch(khRequest);
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") || "application/json",
        "access-control-allow-origin": "*",
      },
    });
  },
};
