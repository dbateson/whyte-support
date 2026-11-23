import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_DATABASE_URL, useTestDatabase } from "@/test/db";

const parse = vi.fn();
vi.mock("../ai/client", () => ({ anthropic: async () => ({ messages: { parse } }) }));

const { chatFeedback, escalateChat, sendChatMessage, startChat } = await import("./chat");
const { setSecret } = await import("../secrets");
const { saveSettings } = await import("../settings");

const ok = { stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 }, parsed_output: { outcome: "no_answer", reply: "I can't find that.", cited: [], escalationReason: "", details: { product: null, frameNumber: null, orderNumber: null } } };

describe.skipIf(!TEST_DATABASE_URL)("public chat API", () => {
  const { sql, reset } = useTestDatabase();
  const ctx = { ip: "203.0.113.9", origin: "https://www.whytebikes.com" };

  beforeEach(async () => {
    await reset();
    parse.mockReset().mockResolvedValue(ok);
  });
  afterAll(async () => {
    await sql.end();
  });

  const begin = async () => {
    const r = await startChat({ segment: "b2c" }, ctx);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };

  it("is off until the Anthropic key is set", async () => {
    expect(await startChat({ segment: "b2c" }, ctx)).toMatchObject({ ok: false, status: 503 });
    await setSecret("anthropic.api_key", "sk-ant-test", { label: "T" });
    const s = await begin();
    expect(s.segment).toBe("b2c");
    expect(s.token.length).toBeGreaterThan(20);
  });

  it("needs the session's token for every call", async () => {
    await setSecret("anthropic.api_key", "sk-ant-test", { label: "T" });
    const s = await begin();
    expect(await sendChatMessage({ sessionId: s.sessionId, token: "x".repeat(32), message: "hi" }, ctx)).toMatchObject({ ok: false, status: 401 });
    const r = await sendChatMessage({ sessionId: s.sessionId, token: s.token, message: "Is my frame covered?" }, ctx);
    expect(r).toMatchObject({ ok: true, value: { outcome: "no_answer", offerTicket: true } });
    if (!r.ok) return;
    expect(await chatFeedback({ sessionId: s.sessionId, token: s.token, messageId: r.value.messageId, value: -1 })).toEqual({ ok: true, value: null });
    expect(await sendChatMessage({ sessionId: s.sessionId, token: s.token, message: "x".repeat(2001) }, ctx)).toMatchObject({ ok: false, status: 400 });
  });

  it("stops answering past the daily limit", async () => {
    await setSecret("anthropic.api_key", "sk-ant-test", { label: "T" });
    await saveSettings({ "chatbot.daily_limit": "1" }, { label: "T" });
    const s = await begin();
    expect((await sendChatMessage({ sessionId: s.sessionId, token: s.token, message: "one" }, ctx)).ok).toBe(true);
    expect(await sendChatMessage({ sessionId: s.sessionId, token: s.token, message: "two" }, ctx)).toMatchObject({ ok: false, status: 503 });
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("hands over to the team once, then stops the chat", async () => {
    await setSecret("anthropic.api_key", "sk-ant-test", { label: "T" });
    const s = await begin();
    await sendChatMessage({ sessionId: s.sessionId, token: s.token, message: "My frame has cracked" }, ctx);
    const bad = await escalateChat({ sessionId: s.sessionId, token: s.token, name: "", email: "nope" }, ctx);
    expect(bad).toMatchObject({ ok: false, status: 400, fields: { name: "Enter your name", email: "Enter an email address we can reply to" } });
    const first = await escalateChat({ sessionId: s.sessionId, token: s.token, name: "Jane", email: "jane@example.com" }, ctx);
    expect(first).toEqual({ ok: true, value: { reference: "WS-10001" } });
    expect(await escalateChat({ sessionId: s.sessionId, token: s.token, name: "Jane", email: "jane@example.com" }, ctx)).toEqual({ ok: true, value: { reference: "WS-10001" } });
    expect((await sql`select count(*)::int as n from tickets`)[0]!.n).toBe(1);
    expect(await sendChatMessage({ sessionId: s.sessionId, token: s.token, message: "more" }, ctx)).toMatchObject({ ok: false, status: 409 });
  });
});
