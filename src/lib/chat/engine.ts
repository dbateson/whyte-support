import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { anthropic } from "../ai/client";
import { db, schema } from "../db";
import type { ChatOutcome, Segment } from "../db/schema";
import { sendAcknowledgement } from "../email/acknowledgement";
import { searchKb } from "../kb/queries";
import { log } from "../logger";
import { getSettings } from "../settings";
import { createTicketWithMessage } from "../tickets/service";
import { Answer, systemPrompt, userTurn, type Passage } from "./prompt";

export const MAX_MESSAGE_CHARS = 2000;
const HISTORY_TURNS = 12;
const PASSAGES = 6;

/** Who the person is for routing: a self-declared dealer's hand-off goes to the dealer team. */
const handOffSegment = (s: Session): Segment => ((s.details as { requestedSegment?: Segment }).requestedSegment ?? s.segment);

const hashToken = (t: string) => createHash("sha256").update(`chat:${t}`).digest("hex");

export type Session = typeof schema.chatSessions.$inferSelect;

/**
 * `segment` decides which articles the assistant may use (b2b only for verified dealers);
 * `requestedSegment` is who the person said they are, for the hand-off and the phone number.
 */
export async function startSession(input: { segment: Segment; origin: string; shopifyCustomerId?: string | null; requestedSegment?: Segment }): Promise<{ session: Session; token: string }> {
  const token = randomBytes(24).toString("base64url");
  const [session] = await db()
    .insert(schema.chatSessions)
    .values({
      tokenHash: hashToken(token),
      segment: input.segment,
      origin: input.origin.slice(0, 300),
      shopifyCustomerId: input.shopifyCustomerId ?? null,
      details: input.requestedSegment && input.requestedSegment !== input.segment ? { requestedSegment: input.requestedSegment } : {},
    })
    .returning();
  return { session: session!, token };
}

/** The session, if the token matches it. */
export async function openSession(id: string, token: string): Promise<Session | null> {
  if (!/^[0-9a-f-]{36}$/.test(id) || !token) return null;
  const [s] = await db().select().from(schema.chatSessions).where(eq(schema.chatSessions.id, id));
  if (!s) return null;
  const a = Buffer.from(s.tokenHash);
  const b = Buffer.from(hashToken(token));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  // A chat left for a day is over: a new one starts (the transcript stays for staff).
  if (Date.now() - s.lastMessageAt.getTime() > 24 * 60 * 60 * 1000) return null;
  return s;
}

export interface ReplySource {
  title: string;
  articleId: string;
  /** A public page for the article, when it's not dealer-only. */
  url: string | null;
}

export interface Reply {
  messageId: string;
  reply: string;
  outcome: ChatOutcome;
  sources: ReplySource[];
  /** Offer to raise a support request (the main way to a person). */
  offerTicket: boolean;
  /** A phone number, as the second way to a person, when one is set for this segment. */
  phone: string | null;
}

const fallback = {
  no_answer: "I can't find that in our help articles, so I'd rather not guess. I can pass your question to the team: they'll reply by email.",
  error: "Sorry, I'm having trouble answering right now. I can pass your question to the team instead: they'll reply by email.",
  declined: "I can't help with that one here, but the team can. I can pass your question to them: they'll reply by email.",
};

/**
 * One turn: search the knowledge base, ask Claude for an answer grounded in
 * what was found, check its citations, and store the reply with every
 * passage it was given (cited or not), so each answer can be traced.
 */
export async function answer(session: Session, question: string): Promise<Reply> {
  const text = question.trim().slice(0, MAX_MESSAGE_CHARS);
  const started = Date.now();
  const history = await db()
    .select({ role: schema.chatMessages.role, content: schema.chatMessages.content })
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.sessionId, session.id))
    .orderBy(desc(schema.chatMessages.createdAt))
    .limit(HISTORY_TURNS);
  history.reverse();

  await db().insert(schema.chatMessages).values({ sessionId: session.id, role: "user", content: text });

  // Search with the previous question too, so a follow-up ("what about e-bikes?") keeps its subject.
  const previousQuestion = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  const hits = await searchKb(`${text} ${previousQuestion}`.slice(0, 500), session.segment, PASSAGES).catch((err) => {
    log.error("Chat search failed", { err });
    return [];
  });
  const passages: Passage[] = hits.map((h, i) => ({ label: `P${i + 1}`, heading: h.heading, content: h.content }));

  const s = await getSettings(["chatbot.model", "support.phone.b2c", "support.phone.b2b"]);
  const phone = (handOffSegment(session) === "b2b" ? s["support.phone.b2b"] : s["support.phone.b2c"]) || null;

  let outcome: ChatOutcome;
  let reply: string;
  let cited = new Set<string>();
  let usage: { input?: number; output?: number } = {};
  let details: Answer["details"] | null = null;
  try {
    const client = await anthropic();
    const messages: Anthropic.MessageParam[] = [...history.map((m) => ({ role: m.role, content: m.content }) as Anthropic.MessageParam), { role: "user", content: userTurn(text, passages) }];
    // The API needs the conversation to start with the customer.
    while (messages[0]?.role === "assistant") messages.shift();
    const response = await client.messages.parse({
      model: s["chatbot.model"],
      max_tokens: 2000,
      system: systemPrompt(session.segment),
      messages,
      output_config: { effort: "low", format: zodOutputFormat(Answer) },
    });
    usage = { input: response.usage.input_tokens, output: response.usage.output_tokens };
    const parsed = response.parsed_output;
    if (response.stop_reason === "refusal") {
      outcome = "declined";
      reply = fallback.declined;
    } else if (!parsed) {
      outcome = "error";
      reply = fallback.error;
    } else {
      const given = new Set(passages.map((p) => p.label));
      cited = new Set(parsed.cited.filter((c) => given.has(c)));
      details = parsed.details;
      outcome = parsed.outcome;
      reply = parsed.reply.trim();
      // An answer must rest on a passage it was given; otherwise it's not an answer.
      if ((outcome === "answered" || outcome === "partial") && cited.size === 0) {
        log.warn("Chat answer without valid citations replaced", { session: session.id, claimed: parsed.cited });
        outcome = "no_answer";
        reply = fallback.no_answer;
      }
      if (!reply) {
        outcome = "no_answer";
        reply = fallback.no_answer;
      }
    }
  } catch (err) {
    log.error("Chat answer failed", { err, session: session.id });
    outcome = "error";
    reply = fallback.error;
  }

  const [message] = await db()
    .insert(schema.chatMessages)
    .values({
      sessionId: session.id,
      role: "assistant",
      content: reply.slice(0, 6000),
      outcome,
      model: s["chatbot.model"],
      inputTokens: usage.input ?? null,
      outputTokens: usage.output ?? null,
      latencyMs: Date.now() - started,
    })
    .returning();
  if (hits.length) {
    await db()
      .insert(schema.chatAnswerSources)
      .values(hits.map((h, i) => ({ messageId: message!.id, articleId: h.articleId, versionId: h.versionId, heading: h.heading, content: h.content, rank: i + 1, score: h.score.toFixed(5), cited: cited.has(`P${i + 1}`) })));
  }
  await db()
    .update(schema.chatSessions)
    .set({ messageCount: sql`${schema.chatSessions.messageCount} + 2`, lastMessageAt: new Date() })
    .where(eq(schema.chatSessions.id, session.id));
  if (details) await rememberDetails(session.id, details);

  const sources = await sourcesFor(hits.filter((_, i) => cited.has(`P${i + 1}`)).map((h) => h.articleId));
  return { messageId: message!.id, reply, outcome, sources, offerTicket: outcome !== "answered", phone };
}

/** Details the customer mentioned, kept on the session for the ticket if they escalate. */
async function rememberDetails(sessionId: string, d: Answer["details"]) {
  const clean = Object.fromEntries(Object.entries(d).filter(([, v]) => v && v.trim()));
  if (Object.keys(clean).length === 0) return;
  await db()
    .update(schema.chatSessions)
    .set({ details: sql`${schema.chatSessions.details} || ${JSON.stringify(clean)}::jsonb` })
    .where(eq(schema.chatSessions.id, sessionId));
}

async function sourcesFor(articleIds: string[]): Promise<ReplySource[]> {
  const unique = [...new Set(articleIds)];
  if (unique.length === 0) return [];
  const rows = await db()
    .select({ id: schema.kbArticles.id, audience: schema.kbArticles.audience, title: schema.kbArticleVersions.title })
    .from(schema.kbArticles)
    .innerJoin(schema.kbArticleVersions, eq(schema.kbArticleVersions.id, schema.kbArticles.publishedVersionId))
    .where(inArray(schema.kbArticles.id, unique));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return unique
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map((r) => ({ title: r.title, articleId: r.id, url: r.audience === "b2b" ? null : `/help/${r.id}` }));
}

export async function setFeedback(session: Session, messageId: string, value: 1 | -1): Promise<boolean> {
  const updated = await db()
    .update(schema.chatMessages)
    .set({ feedback: value })
    .where(and(eq(schema.chatMessages.id, messageId), eq(schema.chatMessages.sessionId, session.id), eq(schema.chatMessages.role, "assistant")))
    .returning({ id: schema.chatMessages.id });
  return updated.length === 1;
}

const CATEGORY_HINTS: [RegExp, string][] = [
  [/warrant|crack|broken|snapped|defect/i, "Warranty"],
  [/order|deliver|parcel|tracking|dispatch/i, "Order or delivery"],
  [/return|refund|exchange/i, "Returns"],
  [/spare|part|hanger|bearing|bolt/i, "Parts and spares"],
  [/account|trade|dealer|invoice/i, "Dealer account"],
];

/**
 * Turns the conversation into a support ticket: the customer's note, then the
 * transcript with the articles the bot used. Details the bot picked up (model,
 * frame number, order number) fill the ticket's fields.
 */
export async function escalate(session: Session, input: { name: string; email: string; phone?: string | null; company?: string | null; note?: string | null }): Promise<{ reference: string }> {
  if (session.ticketId) {
    const [t] = await db().select({ number: schema.tickets.number }).from(schema.tickets).where(eq(schema.tickets.id, session.ticketId));
    if (t) return { reference: `WS-${t.number}` };
  }
  const messages = await db().select().from(schema.chatMessages).where(eq(schema.chatMessages.sessionId, session.id)).orderBy(asc(schema.chatMessages.createdAt));
  const firstQuestion = messages.find((m) => m.role === "user")?.content ?? "Chat enquiry";
  const cited = messages.length
    ? await db()
        .selectDistinct({ heading: schema.chatAnswerSources.heading })
        .from(schema.chatAnswerSources)
        .where(and(inArray(schema.chatAnswerSources.messageId, messages.map((m) => m.id)), eq(schema.chatAnswerSources.cited, true)))
    : [];
  const [fresh] = await db().select({ details: schema.chatSessions.details }).from(schema.chatSessions).where(eq(schema.chatSessions.id, session.id));
  const d = (fresh?.details ?? {}) as { product?: string; frameNumber?: string; orderNumber?: string };
  const transcript = messages.map((m) => `${m.role === "user" ? "Customer" : "Assistant"}: ${m.content}`).join("\n\n");
  const body = [
    input.note?.trim() ? input.note.trim() : null,
    `Chat with the assistant:\n\n${transcript}`,
    cited.length ? `Articles the assistant used: ${cited.map((c) => c.heading).join("; ")}` : null,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
  const category = CATEGORY_HINTS.find(([re]) => re.test(`${firstQuestion} ${input.note ?? ""}`))?.[1] ?? null;
  const { ticket } = await createTicketWithMessage(
    {
      segment: handOffSegment(session),
      subject: firstQuestion.replace(/\s+/g, " ").slice(0, 120),
      body,
      source: "chat",
      category,
      contact: { email: input.email, name: input.name, phone: input.phone ?? null, companyName: input.company ?? null, shopifyCustomerId: session.shopifyCustomerId },
      productModel: d.product ?? null,
      frameNumber: d.frameNumber ?? null,
      orderNumber: d.orderNumber ?? null,
      firstMessageFrom: "customer",
      channel: "chat",
    },
    { label: "Chatbot" },
  );
  await db().update(schema.chatSessions).set({ status: "escalated", ticketId: ticket.id }).where(eq(schema.chatSessions.id, session.id));
  await sendAcknowledgement(ticket, { name: input.name, email: input.email }, 0);
  return { reference: `WS-${ticket.number}` };
}

/** GDPR: conversations are kept for 12 months (a ticket made from one keeps its own copy). */
export async function purgeOldChats(): Promise<number> {
  const gone = await db()
    .delete(schema.chatSessions)
    .where(sql`${schema.chatSessions.lastMessageAt} < now() - interval '12 months'`)
    .returning({ id: schema.chatSessions.id });
  return gone.length;
}
