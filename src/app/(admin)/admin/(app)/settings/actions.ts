"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/ActionForm";
import { testAnthropicConnection } from "@/lib/ai/client";
import { isPermission } from "@/lib/auth/permissions";
import { requireStaff } from "@/lib/auth/session";
import { createInviteLink, deleteRole, inviteUser, resetUserMfa, saveRole, setUserDisabled, setUserRoles } from "@/lib/auth/users";
import { testEmailConnection } from "@/lib/email/postmark";
import { testVoyageConnection } from "@/lib/kb/embeddings";
import { SETTINGS, isSecretName, type SettingKey } from "@/lib/integrations";
import { log } from "@/lib/logger";
import { baseUrl } from "@/lib/request";
import { clearSecret, setSecret } from "@/lib/secrets";
import { getSetting, saveSettings } from "@/lib/settings";

const str = (d: FormData, k: string) => String(d.get(k) ?? "").trim();

/* ---------- Integrations ---------- */

export async function saveSecretAction(_: ActionState, data: FormData): Promise<ActionState> {
  const staff = await requireStaff("settings.manage");
  const name = str(data, "name");
  if (!isSecretName(name)) return { error: "Unknown setting." };
  const value = String(data.get("value") ?? "");
  if (!value.trim()) return { error: "Paste the value first." };
  if (value.length > 4000) return { error: "That's longer than any key we expect." };
  await setSecret(name, value, { id: staff.id, label: staff.name });
  revalidatePath("/admin/settings/integrations");
  return { notice: "Saved and encrypted.", done: Date.now() };
}

export async function clearSecretAction(_: ActionState, data: FormData): Promise<ActionState> {
  const staff = await requireStaff("settings.manage");
  const name = str(data, "name");
  if (!isSecretName(name)) return { error: "Unknown setting." };
  await clearSecret(name, { id: staff.id, label: staff.name });
  revalidatePath("/admin/settings/integrations");
  return { notice: "Cleared." };
}

export async function testConnectionAction(_: ActionState, data: FormData): Promise<ActionState> {
  await requireStaff("settings.manage");
  try {
    switch (str(data, "integration")) {
      case "anthropic":
        return { notice: await testAnthropicConnection(await getSetting("chatbot.model")) };
      case "email":
        return { notice: await testEmailConnection() };
      case "voyage":
        return { notice: await testVoyageConnection() };
      default:
        return { error: "There's no test for this yet." };
    }
  } catch (err) {
    log.warn("Connection test failed", { integration: str(data, "integration"), err });
    return { error: err instanceof Error ? err.message : "The test failed." };
  }
}

/* ---------- General ---------- */

export async function saveGeneralAction(_: ActionState, data: FormData): Promise<ActionState> {
  const staff = await requireStaff("settings.manage");
  const values: Partial<Record<SettingKey, string>> = {};
  for (const key of Object.keys(SETTINGS) as SettingKey[]) {
    if (data.has(key)) values[key] = str(data, key).slice(0, 500);
  }
  for (const key of ["storage.supabase_url"] as const) {
    if (values[key] && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(values[key]!)) return { error: "The Supabase URL should look like https://abcd.supabase.co" };
  }
  if (values["embed.allowed_origins"]) {
    const bad = values["embed.allowed_origins"].split(",").map((o) => o.trim()).filter((o) => o && !/^https?:\/\/[^\s/]+$/.test(o));
    if (bad.length) return { error: `These aren't site addresses (like https://www.whytebikes.com, no path): ${bad.join(", ")}` };
  }
  if (values["shopify.shop_domain"] && !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(values["shopify.shop_domain"]!)) {
    return { error: "The shop domain should be the .myshopify.com one, e.g. whyte-bikes.myshopify.com" };
  }
  for (const key of ["app.public_url"] as const) {
    if (values[key] && !/^https?:\/\/[^\s/]+$/.test(values[key]!.replace(/\/$/, ""))) return { error: "The site address should look like https://support.whytebikes.com" };
  }
  for (const key of ["email.from_address", "email.inbound_address"] as const) {
    if (values[key] && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values[key]!)) return { error: "Check the email addresses: one doesn't look right." };
  }
  await saveSettings(values, { id: staff.id, label: staff.name });
  revalidatePath("/admin/settings/general");
  return { notice: "Saved." };
}

/* ---------- Users ---------- */

export async function inviteUserAction(_: ActionState, data: FormData): Promise<ActionState> {
  const staff = await requireStaff("users.manage");
  const email = str(data, "email").toLowerCase();
  const name = str(data, "name");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "Enter a valid email address." };
  if (!name) return { error: "Enter their name." };
  const roleIds = data.getAll("roles").map(String);
  let result: Awaited<ReturnType<typeof inviteUser>>;
  try {
    result = await inviteUser({ email, name, roleIds }, { id: staff.id, label: staff.name }, await baseUrl());
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't invite them." };
  }
  revalidatePath("/admin/settings/users");
  return {
    notice: result.emailed ? `Invitation emailed to ${email}.` : `${name} is added. Email isn't set up, so send them this link yourself.`,
    reveal: result.emailed ? undefined : { label: "Invitation link (shown once, valid for 7 days)", value: result.link },
    done: Date.now(),
  };
}

export async function saveUserRolesAction(_: ActionState, data: FormData): Promise<ActionState> {
  const staff = await requireStaff("users.manage");
  const userId = str(data, "userId");
  try {
    await setUserRoles(userId, data.getAll("roles").map(String), { id: staff.id, label: staff.name });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't save." };
  }
  revalidatePath(`/admin/settings/users/${userId}`);
  return { notice: "Roles saved." };
}

export async function userAccessAction(_: ActionState, data: FormData): Promise<ActionState> {
  const staff = await requireStaff("users.manage");
  const userId = str(data, "userId");
  const intent = str(data, "intent");
  const actor = { id: staff.id, label: staff.name };
  if (userId === staff.id && intent === "disable") return { error: "You can't disable your own account." };
  try {
    if (intent === "disable") await setUserDisabled(userId, true, actor);
    else if (intent === "enable") await setUserDisabled(userId, false, actor);
    else if (intent === "reset-mfa") await resetUserMfa(userId, actor);
    else if (intent === "resend") {
      const link = await createInviteLink(userId, await baseUrl());
      revalidatePath(`/admin/settings/users/${userId}`);
      return { notice: "Earlier links for this person no longer work.", reveal: { label: "New invitation link (shown once, valid for 7 days)", value: link } };
    } else return { error: "Unknown action." };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't do that." };
  }
  revalidatePath(`/admin/settings/users/${userId}`);
  const done: Record<string, string> = {
    disable: "Disabled. Their sessions have ended.",
    enable: "Enabled.",
    "reset-mfa": "Authenticator reset. They'll set it up again at their next sign-in.",
  };
  return { notice: done[intent] };
}

/* ---------- Roles ---------- */

export async function saveRoleAction(_: ActionState, data: FormData): Promise<ActionState> {
  const staff = await requireStaff("users.manage");
  const name = str(data, "name");
  if (!name) return { error: "Give the role a name." };
  const permissions = data.getAll("permissions").map(String).filter(isPermission);
  const segments = data.getAll("segments").map(String).filter((s) => s === "b2c" || s === "b2b");
  if (segments.length === 0) return { error: "Choose at least one segment." };
  const id = str(data, "id") || undefined;
  let saved: string;
  try {
    saved = await saveRole({ id, name, description: str(data, "description"), permissions, segments }, { id: staff.id, label: staff.name });
  } catch (err) {
    const msg = err instanceof Error && /unique/i.test(err.message) ? "There's already a role with that name." : err instanceof Error ? err.message : "Couldn't save.";
    return { error: msg };
  }
  revalidatePath("/admin/settings/roles");
  if (!id) redirect(`/admin/settings/roles/${saved}`);
  return { notice: "Saved." };
}

export async function deleteRoleAction(_: ActionState, data: FormData): Promise<ActionState> {
  const staff = await requireStaff("users.manage");
  try {
    await deleteRole(str(data, "id"), { id: staff.id, label: staff.name });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't delete." };
  }
  redirect("/admin/settings/roles");
}
