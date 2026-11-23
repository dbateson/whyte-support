import "server-only";
import { and, asc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { decrypt, encrypt, keyRingFromEnv } from "../crypto";
import { db, schema } from "../db";
import { env } from "../env";
import { sendEmail } from "../email/postmark";
import { getSettings } from "../settings";
import { endAllSessions } from "./session";
import { hashToken, newToken } from "./tokens";

export interface Actor {
  id?: string;
  label: string;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

const audit = (actor: Actor, action: string, target: string, detail: Record<string, unknown> = {}) =>
  db().insert(schema.auditLog).values({ actorId: actor.id ?? null, actorLabel: actor.label, action, target, detail });

export async function listUsers() {
  const users = await db().select().from(schema.users).orderBy(asc(schema.users.name));
  const links = await db()
    .select({ userId: schema.userRoles.userId, roleId: schema.roles.id, name: schema.roles.name })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId));
  return users.map((u) => ({ ...u, roles: links.filter((l) => l.userId === u.id).map((l) => ({ id: l.roleId, name: l.name })) }));
}

export async function getUser(id: string) {
  return (await listUsers()).find((u) => u.id === id) ?? null;
}

export async function listRoles() {
  const roles = await db().select().from(schema.roles).orderBy(asc(schema.roles.name));
  const counts = await db()
    .select({ roleId: schema.userRoles.roleId, n: sql<number>`count(*)`.mapWith(Number) })
    .from(schema.userRoles)
    .groupBy(schema.userRoles.roleId);
  return roles.map((r) => ({ ...r, members: counts.find((c) => c.roleId === r.id)?.n ?? 0 }));
}

/** An invitation link, valid for 7 days. Earlier unused invitations for the user stop working. */
export async function createInviteLink(userId: string, baseUrl: string): Promise<string> {
  const { token, hash } = newToken();
  await db().transaction(async (tx) => {
    await tx.delete(schema.authTokens).where(and(eq(schema.authTokens.userId, userId), eq(schema.authTokens.purpose, "invite")));
    await tx.insert(schema.authTokens).values({ id: hash, userId, purpose: "invite", expiresAt: new Date(Date.now() + INVITE_TTL_MS) });
  });
  return `${baseUrl.replace(/\/$/, "")}/admin/accept?token=${token}`;
}

/**
 * Invites a staff member. Emails the link when email is set up; the link is
 * returned either way so an admin can pass it on (it's shown once).
 */
export async function inviteUser(
  input: { email: string; name: string; roleIds: string[] },
  actor: Actor,
  baseUrl: string,
): Promise<{ userId: string; link: string; emailed: boolean }> {
  const email = input.email.trim().toLowerCase();
  const [existing] = await db().select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
  if (existing) throw new Error("Someone with that email already has an account.");
  const [user] = await db().insert(schema.users).values({ email, name: input.name.trim(), status: "invited" }).returning();
  if (input.roleIds.length) await db().insert(schema.userRoles).values(input.roleIds.map((roleId) => ({ userId: user!.id, roleId })));
  const link = await createInviteLink(user!.id, baseUrl);
  await audit(actor, "user.invite", email, { roles: input.roleIds.length });
  const emailed = await emailLink(email, "You're invited to Whyte Support", `${actor.label} has invited you to Whyte Support.\n\nSet your password here (the link works for 7 days):\n${link}`);
  return { userId: user!.id, link, emailed };
}

/** Tells someone their account now has an authenticator, so a set-up they didn't do is noticed. */
export async function notifyAuthenticatorAdded(user: { email: string; name: string }) {
  await emailLink(
    user.email,
    "An authenticator was set up on your Whyte Support account",
    `Hi ${user.name.split(/\s+/)[0] || "there"},\n\nAn authenticator app was just set up for two-step sign-in on your Whyte Support account.\n\nIf that wasn't you, tell an admin straight away: they can reset it and disable the account.`,
  );
}

async function emailLink(to: string, subject: string, text: string): Promise<boolean> {
  const s = await getSettings(["email.from_address", "email.from_name"]);
  if (!s["email.from_address"]) return false;
  try {
    await sendEmail({ from: `${s["email.from_name"]} <${s["email.from_address"]}>`, to, subject, text, tag: "staff-auth" });
    return true;
  } catch {
    return false;
  }
}

/** Sends a password-reset link if the email belongs to an active user. Says nothing either way. */
export async function requestPasswordReset(email: string, baseUrl: string): Promise<void> {
  const [user] = await db().select().from(schema.users).where(and(eq(schema.users.email, email.trim().toLowerCase()), eq(schema.users.status, "active")));
  if (!user) return;
  const { token, hash } = newToken();
  await db().insert(schema.authTokens).values({ id: hash, userId: user.id, purpose: "reset", expiresAt: new Date(Date.now() + RESET_TTL_MS) });
  await emailLink(user.email, "Reset your Whyte Support password", `Reset your password here (the link works for an hour):\n${baseUrl.replace(/\/$/, "")}/admin/reset?token=${token}\n\nIf you didn't ask for this, ignore this email.`);
  await audit({ label: user.name, id: user.id }, "user.reset_requested", user.email);
}

/** Looks up a live one-time link without using it up. */
export async function peekToken(token: string, purpose: "invite" | "reset") {
  const [row] = await db()
    .select({ token: schema.authTokens, user: schema.users })
    .from(schema.authTokens)
    .innerJoin(schema.users, eq(schema.users.id, schema.authTokens.userId))
    .where(and(eq(schema.authTokens.id, hashToken(token)), eq(schema.authTokens.purpose, purpose), isNull(schema.authTokens.usedAt), gt(schema.authTokens.expiresAt, new Date())));
  if (!row || row.user.status === "disabled") return null;
  return row.user;
}

/** Uses a one-time link to set a password. Returns the user, or null if the link is no good. */
export async function setPasswordWithToken(token: string, purpose: "invite" | "reset", passwordHash: string, name?: string) {
  const user = await peekToken(token, purpose);
  if (!user) return null;
  await db().transaction(async (tx) => {
    const used = await tx
      .update(schema.authTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(schema.authTokens.id, hashToken(token)), isNull(schema.authTokens.usedAt)))
      .returning();
    if (used.length === 0) throw new Error("Link already used");
    // Any other outstanding invite or reset links for this person stop working too.
    await tx.delete(schema.authTokens).where(and(eq(schema.authTokens.userId, user.id), isNull(schema.authTokens.usedAt)));
    await tx
      .update(schema.users)
      .set({ passwordHash, status: "active", updatedAt: new Date(), ...(name ? { name } : {}) })
      .where(eq(schema.users.id, user.id));
    await tx.insert(schema.auditLog).values({ actorId: user.id, actorLabel: name ?? user.name, action: purpose === "invite" ? "user.accept_invite" : "user.reset_password", target: user.email });
  });
  await endAllSessions(user.id);
  return user;
}

export async function setUserRoles(userId: string, roleIds: string[], actor: Actor) {
  await assertNotLastAdmin(userId, roleIds);
  await db().transaction(async (tx) => {
    await tx.delete(schema.userRoles).where(eq(schema.userRoles.userId, userId));
    if (roleIds.length) await tx.insert(schema.userRoles).values(roleIds.map((roleId) => ({ userId, roleId })));
  });
  const names = roleIds.length ? (await db().select({ name: schema.roles.name }).from(schema.roles).where(inArray(schema.roles.id, roleIds))).map((r) => r.name) : [];
  await audit(actor, "user.roles", userId, { roles: names });
}

export async function setUserDisabled(userId: string, disabled: boolean, actor: Actor) {
  if (disabled) await assertNotLastAdmin(userId, []);
  const [user] = await db().select().from(schema.users).where(eq(schema.users.id, userId));
  if (!user) throw new Error("No such user");
  const status = disabled ? "disabled" : user.passwordHash ? "active" : "invited";
  await db().update(schema.users).set({ status, updatedAt: new Date() }).where(eq(schema.users.id, userId));
  if (disabled) await endAllSessions(userId);
  await audit(actor, disabled ? "user.disable" : "user.enable", user.email);
}

/** Clears a user's authenticator: they set one up again at next sign-in. */
export async function resetUserMfa(userId: string, actor: Actor) {
  const [user] = await db().update(schema.users).set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null }).where(eq(schema.users.id, userId)).returning();
  await endAllSessions(userId);
  await audit(actor, "user.mfa_reset", user?.email ?? userId);
}

/** Refuses a change that would leave no active user holding the Admin role. */
async function assertNotLastAdmin(userId: string, newRoleIds: string[]) {
  const [admin] = await db().select().from(schema.roles).where(and(eq(schema.roles.name, "Admin"), eq(schema.roles.isSystem, true)));
  if (!admin || newRoleIds.includes(admin.id)) return;
  const others = await db()
    .select({ id: schema.users.id })
    .from(schema.userRoles)
    .innerJoin(schema.users, eq(schema.users.id, schema.userRoles.userId))
    .where(and(eq(schema.userRoles.roleId, admin.id), eq(schema.users.status, "active"), ne(schema.users.id, userId)));
  const isAdmin = await db().select().from(schema.userRoles).where(and(eq(schema.userRoles.userId, userId), eq(schema.userRoles.roleId, admin.id)));
  if (isAdmin.length && others.length === 0) throw new Error("This is the last active admin. Make someone else an admin first.");
}

/* ---------- Authenticator (TOTP) secrets, encrypted at rest ---------- */

const ring = () => keyRingFromEnv(env());
export const encryptTotpSecret = (userId: string, secret: string) => encrypt(secret, `totp:${userId}`, ring());
export const decryptTotpSecret = (userId: string, stored: string) => decrypt(stored, `totp:${userId}`, ring());

/** Records an accepted code's time step; false if that step (or a later one) was already used. */
export async function claimTotpStep(userId: string, step: number): Promise<boolean> {
  const updated = await db()
    .update(schema.users)
    .set({ totpLastStep: step })
    .where(and(eq(schema.users.id, userId), sql`coalesce(${schema.users.totpLastStep}, -1) < ${step}`))
    .returning({ id: schema.users.id });
  return updated.length === 1;
}

/* ---------- Roles ---------- */

export async function saveRole(
  input: { id?: string; name: string; description: string; permissions: string[]; segments: string[] },
  actor: Actor,
) {
  if (input.id) {
    const [current] = await db().select().from(schema.roles).where(eq(schema.roles.id, input.id));
    if (!current) throw new Error("No such role");
    const locked = current.isSystem && current.name === "Admin";
    await db()
      .update(schema.roles)
      .set(locked ? { description: input.description } : { name: input.name, description: input.description, permissions: input.permissions, segments: input.segments })
      .where(eq(schema.roles.id, input.id));
    await audit(actor, "role.update", current.name, locked ? { description: true } : { permissions: input.permissions, segments: input.segments });
    return input.id;
  }
  const [created] = await db().insert(schema.roles).values({ name: input.name, description: input.description, permissions: input.permissions, segments: input.segments }).returning();
  await audit(actor, "role.create", input.name, { permissions: input.permissions, segments: input.segments });
  return created!.id;
}

export async function deleteRole(id: string, actor: Actor) {
  const [role] = await db().select().from(schema.roles).where(eq(schema.roles.id, id));
  if (!role) return;
  if (role.isSystem) throw new Error("Built-in roles can't be deleted.");
  await db().delete(schema.roles).where(eq(schema.roles.id, id));
  await audit(actor, "role.delete", role.name);
}
