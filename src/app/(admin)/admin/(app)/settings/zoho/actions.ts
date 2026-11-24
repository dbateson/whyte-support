"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/ActionForm";
import { requireStaff } from "@/lib/auth/session";
import { clearSecret } from "@/lib/secrets";
import { getSetting, saveSettings } from "@/lib/settings";
import { forgetAccessToken, ZohoError, ZohoNotConfiguredError, zohoConnected } from "@/lib/zoho/client";
import { cursorKey } from "@/lib/zoho/pull";
import { writeState } from "@/lib/zoho/state";
import { FIELD_API_NAME, mapProblems, priorityKeys, statusKeys } from "@/lib/zoho/mapping";
import { retryFailed, runOutbox } from "@/lib/zoho/push";
import { checkSetup, disableNotifications, disableSync, enableNotifications, enableSync, runSync, startHistory } from "@/lib/zoho/sync";

const PATH = "/admin/settings/zoho";
const fail = (err: unknown): ActionState => ({ error: err instanceof ZohoError || err instanceof ZohoNotConfiguredError || err instanceof Error ? err.message : "Something went wrong." });

async function admin() {
  const s = await requireStaff("settings.manage");
  return { id: s.id, label: s.name };
}

export async function setSyncAction(_: ActionState, data: FormData): Promise<ActionState> {
  const actor = await admin();
  try {
    if (data.get("on") === "true") {
      if (!(await zohoConnected())) return { error: "Connect Zoho first." };
      const report = await checkSetup();
      if (report.missing.length) return { error: `Zoho is missing fields this app uses: ${report.missing.map((m) => `${m.module}.${m.field}`).join(", ")}.` };
      await enableSync(actor);
      const publicUrl = await getSetting("app.public_url");
      if (publicUrl.startsWith("https://")) await enableNotifications(publicUrl).catch(() => undefined);
    } else await disableSync(actor);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(PATH);
  return { notice: data.get("on") === "true" ? "Sync is on. Dealer accounts are coming in now." : "Sync is off." };
}

export async function saveMappingAction(_: ActionState, data: FormData): Promise<ActionState> {
  const actor = await admin();
  const status = String(data.get("zoho.status_map") ?? "").trim();
  const priority = String(data.get("zoho.priority_map") ?? "").trim();
  const dealer = String(data.get("zoho.dealer_account_types") ?? "").trim().slice(0, 500);
  const notesForKb = data.get("zoho.notes_for_kb") === "on" ? "true" : "false";
  const numberField = String(data.get("zoho.account_number_field") ?? "").trim();
  if (numberField && !FIELD_API_NAME.test(numberField)) return { error: "The account number field should be a Zoho API name, like Account_Number (letters, numbers and underscores)." };
  const problems = [...mapProblems(status, statusKeys), ...mapProblems(priority, priorityKeys)];
  if (problems.length) return { error: problems.join(" ") };
  const fieldChanged = numberField !== (await getSetting("zoho.account_number_field")).trim();
  await saveSettings({ "zoho.status_map": status, "zoho.priority_map": priority, "zoho.dealer_account_types": dealer, "zoho.notes_for_kb": notesForKb, "zoho.account_number_field": numberField }, actor);
  // A different field means every account needs reading again: the next sync re-imports them.
  if (fieldChanged) await writeState(cursorKey("Accounts"), { since: "2000-01-01T00:00:00Z", page: 1 });
  revalidatePath(PATH);
  return { notice: "Saved. Dealer types and the account number field apply as accounts next change in Zoho; run Check now to confirm the field exists." };
}

export async function checkSetupAction(): Promise<ActionState> {
  await admin();
  try {
    const r = await checkSetup();
    revalidatePath(PATH);
    if (r.missing.length || r.problems.length) return { error: "Zoho's setup needs attention: see the check below." };
    return { notice: "Zoho has every field and value this app uses." };
  } catch (err) {
    return fail(err);
  }
}

export async function runNowAction(): Promise<ActionState> {
  await admin();
  const publicUrl = (await getSetting("app.public_url")) || null;
  const r = await runSync(Date.now() + 45_000, publicUrl);
  revalidatePath(PATH);
  if (r.error) return { error: r.error };
  const pulled = Object.values(r.pulled).reduce((a, b) => a + (b ?? 0), 0);
  return { notice: `Sent ${r.sent}${r.failed ? `, ${r.failed} failed` : ""}; checked ${pulled} records from Zoho.` };
}

export async function retryAction(): Promise<ActionState> {
  await admin();
  const n = await retryFailed();
  const r = await runOutbox({ deadline: Date.now() + 30_000 });
  revalidatePath(PATH);
  return { notice: `Retried ${n}: ${r.sent} sent${r.failed ? `, ${r.failed} still failing` : ""}.` };
}

export async function historyAction(_: ActionState, data: FormData): Promise<ActionState> {
  const actor = await admin();
  const feedKb = data.get("feedKb") === "on";
  await startHistory(actor, { feedKb });
  revalidatePath(PATH);
  return {
    notice: `History import started. It runs in the background, a few minutes at a time.${feedKb ? " Closed cases are queued for the knowledge base: drafts appear under Knowledge base → Review." : ""}`,
  };
}

export async function notificationsAction(_: ActionState, data: FormData): Promise<ActionState> {
  await admin();
  try {
    if (data.get("on") === "true") {
      const publicUrl = await getSetting("app.public_url");
      await enableNotifications(publicUrl);
    } else await disableNotifications();
  } catch (err) {
    return fail(err);
  }
  revalidatePath(PATH);
  return { notice: data.get("on") === "true" ? "Zoho will tell this app about changes straight away." : "Notifications are off; changes arrive every 15 minutes." };
}

export async function disconnectAction(): Promise<ActionState> {
  const actor = await admin();
  await disableSync(actor);
  await clearSecret("zoho.refresh_token", actor);
  await forgetAccessToken();
  revalidatePath(PATH);
  return { notice: "Disconnected. The client ID and secret are kept; connect again any time." };
}
