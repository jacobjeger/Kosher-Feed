import type { Request } from "express";

// The visitor's IP address, as opposed to the IP of the proxy in front of us.
//
// shiurpod.com is proxied by Cloudflare with Railway as the origin, and
// Railway's edge rewrites X-Forwarded-For to the peer it sees — which is a
// Cloudflare edge node, not the visitor. Reading XFF therefore recorded
// Cloudflare colo addresses (172.64-172.71.*, 162.158.*, 104.22-23.*, ...)
// for every request, which geolocated to whichever colo the visitor happened
// to hit and bucketed every visitor behind a colo into one rate-limit key.
//
// CF-Connecting-IP survives that hop untouched, so prefer it; True-Client-IP
// is the Enterprise-plan equivalent. The XFF/socket chain stays as a fallback
// for requests that reach the origin without passing through Cloudflare
// (local dev, health checks hitting the Railway hostname directly).
export function getClientIp(req: Request): string | null {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();

  const trueClient = req.headers["true-client-ip"];
  if (typeof trueClient === "string" && trueClient.trim()) return trueClient.trim();

  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  if (first) return first;

  return (req as any).ip || req.socket?.remoteAddress || null;
}
