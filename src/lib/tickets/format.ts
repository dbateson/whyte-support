import type { Segment, TicketPriority, TicketSource, TicketStatus } from "../db/schema";

export const ref = (n: number) => `WS-${n}`;

/** "WS-10234", "ws10234", "10234" → 10234 */
export function parseRef(input: string): number | null {
  const m = /^\s*(?:ws-?)?(\d{4,9})\s*$/i.exec(input);
  return m ? Number(m[1]) : null;
}

export const STATUS_LABELS: Record<TicketStatus, string> = {
  new: "New",
  open: "Open",
  pending_customer: "Waiting on customer",
  pending_internal: "Waiting on Whyte",
  resolved: "Resolved",
  closed: "Closed",
};

/** For the design system's Status dot: what needs attention reads warm, done reads green. */
export const STATUS_TONES: Record<TicketStatus, "success" | "warning" | "error" | "neutral"> = {
  new: "warning",
  open: "warning",
  pending_customer: "neutral",
  pending_internal: "neutral",
  resolved: "success",
  closed: "success",
};

export const OPEN_STATUSES: TicketStatus[] = ["new", "open", "pending_customer", "pending_internal"];

export const PRIORITY_LABELS: Record<TicketPriority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

export const SEGMENT_LABELS: Record<Segment, string> = { b2c: "B2C", b2b: "B2B" };

export const SOURCE_LABELS: Record<TicketSource, string> = {
  form: "Support form",
  chat: "Chatbot",
  email: "Email",
  zoho: "Zoho CRM",
  staff: "Staff",
};

/** Categories offered on the form and in the admin. Warranty first: most enquiries are warranty. */
export const CATEGORIES = ["Warranty", "Technical", "Order or delivery", "Parts and spares", "Returns", "Dealer account", "Other"] as const;

const dateTime = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
const dateOnly = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });

export const formatDateTime = (d: Date) => dateTime.format(d);
export const formatDate = (d: Date) => dateOnly.format(d);

/** "5 min ago", "3 h ago", "2 days ago", else the date. */
export function formatAgo(d: Date, now = new Date()): string {
  const mins = Math.round((now.getTime() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return formatDate(d);
}

/** 1.2 MB, 340 KB: as the design system's FileField shows sizes (that one is client-only). */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}
