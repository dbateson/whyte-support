import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Reply routing. Outbound ticket mail has Reply-To <inbound>+<key>@<domain>,
 * where key = t<number>-<reply token>. The provider hands us the part after
 * "+" (Postmark's MailboxHash), which names the ticket without being guessable.
 */

export function mailboxKey(ticketNumber: number, replyToken: string): string {
  return `t${ticketNumber}-${replyToken}`;
}

export function parseMailboxKey(key: string | undefined | null): { number: number; replyToken: string } | null {
  const m = /^t(\d{4,9})-([A-Za-z0-9_-]{8,64})$/.exec((key ?? "").trim());
  return m ? { number: Number(m[1]), replyToken: m[2]! } : null;
}

/** <hash>@inbound.postmarkapp.com + key → <hash>+key@inbound.postmarkapp.com */
export function replyToAddress(inboundAddress: string, key: string): string | undefined {
  const at = inboundAddress.lastIndexOf("@");
  if (at < 1) return undefined;
  return `${inboundAddress.slice(0, at)}+${key}${inboundAddress.slice(at)}`;
}

/** Our Message-ID for an outbound ticket message, so replies' In-Reply-To finds the ticket too. */
export function messageIdFor(ticketNumber: number, messageId: string, domain = "support.whytebikes.com"): string {
  return `<ws-${ticketNumber}-${messageId}@${domain}>`;
}

export function ticketNumberFromMessageId(header: string | undefined | null): number | null {
  const m = /<ws-(\d{4,9})-[0-9a-f-]{36}@[^>]+>/i.exec(header ?? "");
  return m ? Number(m[1]) : null;
}

/** Constant-time comparison for webhook credentials. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", "cmp").update(a).digest();
  const hb = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Keeps the new part of an emailed reply: drops quoted history ("On ... wrote:",
 * "> " lines, Outlook's "From: ... Sent:" block) and a trailing signature marker.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1] ?? "";
    if (/^On .+wrote:\s*$/i.test(line) || /^On .+/i.test(line) && /wrote:\s*$/i.test(next)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^_{5,}\s*$/.test(line) && /^From:/i.test(next)) break;
    if (/^From:\s.+/i.test(line) && /^(Sent|Date):\s/i.test(next)) break;
    if (/^-- ?$/.test(line)) break;
    if (/^>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}
