// Server-side image resize endpoint.
//
// Why this exists:
// Podcast artwork on libsyn/podbean/anchor/Backblaze is typically 1400x1400
// (iTunes spec) or larger. The ShiurPod UI displays it in 64–320px slots.
// Decoding the source at full resolution into a small slot wastes ~7.8MB of
// decoded bitmap per image; with 8 visible thumbnails during scroll that's
// ~63MB of RAM pressure — which is exactly what the 2026-06-18 Schok F1
// frame trace showed (35MB Background GC firing mid-scroll, eating 786ms).
//
// Approach: a thin proxy that fetches the original, runs it through sharp,
// returns WebP, and lets Cloudflare's edge cache handle persistence. Each
// (url, width) combo is resized exactly once globally — every subsequent
// request is served straight from Cloudflare without touching the server.
//
// SSRF protection: only http(s) schemes; reject private IPv4/IPv6 ranges
// after DNS lookup to prevent attackers from probing Railway's internal
// network through the proxy.

import type { Request, Response } from "express";
import sharp from "sharp";
import * as dns from "node:dns/promises";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024; // 25MB cap on source image size
const MIN_WIDTH = 32;
const MAX_WIDTH = 1024;
const ALLOWED_FORMATS = new Set(["webp", "jpeg", "png"]);

// IPv4 ranges we refuse to fetch: RFC1918 private, loopback, link-local,
// multicast, broadcast. Also IPv6 equivalents (loopback, link-local, unique
// local addresses).
function isPrivateAddress(addr: string): boolean {
  // IPv6 zone suffix
  const ip = addr.split("%")[0].toLowerCase();
  if (ip === "::1" || ip === "::" || ip === "0:0:0:0:0:0:0:1") return true;
  if (ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  // IPv4-mapped IPv6 like ::ffff:10.0.0.1
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const v4 = v4Mapped ? v4Mapped[1] : ip;
  const m = v4.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + AWS metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true;
  if (a >= 224) return true; // multicast / experimental / broadcast
  return false;
}

async function isSafeHost(hostname: string): Promise<boolean> {
  // First reject obviously bad inputs
  if (!hostname || hostname.length > 253) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
  if (hostname.endsWith(".internal") || hostname.endsWith(".local")) return false;
  // If the hostname is already an IP, validate directly
  const directIp = hostname.match(/^(\d+\.\d+\.\d+\.\d+|\[?[0-9a-f:]+\]?)$/i);
  if (directIp) {
    return !isPrivateAddress(hostname.replace(/^\[|\]$/g, ""));
  }
  // Resolve and reject if any address is private. Don't trust just the first
  // result — DNS rebinding could vary across calls; checking all is cheap.
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    if (addrs.length === 0) return false;
    return addrs.every(a => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

async function fetchSourceImage(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Some CDNs (Backblaze, certain S3 buckets) reject empty UAs.
        "User-Agent": "ShiurPod-ImageProxy/1.0",
        Accept: "image/*",
      },
      // Reject redirects to internal addresses by re-validating each hop.
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (loc) {
        // Recurse once for a single redirect; rejected on second hop.
        const next = new URL(loc, url);
        if (!await isSafeHost(next.hostname)) throw new Error("redirect to private host");
        clearTimeout(timer);
        return fetchSourceImage(next.toString());
      }
    }
    if (!res.ok) throw new Error(`source returned ${res.status}`);
    const contentLength = Number(res.headers.get("content-length") || 0);
    if (contentLength > MAX_SOURCE_BYTES) throw new Error("source too large");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_SOURCE_BYTES) throw new Error("source too large");
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

export async function imageResizeHandler(req: Request, res: Response): Promise<void> {
  try {
    const rawUrl = String(req.query.url || "");
    const widthParam = Number(req.query.w || 0);
    const formatParam = String(req.query.f || "webp").toLowerCase();

    if (!rawUrl) {
      res.status(400).json({ error: "url required" });
      return;
    }
    if (!Number.isFinite(widthParam) || widthParam < MIN_WIDTH || widthParam > MAX_WIDTH) {
      res.status(400).json({ error: `w must be ${MIN_WIDTH}-${MAX_WIDTH}` });
      return;
    }
    if (!ALLOWED_FORMATS.has(formatParam)) {
      res.status(400).json({ error: "f must be webp/jpeg/png" });
      return;
    }

    let parsed: URL;
    try { parsed = new URL(rawUrl); } catch {
      res.status(400).json({ error: "invalid url" });
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      res.status(400).json({ error: "only http(s)" });
      return;
    }
    if (!await isSafeHost(parsed.hostname)) {
      res.status(400).json({ error: "host blocked" });
      return;
    }

    const source = await fetchSourceImage(parsed.toString());

    // sharp pipeline. fit:"cover" + position:"center" matches expo-image's
    // contentFit="cover" so cards look identical to the un-proxied version.
    let pipeline = sharp(source, { failOn: "error" })
      .rotate() // honor EXIF orientation
      .resize({
        width: widthParam,
        height: widthParam,        // square crop — matches typical artwork
        fit: "cover",
        position: "center",
        withoutEnlargement: true,
      });
    let contentType: string;
    if (formatParam === "webp") {
      pipeline = pipeline.webp({ quality: 80, effort: 4 });
      contentType = "image/webp";
    } else if (formatParam === "jpeg") {
      pipeline = pipeline.jpeg({ quality: 82, mozjpeg: true });
      contentType = "image/jpeg";
    } else {
      pipeline = pipeline.png({ compressionLevel: 9 });
      contentType = "image/png";
    }
    const out = await pipeline.toBuffer();

    // Long-lived cache. Cloudflare in front of shiurpod.com will hold this
    // at the edge for a year; our origin gets one hit per (url, w, f).
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable, s-maxage=31536000");
    res.setHeader("Content-Length", String(out.length));
    res.setHeader("X-Image-Resize-Origin", "shiurpod");
    res.send(out);
  } catch (e: any) {
    const msg = e?.message || "resize failed";
    const isClient = /invalid url|blocked|too large|only http/i.test(msg);
    res.status(isClient ? 400 : 502).json({ error: msg });
  }
}
