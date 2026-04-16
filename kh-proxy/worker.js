// Cloudflare Worker that proxies requests to Kol Halashon API
// Deploy: cd kh-proxy && npx wrangler deploy
// Set KH_PROXY_URL env var on your server to the worker URL

const KH_BASE = "https://srv.kolhalashon.com";

const KH_HEADERS = {
  "accept": "application/json, text/plain, */*",
  "accept-language": "he-IL,he;q=0.9,en-AU;q=0.8,en;q=0.7,en-US;q=0.6",
  "authorization-site-key": "Bearer 8ea2pe8", // TODO: move to env.KH_AUTH_TOKEN wrangler secret
  "content-type": "application/json",
  "origin": "https://www2.kolhalashon.com",
  "referer": "https://www2.kolhalashon.com/",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

export default {
  async fetch(request, env) {
    // Verify secret to prevent abuse
    const authHeader = request.headers.get("x-proxy-key");
    if (env.PROXY_KEY && authHeader !== env.PROXY_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);
    // Forward the path to KH API
    const khUrl = KH_BASE + url.pathname + url.search;

    const khRequest = new Request(khUrl, {
      method: request.method,
      headers: KH_HEADERS,
      body: request.method !== "GET" ? await request.text() : undefined,
    });

    const response = await fetch(khRequest);

    // Return with CORS headers
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") || "application/json",
        "access-control-allow-origin": "*",
      },
    });
  },
};
