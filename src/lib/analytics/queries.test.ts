import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, useTestDatabase } from "@/test/db";

const { breakdowns, experience, parseRange, previousRange, summary, topics, unansweredQuestions, uncovered, volume, topicAdvice } = await import("./queries");
const { createArticle, publish } = await import("../kb/service");

describe("ranges", () => {
  it("defaults to the last 90 days and steps back by the same length", () => {
    const r = parseRange({}, new Date("2026-11-23T12:00:00Z"));
    expect(r).toEqual({ from: "2026-08-26", to: "2026-11-23", segment: undefined });
    expect(previousRange({ from: "2026-11-01", to: "2026-11-30" })).toEqual({ from: "2026-10-02", to: "2026-10-31" });
    expect(parseRange({ from: "2026-12-01", to: "2026-11-01", segment: "b2b" })).toEqual({ from: "2026-11-01", to: "2026-11-01", segment: "b2b" });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("analytics", () => {
  const { sql, reset } = useTestDatabase();
  const r = { from: "2026-11-01", to: "2026-11-30" };

  beforeEach(async () => {
    await reset();
    const a = await createArticle({ title: "Frame warranty", audience: "b2c", body: "Frames are covered for five years." }, { label: "T" });
    await publish(a.article.id, { label: "T" });
    const [c1] = await sql`insert into contacts (email, name) values ('a@example.com', 'A') returning id`;
    const [c2] = await sql`insert into contacts (email, name) values ('b@example.com', 'B') returning id`;
    const t = (subject: string, segment: string, category: string, product: string | null, created: string, extra = sql``) =>
      sql`insert into tickets (segment, subject, source, category, product_model, contact_id, reply_token, created_at, first_response_at, resolved_at, status)
          values (${segment}, ${subject}, 'form', ${category}, ${product}, ${segment === "b2c" ? c1!.id : c2!.id}, 'x', ${created}::timestamptz,
            ${created}::timestamptz + interval '2 hours', ${created}::timestamptz + interval '30 hours', 'resolved') ${extra}`;
    await t("Frame warranty claim for a crack", "b2c", "Warranty", "905 2024", "2026-11-03T10:00:00Z");
    await t("Warranty on my frame", "b2c", "Warranty", "905, 2023", "2026-11-04T10:00:00Z");
    await t("Where is my order", "b2c", "Order or delivery", null, "2026-11-05T10:00:00Z");
    await t("Trade account invoice", "b2b", "Dealer account", "T-160", "2026-11-06T10:00:00Z");
    await t("Old one", "b2c", "Warranty", null, "2026-10-15T10:00:00Z");
    // Chats: one answered from the article, one unanswered twice, one escalated.
    const chat = async (outcomes: [string, string][], escalate = false) => {
      const [s] = await sql`insert into chat_sessions (token_hash, segment, created_at, message_count) values ('h', 'b2c', '2026-11-10T10:00:00Z', ${outcomes.length * 2}) returning id`;
      for (const [q, o] of outcomes) {
        await sql`insert into chat_messages (session_id, role, content, created_at) values (${s!.id}, 'user', ${q}, '2026-11-10T10:00:00Z')`;
        const [m] = await sql`insert into chat_messages (session_id, role, content, outcome, created_at) values (${s!.id}, 'assistant', 'reply', ${o}, '2026-11-10T10:00:01Z') returning id`;
        if (o === "answered") await sql`insert into chat_answer_sources (message_id, article_id, heading, content, rank, cited) values (${m!.id}, ${a.article.id}, 'Frame warranty', 'x', 1, true)`;
      }
      if (escalate) {
        const [tk] = await sql`select id from tickets limit 1`;
        await sql`update chat_sessions set ticket_id = ${tk!.id} where id = ${s!.id}`;
      }
    };
    await chat([["Is my frame covered?", "answered"]]);
    await chat([["Do you ship to Norway?", "no_answer"]]);
    await chat([["do you ship to norway", "no_answer"]], true);
  });
  afterAll(async () => {
    await sql.end();
  });

  it("sums up tickets and chats in the range", async () => {
    expect(await summary(r)).toEqual({ tickets: 4, firstResponseHours: 2, respondedWithinDay: 1, resolutionHours: 30, chats: 3, answeredByBot: 1 / 3, unanswered: 2 });
    expect((await summary({ ...r, segment: "b2b" })).tickets).toBe(1);
  });

  it("buckets volume by day, with every day present", async () => {
    const v = await volume(r);
    expect(v.granularity).toBe("day");
    expect(v.data).toHaveLength(30);
    expect(v.data.find((d) => d.bucket === "2026-11-03")).toEqual({ bucket: "2026-11-03", b2c: 1, b2b: 0, chats: 0 });
    expect(v.data.find((d) => d.bucket === "2026-11-10")!.chats).toBe(3);
  });

  it("breaks tickets down by category, bike and source", async () => {
    const b = await breakdowns(r);
    expect(b.category[0]).toEqual({ label: "Warranty", value: 2 });
    expect(b.product).toEqual([
      { label: "905", value: 2 },
      { label: "T-160", value: 1 },
    ]);
    expect(b.source).toEqual([{ label: "form", value: 4 }]);
  });

  it("finds topics, unanswered questions and tickets no article covers", async () => {
    const t = await topics(r);
    expect(t).toEqual([expect.objectContaining({ title: "Frame warranty", tickets: 2, chats: 1, escalated: 0, unhelpful: 0 })]);
    expect(topicAdvice(t[0]!)).toBe("Watch");
    expect(await unansweredQuestions(r)).toEqual([expect.objectContaining({ times: 2, last: "2026-11-10" })]);
    expect(await uncovered(r)).toEqual([
      { label: "Dealer account", value: 1 },
      { label: "Order or delivery", value: 1 },
    ]);
  });

  it("reports repeat customers", async () => {
    expect(await experience(r)).toMatchObject({ repeatCustomers: 1, customers: 2, reopened: 0 });
  });
});
