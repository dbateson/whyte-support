import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_DATABASE_URL, useTestDatabase } from "@/test/db";

const parse = vi.fn();
vi.mock("../ai/client", () => ({ anthropic: async () => ({ messages: { parse } }) }));

const { answer, escalate, openSession, setFeedback, startSession } = await import("./engine");
const { createArticle, publish } = await import("../kb/service");
const { saveSettings } = await import("../settings");

const reply = (over: Record<string, unknown> = {}) => ({
  stop_reason: "end_turn",
  usage: { input_tokens: 900, output_tokens: 80 },
  parsed_output: { outcome: "answered", reply: "Yes, frames are covered for five years.", cited: ["P1"], escalationReason: "", details: { product: null, frameNumber: null, orderNumber: null }, ...over },
});

describe.skipIf(!TEST_DATABASE_URL)("chat engine", () => {
  const { sql, reset } = useTestDatabase();
  let riderArticle = "";
  let dealerArticle = "";

  beforeEach(async () => {
    await reset();
    parse.mockReset();
    const r = await createArticle({ title: "Frame warranty", audience: "b2c", body: "Whyte frames are covered against manufacturing defects for five years. Send photos of the crack and the frame number." }, { label: "T" });
    await publish(r.article.id, { label: "T" });
    riderArticle = r.article.id;
    const d = await createArticle({ title: "Dealer warranty claims", audience: "b2b", body: "Dealers lodge frame warranty claims through the trade portal with photos and the frame number." }, { label: "T" });
    await publish(d.article.id, { label: "T" });
    dealerArticle = d.article.id;
    await saveSettings({ "support.phone.b2c": "01234 567890" }, { label: "T" });
  });
  afterAll(async () => {
    await sql.end();
  });

  it("answers from the knowledge base, cites its source and keeps every passage it was given", async () => {
    parse.mockResolvedValue(reply());
    const { session } = await startSession({ segment: "b2c", origin: "https://www.whytebikes.com/products/905" });
    const r = await answer(session, "Is a cracked frame covered by warranty?");
    expect(r).toMatchObject({ outcome: "answered", offerTicket: false, phone: "01234 567890", reply: "Yes, frames are covered for five years." });
    expect(r.sources).toEqual([{ title: "Frame warranty", articleId: riderArticle, url: `/help/${riderArticle}` }]);

    const call = parse.mock.calls[0]![0];
    expect(call.model).toBe("claude-haiku-5-5");
    expect(call.system).toContain("a rider");
    const userText = call.messages.at(-1).content as string;
    expect(userText).toContain('<passage label="P1" title="Frame warranty">');
    expect(userText).not.toContain("trade portal"); // a rider never sees dealer passages

    const sources = await sql`select heading, cited, rank, version_id is not null as pinned from chat_answer_sources`;
    expect(sources).toEqual([{ heading: "Frame warranty", cited: true, rank: 1, pinned: true }]);
    const [m] = await sql`select outcome, input_tokens, output_tokens, latency_ms is not null as timed from chat_messages where role = 'assistant'`;
    expect(m).toMatchObject({ outcome: "answered", input_tokens: 900, output_tokens: 80, timed: true });
  });

  it("refuses to pass off an answer with no real citation", async () => {
    parse.mockResolvedValue(reply({ cited: ["P9"], reply: "Frames have a lifetime warranty." }));
    const { session } = await startSession({ segment: "b2c", origin: "" });
    const r = await answer(session, "Is a cracked frame covered?");
    expect(r.outcome).toBe("no_answer");
    expect(r.reply).toMatch(/can't find that/);
    expect(r.reply).not.toContain("lifetime");
    expect(r.offerTicket).toBe(true);
    expect(r.sources).toEqual([]);
    expect((await sql`select count(*)::int as n from chat_answer_sources where cited`)[0]!.n).toBe(0);
  });

  it("falls back to a ticket on refusals and errors", async () => {
    const { session } = await startSession({ segment: "b2c", origin: "" });
    parse.mockResolvedValueOnce({ stop_reason: "refusal", usage: { input_tokens: 1, output_tokens: 1 }, parsed_output: null });
    expect((await answer(session, "something odd")).outcome).toBe("declined");
    parse.mockRejectedValueOnce(new Error("overloaded"));
    const r = await answer(session, "frame warranty?");
    expect(r).toMatchObject({ outcome: "error", offerTicket: true });
  });

  it("gives dealers dealer passages and sends the conversation so far", async () => {
    parse.mockResolvedValue(reply({ reply: "Use the trade portal.", outcome: "needs_human", escalationReason: "Dealer warranty claim" }));
    const { session } = await startSession({ segment: "b2b", origin: "" });
    await answer(session, "How do we lodge a frame warranty claim?");
    const r = await answer(session, "And what if the customer has no receipt?");
    expect(r).toMatchObject({ outcome: "needs_human", offerTicket: true, phone: null });
    expect(r.sources[0]).toMatchObject({ articleId: dealerArticle, url: null }); // dealer articles get no public link
    const second = parse.mock.calls[1]![0];
    expect(second.system).toContain("a dealer or trade customer");
    expect(second.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second.messages.at(-1).content).toContain("trade portal");
  });

  it("turns a conversation into a ticket with the transcript and what the bot picked up", async () => {
    parse.mockResolvedValue(
      reply({ outcome: "needs_human", reply: "The team will need to assess it.", details: { product: "905, 2024", frameNumber: "WB12345", orderNumber: null } }),
    );
    const { session } = await startSession({ segment: "b2c", origin: "" });
    await answer(session, "My 905 frame WB12345 has cracked at the dropout");
    const r = await escalate(session, { name: "Jane Doe", email: "Jane@Example.com", note: "Photos to follow" });
    expect(r.reference).toBe("WS-10001");
    const [t] = await sql`select source, segment, category, subject, product_model, frame_number from tickets`;
    expect(t).toEqual({ source: "chat", segment: "b2c", category: "Warranty", subject: "My 905 frame WB12345 has cracked at the dropout", product_model: "905, 2024", frame_number: "WB12345" });
    const [m] = await sql`select body, channel from ticket_messages`;
    expect(m!.channel).toBe("chat");
    expect(m!.body).toMatch(/^Photos to follow\n\n---\n\nChat with the assistant:\n\nCustomer: My 905 frame/);
    expect(m!.body).toContain("Assistant: The team will need to assess it.");
    expect(m!.body).toContain("Articles the assistant used: Frame warranty");
    // Escalating again returns the same ticket.
    const [s] = await sql`select status from chat_sessions`;
    expect(s!.status).toBe("escalated");
    const fresh = (await openSession(session.id, "wrong"))!;
    expect(fresh).toBeNull();
  });

  it("checks session tokens and only takes feedback on its own replies", async () => {
    parse.mockResolvedValue(reply());
    const a = await startSession({ segment: "b2c", origin: "" });
    const b = await startSession({ segment: "b2c", origin: "" });
    expect((await openSession(a.session.id, a.token))?.id).toBe(a.session.id);
    expect(await openSession(a.session.id, b.token)).toBeNull();
    const r = await answer(a.session, "frame warranty");
    expect(await setFeedback(b.session, r.messageId, 1)).toBe(false);
    expect(await setFeedback(a.session, r.messageId, -1)).toBe(true);
    expect((await sql`select feedback from chat_messages where id = ${r.messageId}`)[0]!.feedback).toBe(-1);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("chat retention", () => {
  const { sql, reset } = useTestDatabase();
  beforeEach(reset);
  afterAll(async () => {
    await sql.end();
  });

  it("deletes conversations idle for 12 months, with their messages and sources", async () => {
    const { purgeOldChats } = await import("./engine");
    const old = await startSession({ segment: "b2c", origin: "" });
    const recent = await startSession({ segment: "b2c", origin: "" });
    await sql`insert into chat_messages (session_id, role, content) values (${old.session.id}, 'user', 'hello')`;
    await sql`update chat_sessions set last_message_at = now() - interval '13 months' where id = ${old.session.id}`;
    expect(await purgeOldChats()).toBe(1);
    expect((await sql`select id from chat_sessions`).map((r) => r.id)).toEqual([recent.session.id]);
    expect((await sql`select count(*)::int as n from chat_messages`)[0]!.n).toBe(0);
  });
});
