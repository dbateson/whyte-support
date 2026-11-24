import { createHash } from "node:crypto";
import { TICKET_PRIORITIES, TICKET_STATUSES, type TicketPriority, type TicketSource, type TicketStatus } from "../db/schema";

/**
 * How this app's records map to Zoho CRM's. Field ownership:
 *   - This app owns a ticket's subject, status, priority and thread; they go to the Case.
 *   - Zoho owns contact and account master data (names, phones, accounts); they come back.
 * The API names used here are checked against the org's fields on Settings → Zoho.
 */
export const CASE_FIELDS = {
  subject: "Subject",
  status: "Status",
  priority: "Priority",
  origin: "Case_Origin",
  description: "Description",
  email: "Email",
  phone: "Phone",
  contact: "Related_To",
  account: "Account_Name",
  number: "Case_Number",
} as const;

export const CONTACT_FIELDS = ["First_Name", "Last_Name", "Email", "Phone", "Mobile", "Account_Name", "Modified_Time"] as const;
export const ACCOUNT_FIELDS = ["Account_Name", "Account_Number", "Account_Type", "Website", "Phone", "Modified_Time"] as const;
export const CASE_READ_FIELDS = ["Subject", "Status", "Priority", "Case_Origin", "Description", "Solution", "Email", "Phone", "Related_To", "Account_Name", "Case_Number", "Created_Time", "Modified_Time"] as const;

/** "new=New\nopen=New" → { new: "New", open: "New" }. Lines that don't parse are ignored. */
export function parseMap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([a-z_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** Problems with a status or priority map, for the settings page. */
export function mapProblems(text: string, keys: readonly string[], allowed?: string[]): string[] {
  const map = parseMap(text);
  const problems = keys.filter((k) => !map[k]).map((k) => `No Zoho value for "${k}".`);
  if (allowed?.length) for (const [k, v] of Object.entries(map)) if (!allowed.includes(v)) problems.push(`"${v}" (for ${k}) isn't one of Zoho's values: ${allowed.join(", ")}.`);
  return problems;
}

export const statusKeys = TICKET_STATUSES;
export const priorityKeys = TICKET_PRIORITIES;

/** Zoho value → our status. Several of ours can share a Zoho value; the first listed wins. */
export function reverseMap<T extends string>(text: string, keys: readonly T[]): Map<string, T> {
  const map = parseMap(text);
  const out = new Map<string, T>();
  for (const k of keys) if (map[k] && !out.has(map[k]!)) out.set(map[k]!, k);
  return out;
}

export const ORIGIN: Record<TicketSource, string> = { form: "Web", chat: "Web", email: "Email", staff: "Phone", zoho: "Phone" };

export function splitName(name: string, email: string | null): { First_Name?: string; Last_Name: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { Last_Name: email?.split("@")[0] || "Unknown" };
  if (parts.length === 1) return { Last_Name: parts[0]! };
  return { First_Name: parts.slice(0, -1).join(" "), Last_Name: parts.at(-1)! };
}

/** The Case fields this app owns, as sent. Their hash decides whether an update is needed, and spots our own echoes. */
export function ownedCaseFields(t: { subject: string; status: TicketStatus; priority: TicketPriority }, maps: { status: string; priority: string }) {
  return {
    [CASE_FIELDS.subject]: t.subject.slice(0, 255),
    [CASE_FIELDS.status]: parseMap(maps.status)[t.status] ?? "New",
    [CASE_FIELDS.priority]: parseMap(maps.priority)[t.priority] ?? "Medium",
  };
}

export function hashFields(fields: Record<string, unknown>): string {
  const sorted = Object.keys(fields)
    .sort()
    .map((k) => [k, fields[k] ?? null]);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 32);
}

/** The domain of a website, for matching dealers' email addresses: "https://www.RideShop.co.uk/" → "rideshop.co.uk". */
export function domainOf(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase();
    return host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** Personal email providers never identify a dealer. */
export const PUBLIC_EMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com", "hotmail.com", "hotmail.co.uk", "outlook.com", "live.com", "live.co.uk", "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "aol.com", "btinternet.com", "sky.com", "protonmail.com", "proton.me"]);

export const NOTE_MAX = 30_000;

/** Zoho's data centres. The client secret and refresh token are only ever sent to these. */
export const ZOHO_ACCOUNTS_DOMAINS = ["https://accounts.zoho.eu", "https://accounts.zoho.com", "https://accounts.zoho.in", "https://accounts.zoho.com.au", "https://accounts.zoho.jp", "https://accounts.zohocloud.ca", "https://accounts.zoho.uk"];
export const ZOHO_API_DOMAIN = /^https:\/\/(www\.)?zohoapis\.(eu|com|in|com\.au|jp|ca|uk)$/;
