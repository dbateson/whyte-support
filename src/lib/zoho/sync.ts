import "server-only";
import { randomBytes } from "node:crypto";
import { lt, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { log } from "../logger";
import { getSecret, setSecret, type Actor } from "../secrets";
import { getSettings, saveSettings } from "../settings";
import { zoho, zohoConnected } from "./client";
import { ACCOUNT_FIELDS, CASE_FIELDS, CASE_READ_FIELDS, CONTACT_FIELDS, mapProblems, priorityKeys, statusKeys } from "./mapping";
import { advanceTicketJob } from "../ingest/pipeline";
import { cursorKey, pullModule, type Module } from "./pull";
import { runOutbox, syncEnabled } from "./push";
import { clearState, logSync, readState, writeState } from "./state";

/* ---------- Switching sync on and off ---------- */

export async function enableSync(actor: Actor) {
  const now = new Date().toISOString();
  // All dealer accounts come in (to recognise dealers); contacts and cases from now on.
  await writeState(cursorKey("Accounts"), { since: "2000-01-01T00:00:00Z", page: 1 });
  for (const m of ["Contacts", "Cases"] as const) if (!(await readState(cursorKey(m)))) await writeState(cursorKey(m), { since: now, page: 1 });
  await saveSettings({ "zoho.sync_enabled": "true" }, actor);
  await logSync({ direction: "out", entity: "sync", message: `Sync switched on by ${actor.label}.` });
}

export async function disableSync(actor: Actor) {
  await saveSettings({ "zoho.sync_enabled": "false" }, actor);
  await disableNotifications().catch(() => undefined);
  await logSync({ direction: "out", entity: "sync", message: `Sync switched off by ${actor.label}. Changes made meanwhile are not queued.` });
}

/* ---------- The 15-minute run ---------- */

export interface RunResult {
  sent: number;
  failed: number;
  pulled: Partial<Record<Module | "history", number>>;
  error?: string;
}

/** Sends queued changes, pulls what changed in Zoho, carries on any history import, and renews notifications. */
export async function runSync(deadline: number, publicUrl: string | null): Promise<RunResult> {
  const result: RunResult = { sent: 0, failed: 0, pulled: {} };
  if (!(await syncEnabled()) || !(await zohoConnected())) return result;
  try {
    Object.assign(result, await runOutbox({ deadline: Math.min(deadline, Date.now() + 60_000) }));
    for (const m of ["Accounts", "Contacts", "Cases"] as const) {
      if (Date.now() >= deadline) break;
      result.pulled[m] = (await pullModule(m, cursorKey(m), deadline)).applied;
    }
    if (Date.now() < deadline) result.pulled.history = await historyStep(deadline);
    if (publicUrl) await renewNotifications(publicUrl);
    // Spare time goes on drafting knowledge-base articles from closed cases.
    await advanceTicketJob(Math.min(deadline - Date.now() - 10_000, 120_000));
    await writeState("zoho.last_run", { at: new Date().toISOString(), ...result });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    log.error("Zoho sync run failed", { err });
    await logSync({ direction: "in", entity: "reconcile", level: "error", message: `Sync run stopped: ${result.error}` });
    await writeState("zoho.last_run", { at: new Date().toISOString(), ...result });
  }
  return result;
}

export async function purgeSyncLog() {
  await db().delete(schema.syncLog).where(lt(schema.syncLog.at, sql`now() - interval '30 days'`));
}

/* ---------- History: every past case, once ---------- */

interface History {
  status: "running" | "done";
  /** Closed cases also go to the knowledge base, to be drafted into articles for review. */
  feedKb?: boolean;
  startedAt: string;
  finishedAt?: string;
  applied: number;
}
const HISTORY_CURSOR = "zoho.history.cursor";

export async function startHistory(actor: Actor, opts: { feedKb: boolean } = { feedKb: true }) {
  await writeState(HISTORY_CURSOR, { since: "2000-01-01T00:00:00Z", page: 1 });
  await writeState("zoho.history", { status: "running", startedAt: new Date().toISOString(), applied: 0, feedKb: opts.feedKb } satisfies History);
  await logSync({ direction: "in", entity: "history", message: `History import started by ${actor.label}.` });
}

export async function historyStatus(): Promise<History | null> {
  return readState<History>("zoho.history");
}

async function historyStep(deadline: number): Promise<number> {
  const h = await historyStatus();
  if (h?.status !== "running") return 0;
  const r = await pullModule("Cases", HISTORY_CURSOR, deadline, { history: true, feedKb: h.feedKb !== false });
  const next: History = { ...h, applied: h.applied + r.applied, ...(r.done ? { status: "done", finishedAt: new Date().toISOString() } : {}) };
  await writeState("zoho.history", next);
  if (r.done) {
    await clearState(HISTORY_CURSOR);
    await logSync({ direction: "in", entity: "history", message: `History import finished: ${next.applied} cases checked.` });
  }
  return r.applied;
}

/* ---------- Notifications (Zoho tells us at once when something changes) ---------- */

interface Channel {
  id: number;
  expiresAt: string;
  notifyUrl: string;
}
const CHANNEL_DAYS = 6; // Zoho allows up to a week

export const notifyUrlFor = (publicUrl: string) => `${publicUrl.replace(/\/$/, "")}/api/zoho/notify`;

async function watchBody(channelId: number, notifyUrl: string) {
  let token = await getSecret("zoho.webhook_token");
  if (!token) {
    token = randomBytes(30).toString("base64url"); // 40 characters; Zoho allows 50
    await setSecret("zoho.webhook_token", token, { label: "Zoho sync" });
  }
  const expiry = new Date(Date.now() + CHANNEL_DAYS * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  return {
    body: { watch: [{ channel_id: channelId, events: ["Cases.all", "Contacts.all", "Accounts.all"], channel_expiry: expiry, token, notify_url: notifyUrl, notify_on_related_action: true }] },
    expiry,
  };
}

export async function enableNotifications(publicUrl: string): Promise<Channel> {
  if (!/^https:\/\//.test(publicUrl)) throw new Error("Zoho can only notify an https address. Set the support site's address in Settings → General.");
  const existing = await readState<Channel>("zoho.channel");
  const id = existing?.id ?? Number(`${Date.now()}`.slice(-12));
  const notifyUrl = notifyUrlFor(publicUrl);
  const { body, expiry } = await watchBody(id, notifyUrl);
  await zoho(existing ? "PUT" : "POST", "/actions/watch", { body });
  const channel = { id, expiresAt: expiry, notifyUrl };
  await writeState("zoho.channel", channel);
  await logSync({ direction: "out", entity: "notifications", message: `Zoho notifications on until ${expiry.slice(0, 10)}.` });
  return channel;
}

/** Renews the channel when it has less than two days left (or its address changed). */
export async function renewNotifications(publicUrl: string) {
  const ch = await readState<Channel>("zoho.channel");
  if (!ch) return;
  const left = new Date(ch.expiresAt).getTime() - Date.now();
  if (left > 2 * 24 * 60 * 60 * 1000 && ch.notifyUrl === notifyUrlFor(publicUrl)) return;
  await enableNotifications(publicUrl);
}

export async function disableNotifications() {
  const ch = await readState<Channel>("zoho.channel");
  if (!ch) return;
  await zoho("DELETE", "/actions/watch", { query: { channel_ids: String(ch.id) } }).catch((err) => log.warn("Couldn't switch Zoho notifications off", { err }));
  await clearState("zoho.channel");
}

export async function notificationChannel() {
  return readState<Channel>("zoho.channel");
}

/* ---------- Setup check: do the fields and picklist values this app uses exist? ---------- */

interface FieldMeta {
  api_name: string;
  pick_list_values?: { display_value?: string; actual_value?: string; type?: string }[];
}

export interface SetupReport {
  missing: { module: string; field: string }[];
  picklists: Record<string, string[]>;
  problems: string[];
}

export async function checkSetup(): Promise<SetupReport> {
  const want: Record<string, readonly string[]> = {
    Cases: [...CASE_READ_FIELDS],
    Contacts: CONTACT_FIELDS,
    Accounts: ACCOUNT_FIELDS,
  };
  const report: SetupReport = { missing: [], picklists: {}, problems: [] };
  for (const [module, fields] of Object.entries(want)) {
    const res = await zoho<{ fields: FieldMeta[] }>("GET", "/settings/fields", { query: { module } });
    const have = new Map((res?.fields ?? []).map((f) => [f.api_name, f]));
    for (const f of fields) if (!have.has(f) && f !== "Modified_Time" && f !== "Created_Time") report.missing.push({ module, field: f });
    if (module === "Cases") {
      for (const f of [CASE_FIELDS.status, CASE_FIELDS.priority, CASE_FIELDS.origin]) {
        report.picklists[f] = (have.get(f)?.pick_list_values ?? []).filter((v) => v.type !== "unused").map((v) => v.actual_value ?? v.display_value ?? "").filter(Boolean);
      }
    }
  }
  const s = await getSettings(["zoho.status_map", "zoho.priority_map"]);
  report.problems.push(...mapProblems(s["zoho.status_map"], statusKeys, report.picklists[CASE_FIELDS.status]));
  report.problems.push(...mapProblems(s["zoho.priority_map"], priorityKeys, report.picklists[CASE_FIELDS.priority]));
  const origins = report.picklists[CASE_FIELDS.origin] ?? [];
  for (const o of ["Web", "Email", "Phone"]) if (origins.length && !origins.includes(o)) report.problems.push(`Case Origin has no "${o}" value; cases from that channel will be refused.`);
  await writeState("zoho.setup_report", { at: new Date().toISOString(), ...report });
  return report;
}
