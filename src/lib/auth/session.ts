import "server-only";
import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db, schema } from "../db";
import type { Segment } from "../db/schema";
import { can, segmentsFor, type Permission, type RoleGrant } from "./permissions";
import { hashToken, newToken } from "./tokens";

/** __Host- pins the cookie to this exact host over HTTPS. Plain name in development (http://localhost). */
export const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-ws_session" : "ws_session";
const ABSOLUTE_MS = 12 * 60 * 60 * 1000; // a working day
const IDLE_MS = 2 * 60 * 60 * 1000;
const MFA_PENDING_MS = 15 * 60 * 1000; // time to finish the second factor
const TOUCH_MS = 5 * 60 * 1000;

export interface Staff {
  id: string;
  name: string;
  email: string;
  roleNames: string[];
  roles: RoleGrant[];
  can: (permission: Permission, segment?: Segment) => boolean;
  segmentsFor: (permission: Permission) => Segment[];
}

export interface SessionState {
  sessionId: string;
  userId: string;
  mfaVerified: boolean;
  totpEnabled: boolean;
  staff: Staff;
}

async function setCookie(token: string, expires: Date) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires,
  });
}

/** Starts a session after the password step. It can only finish sign-in until the second factor is passed. */
export async function startSession(userId: string): Promise<void> {
  const { token, hash } = newToken();
  const expiresAt = new Date(Date.now() + MFA_PENDING_MS);
  const userAgent = ((await headers()).get("user-agent") ?? "").slice(0, 300);
  await db().insert(schema.sessions).values({ id: hash, userId, expiresAt, userAgent });
  await setCookie(token, expiresAt);
}

/** Marks the second factor passed: the session becomes a full one, under a fresh token. */
export async function completeMfa(state: SessionState): Promise<void> {
  const { token, hash } = newToken();
  const expiresAt = new Date(Date.now() + ABSOLUTE_MS);
  await db().transaction(async (tx) => {
    const [old] = await tx.delete(schema.sessions).where(eq(schema.sessions.id, state.sessionId)).returning();
    await tx.insert(schema.sessions).values({
      id: hash,
      userId: state.userId,
      expiresAt,
      mfaVerifiedAt: new Date(),
      userAgent: old?.userAgent ?? null,
    });
    await tx.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, state.userId));
  });
  await setCookie(token, expiresAt);
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db().delete(schema.sessions).where(eq(schema.sessions.id, hashToken(token)));
  jar.delete(SESSION_COOKIE);
}

/** Ends every session a user has: on disable, password change or MFA reset. */
export async function endAllSessions(userId: string): Promise<void> {
  await db().delete(schema.sessions).where(eq(schema.sessions.userId, userId));
}

export async function rolesFor(userIds: string[]) {
  if (userIds.length === 0) return [];
  return db()
    .select({ userId: schema.userRoles.userId, name: schema.roles.name, permissions: schema.roles.permissions, segments: schema.roles.segments })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
    .where(inArray(schema.userRoles.userId, userIds));
}

export function toStaff(user: { id: string; name: string; email: string }, roleRows: { name: string; permissions: string[]; segments: string[] }[]): Staff {
  const roles = roleRows.map((r) => ({ permissions: r.permissions, segments: r.segments }));
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roleNames: roleRows.map((r) => r.name),
    roles,
    can: (p, s) => can(roles, p, s),
    segmentsFor: (p) => segmentsFor(roles, p),
  };
}

/** The current session, whether or not the second factor is done. Memoised per request. */
export const readSession = cache(async (): Promise<SessionState | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const now = new Date();
  const [row] = await db()
    .select({ session: schema.sessions, user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.id, hashToken(token)), gt(schema.sessions.expiresAt, now)));
  if (!row || row.user.status !== "active") return null;
  const { session, user } = row;
  if (session.mfaVerifiedAt && now.getTime() - session.lastSeenAt.getTime() > IDLE_MS) {
    await db().delete(schema.sessions).where(eq(schema.sessions.id, session.id));
    return null;
  }
  if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_MS) {
    await db().update(schema.sessions).set({ lastSeenAt: now }).where(eq(schema.sessions.id, session.id));
  }
  return {
    sessionId: session.id,
    userId: user.id,
    mfaVerified: Boolean(session.mfaVerifiedAt),
    totpEnabled: Boolean(user.totpEnabledAt),
    staff: toStaff(user, await rolesFor([user.id])),
  };
});

/** The signed-in staff member, fully verified, or null. */
export async function currentStaff(): Promise<Staff | null> {
  const s = await readSession();
  return s?.mfaVerified ? s.staff : null;
}

/**
 * For every admin page and server action: the signed-in staff member, or a
 * redirect to sign in. With a permission (and segment), staff without it go
 * to the "no access" page.
 */
export async function requireStaff(permission?: Permission, segment?: Segment): Promise<Staff> {
  const s = await readSession();
  if (!s) redirect("/admin/login");
  if (!s.mfaVerified) redirect(s.totpEnabled ? "/admin/login/verify" : "/admin/login/setup");
  if (permission && !s.staff.can(permission, segment)) redirect("/admin/no-access");
  return s.staff;
}

/** Housekeeping: expired sessions, used or expired tokens, old login attempts. */
export async function purgeExpiredAuth(): Promise<void> {
  const now = new Date();
  await db().delete(schema.sessions).where(lt(schema.sessions.expiresAt, now));
  await db().delete(schema.authTokens).where(lt(schema.authTokens.expiresAt, now));
  await db().delete(schema.loginAttempts).where(lt(schema.loginAttempts.at, sql`now() - interval '30 days'`));
}
