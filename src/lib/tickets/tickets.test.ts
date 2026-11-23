import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_DATABASE_URL, useTestDatabase } from "@/test/db";
import { fileInboundEmail } from "../email/inbound";
import { getThread, listTickets, parseQueueFilters, queueCounts } from "./queries";
import { addCustomerMessage, addStaffMessage, createTicket, updateTicket } from "./service";

describe.skipIf(!TEST_DATABASE_URL)("tickets", () => {
  const { sql, reset } = useTestDatabase();
  const staff = { id: "00000000-0000-4000-8000-000000000001", label: "Jo Smith" };

  beforeEach(async () => {
    await reset();
    await sql`insert into users (id, email, name, status) values (${staff.id}, 'jo@whyte.test', 'Jo Smith', 'active')`;
  });
  afterAll(async () => {
    await sql.end();
  });

  const newTicket = (over: Partial<Parameters<typeof createTicket>[0]> = {}) =>
    createTicket(
      {
        segment: "b2c",
        subject: "Cracked rear triangle",
        body: "There's a hairline crack by the dropout after 14 months.",
        source: "form",
        contact: { email: "Jane@Example.com", name: "Jane Doe" },
        firstMessageFrom: "customer",
        channel: "web",
        frameNumber: "WB12345",
        ...over,
      },
      { label: "Support form" },
    );

  it("creates a ticket with its contact, first message and numbering", async () => {
    const t = await newTicket();
    const t2 = await newTicket({ subject: "Second" });
    expect(t.number).toBe(10001);
    expect(t2.number).toBe(10002);
    expect(t.status).toBe("new");
    const contacts = await sql`select email, name from contacts`;
    expect(contacts).toHaveLength(1); // the same email reuses the contact
    expect(contacts[0]).toMatchObject({ email: "jane@example.com", name: "Jane Doe" });
    const thread = await getThread(t.id);
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ kind: "message", message: { authorType: "customer", authorName: "Jane Doe" } });
  });

  it("searches and filters within the viewer's segments", async () => {
    await newTicket();
    await newTicket({ segment: "b2b", subject: "Dealer order missing", body: "Order 4471 hasn't arrived", contact: { email: "shop@dealer.test", name: "Ride Shop" }, frameNumber: null });
    const all = { id: staff.id, segments: ["b2c", "b2b"] as ("b2c" | "b2b")[] };
    const b2bOnly = { id: staff.id, segments: ["b2b"] as ("b2c" | "b2b")[] };
    const f = (q: Record<string, string>) => parseQueueFilters(q);

    expect((await listTickets(f({}), all)).total).toBe(2);
    expect((await listTickets(f({}), b2bOnly)).rows.map((r) => r.subject)).toEqual(["Dealer order missing"]);
    expect((await listTickets(f({ segment: "b2c" }), b2bOnly)).total).toBe(0);
    expect((await listTickets(f({ q: "hairline crack" }), all)).rows.map((r) => r.number)).toEqual([10001]);
    expect((await listTickets(f({ q: "WB12345" }), all)).total).toBe(1);
    expect((await listTickets(f({ q: "WS-10002" }), all)).rows[0]?.subject).toBe("Dealer order missing");
    expect((await listTickets(f({ q: "jane" }), all)).total).toBe(1);
    expect((await listTickets(f({ q: "4471" }), b2bOnly)).total).toBe(1);
    expect((await listTickets(f({ q: "hairline" }), b2bOnly)).total).toBe(0);
  });

  it("logs changes as events and keeps resolution timestamps in step", async () => {
    const t = await newTicket();
    const resolved = await updateTicket(t, { status: "resolved", priority: "high", assigneeId: staff.id }, staff, () => "Jo Smith");
    expect(resolved.resolvedAt).not.toBeNull();
    const events = await sql`select type, from_value, to_value from ticket_events where type <> 'created' order by id`;
    expect(events.map((e) => [e.type, e.to_value])).toEqual([
      ["status", "Resolved"],
      ["priority", "High"],
      ["assignee", "Jo Smith"],
    ]);
    const reopened = await updateTicket(resolved, { status: "open" }, staff);
    expect(reopened.resolvedAt).toBeNull();
    expect(await updateTicket(reopened, { status: "open" }, staff)).toBe(reopened); // no change, no event
  });

  it("keeps internal notes off email and records why a reply wasn't sent", async () => {
    const t = await newTicket();
    const note = await addStaffMessage(t, { body: "Check the serial", internal: true }, staff);
    expect(note.message).toMatchObject({ internal: true, channel: "staff", emailStatus: null });
    expect(note.emailError).toBeUndefined();

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const reply = await addStaffMessage(t, { body: "Could you send photos?", internal: false, statusAfter: "pending_customer" }, staff);
    expect(fetchSpy).not.toHaveBeenCalled(); // no sender configured, so nothing leaves
    expect(reply.emailError).toMatch(/sender address/);
    const [m] = await sql`select email_status, email_message_id from ticket_messages where id = ${reply.message.id}`;
    expect(m).toMatchObject({ email_status: "failed" });
    expect(m!.email_message_id).toMatch(/^<ws-10001-[0-9a-f-]{36}@/);
    const [after] = await sql`select status, first_response_at from tickets where id = ${t.id}`;
    expect(after!.status).toBe("pending_customer");
    expect(after!.first_response_at).not.toBeNull();
    fetchSpy.mockRestore();
  });

  it("reopens a resolved ticket when the customer writes again", async () => {
    const t = await newTicket();
    const resolved = await updateTicket(t, { status: "resolved" }, staff);
    await addCustomerMessage(resolved, { body: "It's cracked again", authorName: "Jane Doe", channel: "email" });
    const [after] = await sql`select status, resolved_at from tickets where id = ${t.id}`;
    expect(after).toMatchObject({ status: "open", resolved_at: null });
    const [ev] = await sql`select type from ticket_events where type = 'reopened'`;
    expect(ev).toBeTruthy();
  });

  it("counts the queue for the overview", async () => {
    const t = await newTicket();
    await newTicket();
    await updateTicket(t, { assigneeId: staff.id, status: "pending_customer" }, staff);
    expect(await queueCounts({ id: staff.id, segments: ["b2c", "b2b"] })).toEqual({ open: 2, unassigned: 1, mine: 1, waitingOnUs: 1 });
    expect(await queueCounts({ id: staff.id, segments: ["b2b"] })).toEqual({ open: 0, unassigned: 0, mine: 0, waitingOnUs: 0 });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("inbound email", () => {
  const { sql, reset } = useTestDatabase();
  beforeEach(reset);
  afterAll(async () => {
    await sql.end();
  });

  const base = { FromFull: { Email: "jane@example.com", Name: "Jane Doe" }, Subject: "Re: [WS-10001] Cracked rear triangle", TextBody: "Photos attached.\n\nOn Tue, Whyte wrote:\n> Could you send photos?" };

  async function ticket() {
    return createTicket(
      { segment: "b2c", subject: "Cracked rear triangle", body: "Help", source: "form", contact: { email: "jane@example.com", name: "Jane" }, firstMessageFrom: "customer", channel: "web" },
      { label: "Support form" },
    );
  }

  it("files a reply by its reply-to key, keeping only the new text", async () => {
    const t = await ticket();
    const r = await fileInboundEmail({ ...base, MailboxHash: `t${t.number}-${t.replyToken}`, Subject: "anything", Headers: [{ Name: "Message-ID", Value: "<a1@mail>" }] });
    expect(r).toEqual({ outcome: "added", ticketNumber: 10001 });
    const msgs = await sql`select body, author_type from ticket_messages where ticket_id = ${t.id} order by created_at`;
    expect(msgs.at(-1)).toMatchObject({ body: "Photos attached.", author_type: "customer" });
  });

  it("matches the subject reference only for the ticket's own contact", async () => {
    await ticket();
    expect(await fileInboundEmail({ ...base, Headers: [{ Name: "Message-ID", Value: "<a2@mail>" }] })).toEqual({ outcome: "added", ticketNumber: 10001 });
    const spoof = await fileInboundEmail({ ...base, FromFull: { Email: "someone@else.test" }, Headers: [{ Name: "Message-ID", Value: "<a3@mail>" }] });
    expect(spoof.outcome).toBe("created");
    expect(spoof.ticketNumber).toBe(10002);
  });

  it("ignores duplicates and auto-replies, and starts new tickets", async () => {
    const first = await fileInboundEmail({ FromFull: { Email: "new@rider.test" }, Subject: "Fwd: Brake rub", TextBody: "My brakes rub", Headers: [{ Name: "Message-ID", Value: "<n1@mail>" }] });
    expect(first.outcome).toBe("created");
    const [t] = await sql`select subject, source from tickets where number = ${first.ticketNumber!}`;
    expect(t).toMatchObject({ subject: "Brake rub", source: "email" });
    expect((await fileInboundEmail({ FromFull: { Email: "new@rider.test" }, TextBody: "again", Headers: [{ Name: "Message-ID", Value: "<n1@mail>" }] })).outcome).toBe("duplicate");
    expect((await fileInboundEmail({ FromFull: { Email: "x@y.test" }, TextBody: "away", Headers: [{ Name: "Auto-Submitted", Value: "auto-replied" }] })).outcome).toBe("ignored");
    expect((await fileInboundEmail({ FromFull: { Email: "mailer-daemon@y.test" }, TextBody: "bounce" })).outcome).toBe("ignored");
  });
});
