import PostalMime from "postal-mime";
import { parse as parseHtml } from "node-html-parser";
import { parse as parseCsv } from "csv-parse/sync";
import { stripQuotedReply } from "../email/addresses";
import { redact } from "./redact";

/* ---------- Email ---------- */

export interface ParsedEmail {
  messageId: string;
  /** The oldest Message-ID it refers to, or its own. */
  threadKey: string;
  /** The subject without Re:/Fwd: and our reference, for joining replies whose clients dropped the headers. */
  subjectKey: string;
  subject: string;
  date: string | null;
  fromStaff: boolean;
  /** Redacted, quoted history removed. */
  text: string;
}

const normaliseSubject = (s: string) => s.replace(/^\s*((re|fw|fwd|aw|sv)\s*:\s*)+/i, "").replace(/\[WS-\d+\]\s*/i, "").trim().toLowerCase();

/** Ids in a References/In-Reply-To header, oldest first. */
const idsIn = (h: string | undefined) => (h ?? "").match(/<[^<>\s]+>/g) ?? [];

/**
 * Parses one RFC 822 message. staffDomains: whose messages are Whyte's
 * replies (e.g. whytebikes.com). Threads are joined later, by reference and
 * by subject (see assembleThreads).
 */
export async function parseEmail(raw: string | Uint8Array, staffDomains: string[]): Promise<ParsedEmail | null> {
  const email = await PostalMime.parse(raw);
  const fromAddress = (email.from && "address" in email.from ? email.from.address : "") ?? "";
  const domain = fromAddress.split("@")[1]?.toLowerCase() ?? "";
  const fromStaff = staffDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
  const body = email.text ?? (email.html ? htmlToText(email.html).text : "");
  const text = redact(stripQuotedReply(body));
  if (!text) return null;
  const messageId = email.messageId ?? `<no-id-${hashCode(`${email.subject}|${email.date}|${text.slice(0, 200)}`)}>`;
  const root = idsIn(email.references)[0] ?? idsIn(email.inReplyTo)[0];
  const subject = (email.subject ?? "").trim();
  return {
    messageId,
    threadKey: root ?? messageId,
    subjectKey: normaliseSubject(subject),
    subject,
    date: email.date ?? null,
    fromStaff,
    text,
  };
}

/** Splits mbox text into messages. Returns them and the unfinished tail (to prepend to the next read). */
export function splitMbox(chunk: string, final: boolean): { messages: string[]; rest: string } {
  const parts = chunk.split(/^From [^\n]*\n/m);
  const head = parts.shift() ?? "";
  // Anything before the first "From " line belongs to the previous read's last message.
  const messages = parts.map((m) => m.replace(/^>(>*From )/gm, "$1"));
  if (head.trim() && messages.length === 0 && !final) return { messages: [], rest: chunk };
  if (final) return { messages: head.trim() ? [head, ...messages] : messages, rest: "" };
  const rest = messages.length ? `From -\n${messages.pop()!}` : chunk;
  return { messages: head.trim() ? [head, ...messages] : messages, rest };
}

function hashCode(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/* ---------- Zoho CRM cases (CSV export) ---------- */

export interface ParsedCase {
  externalId: string;
  title: string;
  text: string;
  /** "b2b" when the case belongs to an account (a dealer), else unknown. */
  audienceHint: "b2b" | null;
}

const pick = (row: Record<string, string>, names: string[]) => {
  for (const n of names) {
    const key = Object.keys(row).find((k) => k.trim().toLowerCase() === n);
    if (key && row[key]?.trim()) return row[key]!.trim();
  }
  return "";
};

/** Reads a Zoho CRM Cases export. Columns are matched by their usual names; missing ones are skipped. */
export function parseZohoCases(csv: string): ParsedCase[] {
  const rows = parseCsv(csv, { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true, trim: false }) as Record<string, string>[];
  const out: ParsedCase[] = [];
  for (const row of rows) {
    const id = pick(row, ["case number", "case id", "record id", "id"]);
    const subject = pick(row, ["subject", "case subject"]);
    const description = pick(row, ["description", "case description"]);
    const answer = [pick(row, ["solution", "resolution"]), pick(row, ["internal comments", "comments", "add comment"])].filter(Boolean).join("\n\n");
    if (!id || (!description && !answer)) continue;
    const meta = [pick(row, ["type", "case type", "case reason"]), pick(row, ["product name", "product"]), pick(row, ["status"])].filter(Boolean).join(" · ");
    out.push({
      externalId: id,
      title: subject,
      text: redact([`Subject: ${subject}`, meta && `Details: ${meta}`, `Customer:\n${description}`, answer && `Whyte:\n${answer}`].filter(Boolean).join("\n\n")),
      audienceHint: pick(row, ["account name", "account"]) ? "b2b" : null,
    });
  }
  return out;
}

/* ---------- Web pages ---------- */

const DROP = "script,style,noscript,svg,iframe,nav,header,footer,form,button,template,[aria-hidden=true],.visually-hidden,.cart,.announcement-bar,#shopify-section-header,#shopify-section-footer";

/** The readable text of a page: title and main content, without menus, scripts and footers. */
export function htmlToText(html: string): { title: string; text: string } {
  const root = parseHtml(html, { blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  const title = (root.querySelector("h1")?.text || root.querySelector("title")?.text || "").replace(/\s+/g, " ").trim();
  root.querySelectorAll(DROP).forEach((n) => n.remove());
  const main = root.querySelector("main") ?? root.querySelector("article") ?? root.querySelector("body") ?? root;
  // Block elements become line breaks so headings and paragraphs stay apart.
  main.querySelectorAll("h1,h2,h3,h4,p,li,tr,br,div,section").forEach((n) => n.insertAdjacentHTML("afterend", "\n"));
  const text = main.text
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
  return { title, text };
}

/** URLs in a sitemap (or the child sitemaps of a sitemap index). */
export function parseSitemap(xml: string): { pages: string[]; sitemaps: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
  return /<sitemapindex/i.test(xml) ? { pages: [], sitemaps: locs } : { pages: locs, sitemaps: [] };
}
