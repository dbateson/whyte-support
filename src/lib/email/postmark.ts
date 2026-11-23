import "server-only";
import { getSecret } from "../secrets";
import { log } from "../logger";

/** Thin client for Postmark's send API. The server token is read from the encrypted store. */

export interface OutboundEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
  tag?: string;
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super("Email isn't set up: add the email server token in Settings → Integrations.");
  }
}

export class EmailSendError extends Error {}

const API = "https://api.postmarkapp.com";

async function token(): Promise<string> {
  const t = await getSecret("email.server_token");
  if (!t) throw new EmailNotConfiguredError();
  return t;
}

export async function sendEmail(email: OutboundEmail): Promise<{ providerId: string }> {
  const res = await fetch(`${API}/email`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": await token() },
    body: JSON.stringify({
      From: email.from,
      To: email.to,
      Subject: email.subject,
      TextBody: email.text,
      ReplyTo: email.replyTo,
      Tag: email.tag,
      MessageStream: "outbound",
      Headers: Object.entries(email.headers ?? {}).map(([Name, Value]) => ({ Name, Value })),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { ErrorCode?: number; Message?: string; MessageID?: string };
  if (!res.ok || (body.ErrorCode ?? 0) !== 0) {
    log.warn("Email send failed", { status: res.status, code: body.ErrorCode, message: body.Message });
    throw new EmailSendError(body.Message ? `The email provider said: ${body.Message}` : `The email provider returned ${res.status}`);
  }
  return { providerId: body.MessageID ?? "" };
}

/** For "Test connection": reads the server's details, which needs a valid token. */
export async function testEmailConnection(): Promise<string> {
  const res = await fetch(`${API}/server`, { headers: { Accept: "application/json", "X-Postmark-Server-Token": await token() } });
  if (res.status === 401) throw new EmailSendError("The email provider rejected the token.");
  if (!res.ok) throw new EmailSendError(`The email provider returned ${res.status}.`);
  const body = (await res.json()) as { Name?: string };
  return `Connected to Postmark server “${body.Name ?? "unknown"}”.`;
}
