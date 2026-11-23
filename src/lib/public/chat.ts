import "server-only";
import { and, count, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { answer, escalate, MAX_MESSAGE_CHARS, openSession, setFeedback, startSession, type Reply, type Session } from "../chat/engine";
import { db, schema } from "../db";
import { log } from "../logger";
import { allow } from "../rate-limit";
import { getSecret } from "../secrets";
import { getSettings } from "../settings";
import { fetchShopifyCustomer } from "../shopify/admin";
import { readCustomerToken } from "../shopify/proxy";
import { verifyTurnstile } from "../turnstile";
import { customerTokenKey } from "./submission";

/**
 * The public chat API's logic, kept out of the route handlers so it can be
 * tested. Every call after the first carries the session id and its token
 * (in the body, not a cookie, so it works inside other sites).
 */

type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
const fail = (status: number, error: string) => ({ ok: false as const, status, error });
const HOUR = 60 * 60 * 1000;

const Auth = z.object({ sessionId: z.string().uuid(), token: z.string().min(10).max(200) });

async function authed(body: unknown): Promise<Session | null> {
  const a = Auth.safeParse(body);
  return a.success ? openSession(a.data.sessionId, a.data.token) : null;
}

export async function chatAvailable(): Promise<boolean> {
  return Boolean(await getSecret("anthropic.api_key"));
}

const Start = z.object({
  segment: z.enum(["b2c", "b2b"]),
  turnstileToken: z.string().max(4000).optional(),
  shopifyToken: z.string().max(1000).optional(),
});

export async function startChat(body: unknown, ctx: { ip: string; origin: string }): Promise<Result<{ sessionId: string; token: string; segment: "b2c" | "b2b"; phone: string | null }>> {
  const p = Start.safeParse(body);
  if (!p.success) return fail(400, "Something was missing from the request.");
  if (!(await chatAvailable())) return fail(503, "The assistant isn't available right now.");
  if (!(await allow("chat-start-ip", ctx.ip, 20, HOUR))) return fail(429, "Too many new chats from your connection. Please try again later.");
  const turnstile = await verifyTurnstile(p.data.turnstileToken, ctx.ip);
  if (turnstile === "failed") return fail(400, "We couldn't confirm you're not a robot. Please try again.");

  // A signed-in Shopify customer is verified; anyone else is as they say. Dealer
  // articles aren't secret, so a self-declared dealer is fine, but a verified one is recorded.
  let segment = p.data.segment;
  const shopifyCustomerId = readCustomerToken(p.data.shopifyToken, customerTokenKey());
  if (shopifyCustomerId) {
    const customer = await fetchShopifyCustomer(shopifyCustomerId).catch(() => null);
    if (customer?.isDealer) segment = "b2b";
  }
  const { session, token } = await startSession({ segment, origin: ctx.origin, shopifyCustomerId });
  const s = await getSettings(["support.phone.b2c", "support.phone.b2b"]);
  return { ok: true, value: { sessionId: session.id, token, segment, phone: (segment === "b2b" ? s["support.phone.b2b"] : s["support.phone.b2c"]) || null } };
}

const Message = Auth.extend({ message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS) });

async function overDailyLimit(): Promise<boolean> {
  const limit = Number((await getSettings(["chatbot.daily_limit"]))["chatbot.daily_limit"]) || 0;
  if (limit <= 0) return false;
  const [row] = await db()
    .select({ n: count() })
    .from(schema.chatMessages)
    .where(and(eq(schema.chatMessages.role, "assistant"), gt(schema.chatMessages.createdAt, new Date(Date.now() - 24 * HOUR))));
  return (row?.n ?? 0) >= limit;
}

export async function sendChatMessage(body: unknown, ctx: { ip: string }): Promise<Result<Reply>> {
  const p = Message.safeParse(body);
  if (!p.success) return fail(400, `Messages can be up to ${MAX_MESSAGE_CHARS} characters.`);
  const session = await authed(p.data);
  if (!session) return fail(401, "This chat has expired. Please start a new one.");
  if (session.status !== "open") return fail(409, "This chat has been passed to the team. They'll reply by email.");
  if (!(await allow("chat-msg-session", session.id, 30, HOUR)) || !(await allow("chat-msg-ip", ctx.ip, 80, HOUR))) {
    return fail(429, "That's a lot of questions in a short time. Please wait a little, or send them to the team.");
  }
  if (await overDailyLimit()) {
    log.warn("Chatbot daily limit reached");
    return fail(503, "The assistant is very busy right now. Please send your question to the team instead.");
  }
  return { ok: true, value: await answer(session, p.data.message) };
}

const Feedback = Auth.extend({ messageId: z.string().uuid(), value: z.union([z.literal(1), z.literal(-1)]) });

export async function chatFeedback(body: unknown): Promise<Result<null>> {
  const p = Feedback.safeParse(body);
  if (!p.success) return fail(400, "Something was missing from the request.");
  const session = await authed(p.data);
  if (!session) return fail(401, "This chat has expired.");
  return (await setFeedback(session, p.data.messageId, p.data.value)) ? { ok: true, value: null } : fail(404, "That message isn't in this chat.");
}

const Escalate = Auth.extend({
  name: z.string().trim().min(1, "Enter your name").max(200),
  email: z.string().trim().email("Enter an email address we can reply to").max(320),
  phone: z.string().trim().max(50).optional(),
  company: z.string().trim().max(200).optional(),
  note: z.string().trim().max(5000).optional(),
});

export async function escalateChat(body: unknown, ctx: { ip: string }): Promise<Result<{ reference: string }> & { fields?: Record<string, string> }> {
  const p = Escalate.safeParse(body);
  if (!p.success) {
    const fields = Object.fromEntries(p.error.issues.filter((i) => typeof i.path[0] === "string").map((i) => [i.path[0] as string, i.message]));
    return { ...fail(400, "Please check the highlighted fields."), fields };
  }
  const session = await authed(p.data);
  if (!session) return fail(401, "This chat has expired. Please use the contact form instead.");
  if (!session.ticketId && (!(await allow("chat-escalate-ip", ctx.ip, 8, HOUR)) || !(await allow("submit-email", p.data.email, 10, 24 * HOUR)))) {
    return fail(429, "Too many requests. Please try again later.");
  }
  return { ok: true, value: await escalate(session, p.data) };
}
