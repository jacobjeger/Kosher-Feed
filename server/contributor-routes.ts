import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./db";
import {
  contributorApplications,
  contributors,
  contributorShows,
  contributorEpisodes,
} from "@shared/schema";
import {
  contributorAuth,
  issueToken,
  resolveToken,
  consumeToken,
  revokeToken,
  setPassword,
  verifyPassword,
  ownsShow,
  ownsEpisode,
  type ContributorRequest,
} from "./contributor-auth";
import { presignUpload, uploadKey, headObject, deleteObject, publicUrl, showArtworkKey } from "./r2";
import { enqueueUpload, mediaQueueCounts } from "./contributor/store";
import { buildAndCacheFeed } from "./contributor/feed-route";
import { nudgeContributorMediaWorker } from "./contributor-worker";
import { validateFeed } from "./contributor-feed";
import { MAX_UPLOAD_BYTES } from "./contributor-media";

// HTTP surface for the contributor program: public application, creator
// dashboard, admin moderation.

const MAX_TEXT = 5000;
const MAX_SHORT = 200;

function clean(v: unknown, max = MAX_SHORT): string {
  return String(v ?? "").trim().slice(0, max);
}

function bad(res: Response, msg: string, code = 400) {
  return res.status(code).json({ ok: false, error: msg });
}

/** Slug derived from a title, then uniquified. Immutable once live. */
async function uniqueSlug(base: string): Promise<string> {
  let slug = base
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "show";

  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? slug : `${slug}-${n + 1}`;
    const [taken] = await db
      .select({ id: contributorShows.id })
      .from(contributorShows)
      .where(eq(contributorShows.slug, candidate))
      .limit(1);
    if (!taken) return candidate;
  }
  return `${slug}-${Date.now().toString(36)}`;
}

function baseUrlOf(req: Request): string {
  const env = process.env.PUBLIC_BASE_URL || process.env.EXPO_PUBLIC_API_URL;
  if (env) return env.replace(/\/$/, "");
  const protocol = req.header("x-forwarded-proto") || req.protocol || "https";
  return `${protocol}://${req.header("x-forwarded-host") || req.get("host")}`;
}

export function registerContributorRoutes(app: Express, adminAuth: any): void {
  // ── Rate limiters ────────────────────────────────────────────────────
  // /api/contrib/login gets its OWN limiter and is deliberately not covered by
  // any skip prefix. server/index.ts:1543 skips /api/admin/* and then carves
  // out /api/admin/login by hand — that carve-out is exactly the shape of bug
  // that leaves a login endpoint open to unlimited guessing.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: "Too many attempts. Try again in a few minutes." },
  });

  // The application form is the first public write endpoint in the codebase
  // with no deviceId to correlate on, so this is the only thing standing
  // between it and a script.
  const applyLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: "Too many applications from this address." },
  });

  const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 120 });

  // ── Public: apply ────────────────────────────────────────────────────
  app.post("/api/contrib/apply", applyLimiter, async (req: Request, res: Response) => {
    try {
      const b = req.body || {};

      // Honeypot: a field hidden with CSS that only a bot fills in. Answer 200
      // so the bot records success and does not retry with variations.
      if (clean(b.website)) return res.json({ ok: true });

      const name = clean(b.name, 120);
      const email = clean(b.email, 200).toLowerCase();
      const proposedTitle = clean(b.proposedTitle, 200);
      const proposedDescription = clean(b.proposedDescription, MAX_TEXT);

      if (!name || !email || !proposedTitle || !proposedDescription) {
        return bad(res, "Name, email, show title and description are required.");
      }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, "That email address is not valid.");
      if (proposedDescription.length < 40) {
        return bad(res, "Please describe the shiurim in a little more detail.");
      }

      const [existing] = await db
        .select({ id: contributorApplications.id })
        .from(contributorApplications)
        .where(and(eq(contributorApplications.email, email), eq(contributorApplications.status, "pending")))
        .limit(1);
      if (existing) {
        return res.json({ ok: true, duplicate: true, message: "You already have an application under review." });
      }

      const [row] = await db
        .insert(contributorApplications)
        .values({
          name,
          email,
          phone: clean(b.phone, 60) || null,
          organization: clean(b.organization, 200) || null,
          proposedTitle,
          proposedDescription,
          language: ["en", "he", "yi"].includes(clean(b.language, 4)) ? clean(b.language, 4) : "en",
          bio: clean(b.bio, MAX_TEXT) || null,
          sampleAudioUrl: clean(b.sampleAudioUrl, 500) || null,
          ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || null,
          userAgent: clean(req.headers["user-agent"], 300) || null,
        })
        .returning();

      res.json({ ok: true, id: row.id });
    } catch (e: any) {
      console.error(`contrib apply: ${e?.message?.slice(0, 200)}`);
      bad(res, "Could not submit the application.", 500);
    }
  });

  // ── Auth ─────────────────────────────────────────────────────────────
  app.post("/api/contrib/login", loginLimiter, async (req: Request, res: Response) => {
    try {
      const email = clean(req.body?.email, 200);
      const password = String(req.body?.password || "");
      if (!email || !password) return bad(res, "Email and password are required.");

      const contributor = await verifyPassword(email, password);
      if (!contributor) return bad(res, "Incorrect email or password.", 401);

      const { token, expiresAt } = await issueToken(contributor.id, "session");
      res.json({
        ok: true,
        token,
        expiresAt,
        contributor: { id: contributor.id, name: contributor.displayName, email: contributor.contactEmail },
      });
    } catch (e: any) {
      bad(res, "Login failed.", 500);
    }
  });

  // Exchange a single-use setup/reset token for a password.
  app.post("/api/contrib/set-password", loginLimiter, async (req: Request, res: Response) => {
    try {
      const token = String(req.body?.token || "");
      const password = String(req.body?.password || "");
      const session = await resolveToken(token);
      if (!session || session.purpose === "session") return bad(res, "That link is invalid or has expired.", 401);
      if (password.length < 10) return bad(res, "Password must be at least 10 characters.");

      await setPassword(session.contributor.id, password);
      await consumeToken(token);

      const issued = await issueToken(session.contributor.id, "session");
      res.json({ ok: true, token: issued.token, expiresAt: issued.expiresAt });
    } catch (e: any) {
      bad(res, e?.message || "Could not set the password.", 400);
    }
  });

  app.post("/api/contrib/logout", async (req: Request, res: Response) => {
    const h = req.headers.authorization || "";
    if (h.startsWith("Bearer ")) await revokeToken(h.slice(7).trim()).catch(() => {});
    res.json({ ok: true });
  });

  // ── Creator: identity + shows ────────────────────────────────────────
  app.get("/api/contrib/me", contributorAuth as any, async (req: ContributorRequest, res: Response) => {
    const c = req.contributor!;
    const shows = await db
      .select()
      .from(contributorShows)
      .where(eq(contributorShows.contributorId, c.id))
      .orderBy(desc(contributorShows.createdAt));
    res.json({
      ok: true,
      contributor: { id: c.id, name: c.displayName, email: c.contactEmail },
      shows: shows.map((s) => ({
        ...s,
        feedUrl: `${baseUrlOf(req)}/feed/${s.slug}.xml`,
        artworkUrl: s.artworkKey ? publicUrl(s.artworkKey) : null,
        feedXml: undefined, // never ship the cached document to the dashboard
      })),
    });
  });

  app.get("/api/contrib/shows/:showId/episodes", contributorAuth as any, async (req: ContributorRequest, res: Response) => {
    const showId = String(req.params.showId);
    if (!(await ownsShow(req.contributor!.id, showId))) return bad(res, "Not found.", 404);
    const eps = await db
      .select()
      .from(contributorEpisodes)
      .where(eq(contributorEpisodes.showId, showId))
      .orderBy(desc(contributorEpisodes.pubDate));
    res.json({ ok: true, episodes: eps.map((e) => ({ ...e, audioUrl: e.audioKey ? publicUrl(e.audioKey) : null })) });
  });

  // ── Creator: episodes ────────────────────────────────────────────────
  app.post("/api/contrib/shows/:showId/episodes", contributorAuth as any, async (req: ContributorRequest, res: Response) => {
    try {
      const showId = String(req.params.showId);
      if (!(await ownsShow(req.contributor!.id, showId))) return bad(res, "Not found.", 404);

      const title = clean(req.body?.title, 300);
      if (!title) return bad(res, "A title is required.");

      const pubDate = req.body?.pubDate ? new Date(req.body.pubDate) : new Date();
      if (Number.isNaN(pubDate.getTime())) return bad(res, "That publish date is not valid.");

      const [ep] = await db
        .insert(contributorEpisodes)
        .values({
          showId,
          title,
          description: clean(req.body?.description, MAX_TEXT) || "",
          pubDate,
          episodeNumber: req.body?.episodeNumber != null ? Number(req.body.episodeNumber) : null,
          seasonNumber: req.body?.seasonNumber != null ? Number(req.body.seasonNumber) : null,
          explicit: false,
          status: "draft",
          seriesName: clean(req.body?.seriesName, 200) || null,
          masechta: clean(req.body?.masechta, 100) || null,
          daf: clean(req.body?.daf, 20) || null,
          parsha: clean(req.body?.parsha, 100) || null,
        })
        .returning();

      res.json({ ok: true, episode: ep });
    } catch (e: any) {
      bad(res, "Could not create the episode.", 500);
    }
  });

  /**
   * Issue a presigned PUT.
   *
   * The KEY IS CHOSEN HERE, never accepted from the client — a client-supplied
   * key would let one creator overwrite another's audio.
   */
  app.post("/api/contrib/episodes/:id/upload-url", uploadLimiter, contributorAuth as any, async (req: ContributorRequest, res: Response) => {
    try {
      const id = String(req.params.id);
      if (!(await ownsEpisode(req.contributor!.id, id))) return bad(res, "Not found.", 404);

      const ep = (await db.select().from(contributorEpisodes).where(eq(contributorEpisodes.id, id)).limit(1))[0];
      if (!ep) return bad(res, "Not found.", 404);

      const ext = clean(req.body?.extension, 8).replace(/[^a-z0-9]/gi, "").toLowerCase() || "mp3";
      const contentType = clean(req.body?.contentType, 100) || "application/octet-stream";
      if (!/^audio\/|^video\/|^application\/octet-stream$/.test(contentType)) {
        return bad(res, "That file type is not supported.");
      }

      const key = uploadKey(ep.showId, ep.id, ext);
      const signed = await presignUpload(key, contentType);
      res.json({
        ok: true,
        uploadUrl: signed.url,
        key: signed.key,
        expiresAt: signed.expiresAt,
        // Advisory only. The cap cannot be bound to a presigned PUT, so the
        // real enforcement is the HEAD in the worker.
        maxBytes: MAX_UPLOAD_BYTES,
      });
    } catch (e: any) {
      bad(res, "Could not start the upload.", 500);
    }
  });

  /** Called after the browser's PUT completes. Verifies and queues. */
  app.post("/api/contrib/episodes/:id/uploaded", contributorAuth as any, async (req: ContributorRequest, res: Response) => {
    try {
      const id = String(req.params.id);
      if (!(await ownsEpisode(req.contributor!.id, id))) return bad(res, "Not found.", 404);

      const ep = (await db.select().from(contributorEpisodes).where(eq(contributorEpisodes.id, id)).limit(1))[0];
      if (!ep) return bad(res, "Not found.", 404);

      const key = clean(req.body?.key, 300);
      // Confirm the key belongs to THIS episode — the client tells us what it
      // uploaded, and it does not get to name someone else's object.
      if (!key.startsWith(`uploads/${ep.showId}/${ep.id}.`)) return bad(res, "That upload does not belong to this episode.");

      const head = await headObject(key);
      if (!head.exists) return bad(res, "The upload did not complete. Please try again.");
      if (head.size > MAX_UPLOAD_BYTES) {
        await deleteObject(key).catch(() => {});
        return bad(res, `That file is ${Math.round(head.size / 1048576)}MB, over the ${Math.round(MAX_UPLOAD_BYTES / 1048576)}MB limit.`);
      }

      await enqueueUpload(id, key, head.size);
      nudgeContributorMediaWorker();
      res.json({ ok: true, bytes: head.size, status: "queued" });
    } catch (e: any) {
      bad(res, "Could not queue the upload.", 500);
    }
  });

  app.patch("/api/contrib/episodes/:id", contributorAuth as any, async (req: ContributorRequest, res: Response) => {
    try {
      const id = String(req.params.id);
      if (!(await ownsEpisode(req.contributor!.id, id))) return bad(res, "Not found.", 404);

      const patch: Record<string, any> = { updatedAt: new Date() };
      if (req.body?.title != null) patch.title = clean(req.body.title, 300);
      if (req.body?.description != null) patch.description = clean(req.body.description, MAX_TEXT);
      if (req.body?.seriesName != null) patch.seriesName = clean(req.body.seriesName, 200) || null;
      if (req.body?.masechta != null) patch.masechta = clean(req.body.masechta, 100) || null;
      if (req.body?.daf != null) patch.daf = clean(req.body.daf, 20) || null;
      if (req.body?.parsha != null) patch.parsha = clean(req.body.parsha, 100) || null;
      if (req.body?.episodeNumber != null) patch.episodeNumber = Number(req.body.episodeNumber) || null;
      if (req.body?.pubDate != null) {
        const d = new Date(req.body.pubDate);
        if (Number.isNaN(d.getTime())) return bad(res, "That publish date is not valid.");
        patch.pubDate = d;
      }
      // NOTE: guid is never in this map. It is minted once by the DB and must
      // survive every edit, or every subscriber re-downloads the episode.

      const [updated] = await db
        .update(contributorEpisodes)
        .set(patch)
        .where(eq(contributorEpisodes.id, id))
        .returning();

      if (updated.status === "published") await rebuild(updated.showId, req);
      res.json({ ok: true, episode: updated });
    } catch (e: any) {
      bad(res, "Could not save the episode.", 500);
    }
  });

  app.post("/api/contrib/episodes/:id/publish", contributorAuth as any, async (req: ContributorRequest, res: Response) => {
    try {
      const id = String(req.params.id);
      if (!(await ownsEpisode(req.contributor!.id, id))) return bad(res, "Not found.", 404);

      const ep = (await db.select().from(contributorEpisodes).where(eq(contributorEpisodes.id, id)).limit(1))[0];
      if (!ep) return bad(res, "Not found.", 404);
      if (ep.mediaStatus !== "ready" || !ep.audioKey || !ep.byteSize) {
        return bad(res, "The audio is still processing. You can publish once it is ready.");
      }

      const show = (await db.select().from(contributorShows).where(eq(contributorShows.id, ep.showId)).limit(1))[0];

      // A show under review queues instead of going straight out.
      const scheduled = ep.pubDate && ep.pubDate.getTime() > Date.now();
      const status = show?.reviewRequired ? "pending_review" : scheduled ? "scheduled" : "published";

      const [updated] = await db
        .update(contributorEpisodes)
        .set({
          status,
          publishedAt: status === "published" ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(contributorEpisodes.id, id))
        .returning();

      if (status === "published") await rebuild(ep.showId, req);
      res.json({ ok: true, episode: updated, status });
    } catch (e: any) {
      bad(res, "Could not publish.", 500);
    }
  });

  app.post("/api/contrib/episodes/:id/unpublish", contributorAuth as any, async (req: ContributorRequest, res: Response) => {
    try {
      const id = String(req.params.id);
      if (!(await ownsEpisode(req.contributor!.id, id))) return bad(res, "Not found.", 404);
      const [updated] = await db
        .update(contributorEpisodes)
        .set({ status: "unpublished", updatedAt: new Date() })
        .where(eq(contributorEpisodes.id, id))
        .returning();
      await rebuild(updated.showId, req);
      res.json({ ok: true, episode: updated });
    } catch (e: any) {
      bad(res, "Could not unpublish.", 500);
    }
  });

  // ── Creator: feed health ─────────────────────────────────────────────
  app.get("/api/contrib/shows/:showId/validate", contributorAuth as any, async (req: ContributorRequest, res: Response) => {
    const showId = String(req.params.showId);
    if (!(await ownsShow(req.contributor!.id, showId))) return bad(res, "Not found.", 404);
    const show = (await db.select().from(contributorShows).where(eq(contributorShows.id, showId)).limit(1))[0];
    const eps = await db.select().from(contributorEpisodes).where(eq(contributorEpisodes.showId, showId));
    res.json({ ok: true, issues: validateFeed(show as any, eps as any) });
  });

  // ── Admin ────────────────────────────────────────────────────────────
  app.get("/api/admin/contrib/applications", adminAuth, async (req: Request, res: Response) => {
    const status = clean(req.query?.status, 20) || "pending";
    const rows = await db
      .select()
      .from(contributorApplications)
      .where(eq(contributorApplications.status, status))
      .orderBy(desc(contributorApplications.createdAt))
      .limit(200);
    res.json({
      ok: true,
      applications: rows.map((r) => ({
        ...r,
        sampleAudioPlayUrl: r.sampleAudioKey ? publicUrl(r.sampleAudioKey) : r.sampleAudioUrl,
      })),
    });
  });

  app.get("/api/admin/contrib/counts", adminAuth, async (_req: Request, res: Response) => {
    const apps: any = await db.execute(sql`
      SELECT status, count(*)::int AS n FROM contributor_applications GROUP BY status
    `);
    const shows: any = await db.execute(sql`
      SELECT status, count(*)::int AS n FROM contributor_shows GROUP BY status
    `);
    const review: any = await db.execute(sql`
      SELECT count(*)::int AS n FROM contributor_episodes WHERE status = 'pending_review'
    `);
    const out = (rows: any[]) => Object.fromEntries((rows || []).map((r) => [r.status, Number(r.n)]));
    res.json({
      ok: true,
      applications: out(apps.rows),
      shows: out(shows.rows),
      pendingReview: Number(review.rows?.[0]?.n || 0),
      media: await mediaQueueCounts(),
    });
  });

  /** Approve an application: creates the contributor, the show, and a setup link. */
  app.post("/api/admin/contrib/applications/:id/approve", adminAuth, async (req: Request, res: Response) => {
    try {
      const [appRow] = await db
        .select()
        .from(contributorApplications)
        .where(eq(contributorApplications.id, String(req.params.id)))
        .limit(1);
      if (!appRow) return bad(res, "Not found.", 404);
      if (appRow.status === "approved") return bad(res, "Already approved.");

      let [contributor] = await db
        .select()
        .from(contributors)
        .where(eq(contributors.contactEmail, appRow.email))
        .limit(1);

      if (!contributor) {
        [contributor] = await db
          .insert(contributors)
          .values({
            contactEmail: appRow.email,
            displayName: appRow.name,
            status: "active",
            applicationId: appRow.id,
          })
          .returning();
      }

      const slug = await uniqueSlug(clean(req.body?.slug, 60) || appRow.proposedTitle);

      const [show] = await db
        .insert(contributorShows)
        .values({
          contributorId: contributor.id,
          slug,
          title: appRow.proposedTitle,
          description: appRow.proposedDescription,
          language: appRow.language,
          author: appRow.name,
          ownerName: appRow.name,
          // Always our catch-all, never the rav's address: this is where the
          // directory claim code lands and the operator must be able to read it.
          ownerEmail: `show-${slug}@shiurpod.com`,
          itunesCategory: "Religion & Spirituality",
          itunesSubcategory: "Judaism",
          reviewRequired: true,
          status: "draft",
        })
        .returning();

      await db
        .update(contributorApplications)
        .set({
          status: "approved",
          reviewedAt: new Date(),
          reviewedBy: clean(req.body?.reviewedBy, 100) || "admin",
          reviewNotes: clean(req.body?.notes, MAX_TEXT) || null,
          contributorId: contributor.id,
        })
        .where(eq(contributorApplications.id, appRow.id));

      // Single-use, 7 days. Returned to the admin to send on — there is no
      // outbound mail wired to contributors yet.
      const setup = await issueToken(contributor.id, "setup");

      res.json({
        ok: true,
        contributorId: contributor.id,
        show: { id: show.id, slug: show.slug, feedUrl: `${baseUrlOf(req)}/feed/${show.slug}.xml` },
        setupUrl: `${baseUrlOf(req)}/creator?setup=${setup.token}`,
        setupExpiresAt: setup.expiresAt,
      });
    } catch (e: any) {
      console.error(`contrib approve: ${e?.message?.slice(0, 200)}`);
      bad(res, "Could not approve the application.", 500);
    }
  });

  app.post("/api/admin/contrib/applications/:id/reject", adminAuth, async (req: Request, res: Response) => {
    await db
      .update(contributorApplications)
      .set({
        status: "rejected",
        reviewedAt: new Date(),
        reviewedBy: clean(req.body?.reviewedBy, 100) || "admin",
        reviewNotes: clean(req.body?.notes, MAX_TEXT) || null,
      })
      .where(eq(contributorApplications.id, String(req.params.id)));
    res.json({ ok: true });
  });

  app.get("/api/admin/contrib/shows", adminAuth, async (req: Request, res: Response) => {
    const rows = await db.select().from(contributorShows).orderBy(desc(contributorShows.createdAt)).limit(500);
    res.json({
      ok: true,
      shows: rows.map((s) => ({
        ...s,
        feedXml: undefined,
        feedUrl: `${baseUrlOf(req)}/feed/${s.slug}.xml`,
        artworkUrl: s.artworkKey ? publicUrl(s.artworkKey) : null,
      })),
    });
  });

  /** Only admin Basic can do this — a creator token can never reach it. */
  app.post("/api/admin/contrib/shows/:id/status", adminAuth, async (req: Request, res: Response) => {
    const status = clean(req.body?.status, 20);
    if (!["draft", "live", "suspended"].includes(status)) return bad(res, "Invalid status.");
    const [show] = await db
      .update(contributorShows)
      .set({ status, updatedAt: new Date() })
      .where(eq(contributorShows.id, String(req.params.id)))
      .returning();
    if (!show) return bad(res, "Not found.", 404);
    if (status === "live") await rebuild(show.id, req);
    res.json({ ok: true, show: { ...show, feedXml: undefined } });
  });

  app.get("/api/admin/contrib/review-queue", adminAuth, async (_req: Request, res: Response) => {
    const rows = await db
      .select()
      .from(contributorEpisodes)
      .where(eq(contributorEpisodes.status, "pending_review"))
      .orderBy(desc(contributorEpisodes.createdAt))
      .limit(200);
    res.json({
      ok: true,
      episodes: rows.map((e) => ({ ...e, audioUrl: e.audioKey ? publicUrl(e.audioKey) : null })),
    });
  });

  app.post("/api/admin/contrib/episodes/:id/review", adminAuth, async (req: Request, res: Response) => {
    const decision = clean(req.body?.decision, 20);
    if (!["approve", "reject"].includes(decision)) return bad(res, "Invalid decision.");

    const [ep] = await db
      .update(contributorEpisodes)
      .set({
        status: decision === "approve" ? "published" : "rejected",
        publishedAt: decision === "approve" ? new Date() : null,
        reviewedAt: new Date(),
        reviewedBy: clean(req.body?.reviewedBy, 100) || "admin",
        reviewNote: clean(req.body?.note, MAX_TEXT) || null,
        updatedAt: new Date(),
      })
      .where(eq(contributorEpisodes.id, String(req.params.id)))
      .returning();

    if (!ep) return bad(res, "Not found.", 404);
    await rebuild(ep.showId, req);
    res.json({ ok: true, episode: ep });
  });

  async function rebuild(showId: string, req: Request): Promise<void> {
    await buildAndCacheFeed(showId, baseUrlOf(req)).catch((e) =>
      console.error(`feed rebuild ${showId}: ${e?.message?.slice(0, 160)}`),
    );
  }
}
