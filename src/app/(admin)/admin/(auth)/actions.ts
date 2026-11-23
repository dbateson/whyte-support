"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/ActionForm";
import { hashPassword, passwordProblem, verifyPassword, dummyHash } from "@/lib/auth/password";
import { recordSignIn, signInBlocked } from "@/lib/auth/rate-limit";
import { completeMfa, endSession, readSession, startSession } from "@/lib/auth/session";
import { generateTotpSecret, verifyTotp } from "@/lib/auth/totp";
import { claimTotpStep, decryptTotpSecret, encryptTotpSecret, requestPasswordReset, setPasswordWithToken } from "@/lib/auth/users";
import { db, schema } from "@/lib/db";
import { baseUrl, clientIp } from "@/lib/request";

const str = (d: FormData, k: string) => String(d.get(k) ?? "").trim();

export async function signIn(_: ActionState, data: FormData): Promise<ActionState> {
  const email = str(data, "email").toLowerCase();
  const password = String(data.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };
  const ip = await clientIp();
  if (await signInBlocked(email, ip)) return { error: "Too many attempts. Wait 15 minutes, then try again." };
  const [user] = await db().select().from(schema.users).where(eq(schema.users.email, email));
  const ok = user?.passwordHash ? await verifyPassword(password, user.passwordHash) : (await verifyPassword(password, await dummyHash()), false);
  if (!ok || !user || user.status !== "active") {
    await recordSignIn(email, ip, false);
    return { error: "That email and password don't match an account." };
  }
  await recordSignIn(email, ip, true);
  await startSession(user.id);
  redirect(user.totpEnabledAt ? "/admin/login/verify" : "/admin/login/setup");
}

export async function verifyCode(_: ActionState, data: FormData): Promise<ActionState> {
  const s = await readSession();
  if (!s) redirect("/admin/login");
  const [user] = await db().select().from(schema.users).where(eq(schema.users.id, s.userId));
  if (!user?.totpSecret || !user.totpEnabledAt) redirect("/admin/login/setup");
  const ip = await clientIp();
  if (await signInBlocked(user.email, ip)) return { error: "Too many attempts. Wait 15 minutes, then try again." };
  const step = verifyTotp(decryptTotpSecret(user.id, user.totpSecret), str(data, "code"));
  if (step === null || !(await claimTotpStep(user.id, step))) {
    await recordSignIn(user.email, ip, false);
    return { error: "That code didn't work. Enter the current 6-digit code from your authenticator app." };
  }
  await completeMfa(s);
  redirect("/admin");
}

/** Creates (or keeps) the pending authenticator secret for the setup page. Returns it in plain text for the QR code. */
export async function pendingTotpSecret(): Promise<{ secret: string; email: string } | null> {
  const s = await readSession();
  if (!s || s.totpEnabled) return null;
  const [user] = await db().select().from(schema.users).where(eq(schema.users.id, s.userId));
  if (!user) return null;
  if (user.totpSecret) return { secret: decryptTotpSecret(user.id, user.totpSecret), email: user.email };
  const secret = generateTotpSecret();
  await db().update(schema.users).set({ totpSecret: encryptTotpSecret(user.id, secret) }).where(eq(schema.users.id, user.id));
  return { secret, email: user.email };
}

export async function confirmTotpSetup(_: ActionState, data: FormData): Promise<ActionState> {
  const s = await readSession();
  if (!s) redirect("/admin/login");
  if (s.totpEnabled) redirect("/admin/login/verify");
  const [user] = await db().select().from(schema.users).where(eq(schema.users.id, s.userId));
  if (!user?.totpSecret) redirect("/admin/login/setup");
  const step = verifyTotp(decryptTotpSecret(user.id, user.totpSecret), str(data, "code"));
  if (step === null || !(await claimTotpStep(user.id, step))) {
    return { error: "That code didn't work. Check the app shows Whyte Support, then enter its current code." };
  }
  await db().update(schema.users).set({ totpEnabledAt: new Date() }).where(eq(schema.users.id, user.id));
  await db().insert(schema.auditLog).values({ actorId: user.id, actorLabel: user.name, action: "user.mfa_enabled", target: user.email });
  await completeMfa(s);
  redirect("/admin");
}

async function setPassword(purpose: "invite" | "reset", data: FormData): Promise<ActionState> {
  const token = str(data, "token");
  const password = String(data.get("password") ?? "");
  const confirm = String(data.get("confirm") ?? "");
  const name = purpose === "invite" ? str(data, "name") : undefined;
  if (purpose === "invite" && !name) return { error: "Enter your name." };
  if (password !== confirm) return { error: "The two passwords don't match." };
  const email = str(data, "email");
  const problem = passwordProblem(password, email);
  if (problem) return { error: problem };
  const user = await setPasswordWithToken(token, purpose, await hashPassword(password), name).catch(() => null);
  if (!user) return { error: "This link has expired or has already been used. Ask an admin for a new one." };
  redirect("/admin/login?set=1");
}

export const acceptInvite = async (_: ActionState, data: FormData) => setPassword("invite", data);
export const resetPassword = async (_: ActionState, data: FormData) => setPassword("reset", data);

export async function forgotPassword(_: ActionState, data: FormData): Promise<ActionState> {
  const email = str(data, "email");
  if (!email) return { error: "Enter your email address." };
  const ip = await clientIp();
  if (await signInBlocked(email, ip)) return { error: "Too many attempts. Wait 15 minutes, then try again." };
  await recordSignIn(email, ip, false); // counts towards the limit, so the form can't be used to spam
  await requestPasswordReset(email, await baseUrl());
  return { notice: "If that address has an account, we've emailed a link to reset the password. It works for an hour." };
}

export async function signOut() {
  await endSession();
  redirect("/admin/login");
}
