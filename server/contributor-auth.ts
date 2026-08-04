import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { Request, Response, NextFunction } from "express";
import { db } from "./db";
import { contributors, contributorSessions } from "@shared/schema";
import type { Contributor } from "@shared/schema";

// Creator authentication.
//
// Modelled on portalAuth (server/routes-v1.ts:46) and deliberately NOT on
// adminAuth. The admin scheme's "token" is base64(user:pass) — the credentials
// themselves — kept in localStorage in a page that renders through innerHTML.
// That is survivable for a single operator who controls the machine; it is not
// something to hand to dozens of ravvonim.
//
// Here the token is opaque random bytes, and only its SHA-256 is stored. A
// database leak therefore yields no usable sessions.

const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days — this is a content tool, not a bank
const SETUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;     // first-password link
const RESET_TTL_MS = 2 * 60 * 60 * 1000;          // password reset, short on purpose
const BCRYPT_ROUNDS = 12;

export type SessionPurpose = "session" | "setup" | "reset";

/** SHA-256, not bcrypt: the token is already 256 bits of entropy, so there is
 *  nothing to slow down a guesser about — and login must stay fast. */
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

function ttlFor(purpose: SessionPurpose): number {
  return purpose === "session" ? SESSION_TTL_MS : purpose === "setup" ? SETUP_TTL_MS : RESET_TTL_MS;
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

/** Mint a token. Only the hash is persisted — the plaintext is returned once. */
export async function issueToken(
  contributorId: string,
  purpose: SessionPurpose = "session",
): Promise<IssuedToken> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + ttlFor(purpose));
  await db.insert(contributorSessions).values({
    tokenHash: hashToken(token),
    contributorId,
    purpose,
    expiresAt,
  });
  return { token, expiresAt };
}

export interface ResolvedSession {
  contributor: Contributor;
  purpose: SessionPurpose;
}

/**
 * Resolve a token to its contributor.
 *
 * Rejects expired tokens, suspended contributors, and already-used single-use
 * tokens. Setup and reset tokens are single-use so a leaked password-reset link
 * in an inbox cannot be replayed months later.
 */
export async function resolveToken(token: string): Promise<ResolvedSession | null> {
  if (!token || token.length < 20) return null;

  const rows = await db
    .select({ session: contributorSessions, contributor: contributors })
    .from(contributorSessions)
    .innerJoin(contributors, eq(contributors.id, contributorSessions.contributorId))
    .where(
      and(
        eq(contributorSessions.tokenHash, hashToken(token)),
        gt(contributorSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.contributor.status !== "active") return null;

  const purpose = row.session.purpose as SessionPurpose;
  if (purpose !== "session" && row.session.usedAt) return null;

  return { contributor: row.contributor as Contributor, purpose };
}

/** Burn a single-use token. */
export async function consumeToken(token: string): Promise<void> {
  await db
    .update(contributorSessions)
    .set({ usedAt: new Date() })
    .where(eq(contributorSessions.tokenHash, hashToken(token)));
}

export async function revokeToken(token: string): Promise<void> {
  await db.delete(contributorSessions).where(eq(contributorSessions.tokenHash, hashToken(token)));
}

/** Log out everywhere — used after a password change. */
export async function revokeAllSessions(contributorId: string): Promise<void> {
  await db
    .delete(contributorSessions)
    .where(
      and(
        eq(contributorSessions.contributorId, contributorId),
        eq(contributorSessions.purpose, "session"),
      ),
    );
}

export async function purgeExpiredSessions(): Promise<number> {
  const res: any = await db.execute(
    sql`DELETE FROM contributor_sessions WHERE expires_at < now() RETURNING token_hash`,
  );
  return (res.rows || []).length;
}

// ── Passwords ──────────────────────────────────────────────────────────────

export async function setPassword(contributorId: string, plaintext: string): Promise<void> {
  if (plaintext.length < 10) throw new Error("Password must be at least 10 characters");
  const hash = await bcrypt.hash(plaintext, BCRYPT_ROUNDS);
  await db.update(contributors).set({ passwordHash: hash }).where(eq(contributors.id, contributorId));
  // Any existing session was established under the old password.
  await revokeAllSessions(contributorId);
}

/**
 * Verify an email/password pair.
 *
 * Runs bcrypt even when the account does not exist, so response time does not
 * reveal which addresses are registered.
 */
export async function verifyPassword(email: string, plaintext: string): Promise<Contributor | null> {
  const [row] = await db
    .select()
    .from(contributors)
    .where(eq(contributors.contactEmail, email.toLowerCase().trim()))
    .limit(1);

  const DUMMY = "$2b$12$C6UzMDM.H6dfI/f/IKcEe.J9CWkRuZ8pMLQJqZ0aVJk8jHwbGx8Sq";
  const hash = row?.passwordHash || DUMMY;
  const ok = await bcrypt.compare(plaintext, hash);

  if (!row || !row.passwordHash || !ok) return null;
  if (row.status !== "active") return null;

  await db.update(contributors).set({ lastLoginAt: new Date() }).where(eq(contributors.id, row.id));
  return row as Contributor;
}

// ── Middleware ─────────────────────────────────────────────────────────────

export interface ContributorRequest extends Request {
  contributor?: Contributor;
}

/**
 * Bearer-only. A creator can never authenticate with admin Basic credentials,
 * and admin actions (suspend a show, approve an application) are never
 * reachable with a creator token — the privilege separation is structural,
 * not a role check that could be forgotten on a new route.
 */
export async function contributorAuth(
  req: ContributorRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  const session = await resolveToken(header.slice(7).trim());
  // A setup or reset token must not act as a login — it can only be exchanged
  // for a password at the dedicated endpoint.
  if (!session || session.purpose !== "session") {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  req.contributor = session.contributor;
  next();
}

/**
 * Ownership check. Every episode and show route must run this: without it, a
 * valid creator token could edit ANOTHER rav's show simply by changing the id
 * in the URL.
 */
export async function ownsShow(contributorId: string, showId: string): Promise<boolean> {
  const res: any = await db.execute(
    sql`SELECT 1 FROM contributor_shows WHERE id = ${showId} AND contributor_id = ${contributorId} LIMIT 1`,
  );
  return (res.rows || []).length > 0;
}

export async function ownsEpisode(contributorId: string, episodeId: string): Promise<boolean> {
  const res: any = await db.execute(sql`
    SELECT 1 FROM contributor_episodes e
      JOIN contributor_shows s ON s.id = e.show_id
     WHERE e.id = ${episodeId} AND s.contributor_id = ${contributorId}
     LIMIT 1
  `);
  return (res.rows || []).length > 0;
}
