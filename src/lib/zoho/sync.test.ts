import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeZoho } from "@/test/fake-zoho";
import { TEST_DATABASE_URL, useTestDatabase } from "@/test/db";

const { setSecret } = await import("../secrets");
const { saveSettings } = await import("../settings");
const { createTicketWithMessage, updateTicket, addStaffMessage } = await import("../tickets/service");
const { runOutbox } = await import("./push");
const { pullModule, cursorKey, applyNotified } = await import("./pull");
const { enableSync, checkSetup } = await import("./sync");
const { exchangeCode } = await import("./client");

const admin = { label: "Test" };
const deadline = () => Date.now() + 20_000;

describe.skipIf(!TEST_DATABASE_URL)("Zoho sync", () => {
  const { sql, reset } = useTestDatabase();
  let zoho: FakeZoho;
  let restore: () => void;

  beforeEach(async () => {
    await reset();
    zoho = new FakeZoho();
    restore = zoho.install();
    await setSecret("zoho.client_id", "client-id", admin);
    await setSecret("zoho.client_secret", "client-secret", admin);
    await setSecret("zoho.refresh_token", "refresh-token", admin);
  });
  afterEach(() => restore());
  afterAll(async () => {
    await sql.end();
  });

  const newTicket = (over: Record<string, unknown> = {}) =>
    createTicketWithMessage(
      {
        segment: "b2c",
        subject: "Cracked frame",
        body: "My frame has a crack by the dropout.",
        source: "form",
        category: "Warranty",
        contact: { email: "jane@example.com", name: "Jane Doe", phone: "07700 900123" },
        frameNumber: "WB12345",
        firstMessageFrom: "customer",
        channel: "web",
        ...over,
      },
      { label: "Customer" },
    );
  const outbox = async () => (await sql`select entity, attempts from sync_outbox`).map((r) => `${r.entity}:${r.attempts}`);

  it("queues nothing until sync is switched on", async () => {
    await newTicket();
    expect(await outbox()).toEqual([]);
  });

  it("sends a ticket as a case, its first message as the description, and later messages as notes", async () => {
    await enableSync(admin);
    const { ticket } = await newTicket();
    expect(await outbox()).toEqual(["ticket:0"]);
    expect(await runOutbox({ deadline: deadline() })).toEqual({ sent: 1, failed: 0 });

    const contact = [...zoho.modules.Contacts!.values()][0]!;
    expect(contact).toMatchObject({ First_Name: "Jane", Last_Name: "Doe", Email: "jane@example.com" });
    const kase = [...zoho.modules.Cases!.values()][0]!;
    expect(kase).toMatchObject({ Subject: "Cracked frame", Status: "New", Priority: "Medium", Case_Origin: "Web", Related_To: { id: contact.id }, Email: "jane@example.com" });
    expect(kase.Description).toMatch(/^WS-10001 · Rider · Warranty\nFrame number: WB12345\n\nMy frame has a crack/);
    expect(zoho.calls.find((c) => c.method === "POST" && c.path === "/Cases")!.body).toMatchObject({ trigger: [] });
    const [t] = await sql`select zoho_case_id, zoho_case_number from tickets`;
    expect(t).toEqual({ zoho_case_id: kase.id, zoho_case_number: kase.Case_Number });
    expect(zoho.notes.size).toBe(0);
    expect(await outbox()).toEqual([]);

    // A reply goes as a note; a status change updates the case.
    const [fresh] = await sql`select * from tickets`;
    await addStaffMessage({ ...ticket, zohoCaseId: fresh!.zoho_case_id }, { body: "Please send photos.", internal: false }, { id: undefined as never, label: "Jo Smith" }).catch(() => undefined);
    await updateTicket(ticket, { status: "pending_customer" }, admin);
    await runOutbox({ deadline: deadline() });
    expect([...zoho.notes.values()].map((n) => [n.Note_Title, n.Note_Content])).toEqual([["Reply from Jo Smith", "Please send photos."]]);
    expect(zoho.modules.Cases!.get(kase.id)!.Status).toBe("On Hold");

    // Nothing changed: no further writes.
    const writes = zoho.writes().length;
    await sql`insert into sync_outbox (entity, entity_id) values ('ticket', ${ticket.id})`;
    await runOutbox({ deadline: deadline() });
    expect(zoho.writes().length).toBe(writes);
  });

  it("links to an existing Zoho contact by email instead of creating one", async () => {
    const existing = zoho.add("Contacts", { Last_Name: "Doe", First_Name: "Jane", Email: "JANE@example.com" });
    await enableSync(admin);
    await newTicket();
    await runOutbox({ deadline: deadline() });
    expect(zoho.modules.Contacts!.size).toBe(1);
    expect((await sql`select zoho_contact_id from contacts`)[0]!.zoho_contact_id).toBe(existing.id);
  });

  it("retries with backoff when Zoho fails, and caches one access token", async () => {
    await enableSync(admin);
    await newTicket();
    zoho.failNext = { status: 500, code: "INTERNAL_ERROR", times: 1 };
    expect(await runOutbox({ deadline: deadline() })).toEqual({ sent: 0, failed: 1 });
    const [row] = await sql`select attempts, last_error, next_attempt_at > now() as later from sync_outbox`;
    expect(row).toMatchObject({ attempts: 1, later: true });
    expect(row!.last_error).toMatch(/INTERNAL_ERROR/);
    await sql`update sync_outbox set next_attempt_at = now()`;
    expect((await runOutbox({ deadline: deadline() })).sent).toBe(1);
    expect(zoho.tokensIssued).toBe(1);
  });

  it("refreshes an access token Zoho rejects", async () => {
    await enableSync(admin);
    await newTicket();
    zoho.failNext = { status: 401, code: "INVALID_OAUTHTOKEN", times: 1 };
    expect((await runOutbox({ deadline: deadline() })).sent).toBe(1);
    expect(zoho.tokensIssued).toBe(2);
  });

  it("puts back a status changed in Zoho, notes it on the ticket, and ignores its own echoes", async () => {
    await enableSync(admin);
    const { ticket } = await newTicket();
    await runOutbox({ deadline: deadline() });
    const caseId = (await sql`select zoho_case_id from tickets`)[0]!.zoho_case_id as string;
    await sql`update sync_state set value = '{"since":"2000-01-01T00:00:00Z","page":1}' where key = ${cursorKey("Cases")}`;

    // Our own case, unchanged: nothing to do.
    await pullModule("Cases", cursorKey("Cases"), deadline());
    expect((await sql`select count(*)::int as n from ticket_events where type = 'zoho'`)[0]!.n).toBe(0);

    zoho.edit("Cases", caseId, { Status: "Closed" });
    await pullModule("Cases", cursorKey("Cases"), deadline());
    const [ev] = await sql`select from_value, to_value from ticket_events where type = 'zoho'`;
    expect(ev).toEqual({ from_value: "Status: New", to_value: "Status: Closed" });
    expect((await sql`select status from tickets`)[0]!.status).toBe("new");
    await runOutbox({ deadline: deadline() });
    expect(zoho.modules.Cases!.get(caseId)!.Status).toBe("New");
    expect(ticket.id).toBeTruthy();
  });

  it("turns a case made in Zoho into a ticket, with its notes as internal notes, without sending it back", async () => {
    await enableSync(admin);
    const dealer = zoho.add("Accounts", { Account_Name: "Ride Shop", Account_Number: "WD-001", Website: "https://www.rideshop.co.uk" });
    const person = zoho.add("Contacts", { First_Name: "Sam", Last_Name: "Lee", Email: "sam@rideshop.co.uk", Account_Name: { id: dealer.id, name: "Ride Shop" } });
    const kase = zoho.add("Cases", { Subject: "Hanger for a 2023 T-160", Status: "On Hold", Priority: "High", Description: "Need two hangers.", Related_To: { id: person.id }, Account_Name: { id: dealer.id } });
    zoho.addNote(kase.id, "Called the dealer, sending today.");
    await pullModule("Accounts", cursorKey("Accounts"), deadline());
    await sql`update sync_state set value = '{"since":"2000-01-01T00:00:00Z","page":1}' where key = ${cursorKey("Cases")}`;
    await pullModule("Cases", cursorKey("Cases"), deadline());

    const [t] = await sql`select t.segment, t.status, t.priority, t.source, t.subject, c.email, c.name, c.segment as contact_segment, a.name as account, a.email_domain from tickets t join contacts c on c.id = t.contact_id join accounts a on a.id = c.account_id`;
    expect(t).toEqual({ segment: "b2b", status: "pending_customer", priority: "high", source: "zoho", subject: "Hanger for a 2023 T-160", email: "sam@rideshop.co.uk", name: "Sam Lee", contact_segment: "b2b", account: "Ride Shop", email_domain: "rideshop.co.uk" });
    const msgs = await sql`select author_type, internal, body, author_name from ticket_messages order by created_at`;
    expect(msgs).toEqual([
      { author_type: "customer", internal: false, body: "Need two hangers.", author_name: "Sam Lee" },
      { author_type: "agent", internal: true, body: "Called the dealer, sending today.", author_name: "Sam in Zoho (Zoho)" },
    ]);
    expect(await outbox()).toEqual([]);

    // A later note arrives through a notification.
    zoho.addNote(kase.id, "Shipped.");
    await applyNotified("Cases", [kase.id], "update");
    expect((await sql`select count(*)::int as n from ticket_messages`)[0]!.n).toBe(3);
    expect(await outbox()).toEqual([]);
  });

  it("feeds closed Zoho cases to the knowledge base: the Solution as Whyte's answer, notes as staff notes", async () => {
    await enableSync(admin);
    const kase = zoho.add("Cases", { Subject: "Creak from the bottom bracket", Status: "Closed", Description: "My 905 creaks when pedalling hard.", Solution: "Clean and re-grease the bottom bracket threads, then torque to spec." });
    zoho.addNote(kase.id, "Sent a BB tool. Customer confirmed the creak has gone.");
    const open = zoho.add("Cases", { Subject: "Where is my order", Status: "New", Description: "Ordered last week." });
    await sql`update sync_state set value = '{"since":"2000-01-01T00:00:00Z","page":1}' where key = ${cursorKey("Cases")}`;
    await pullModule("Cases", cursorKey("Cases"), deadline());

    const msgs = await sql`select author_type, internal, author_name, body from ticket_messages m join tickets t on t.id = m.ticket_id where t.zoho_case_id = ${kase.id} order by m.created_at`;
    expect(msgs.map((m) => [m.author_type, m.internal, m.author_name])).toEqual([
      ["customer", false, "Customer"],
      ["agent", false, "Whyte (solution in Zoho)"],
      ["agent", true, "Sam in Zoho (Zoho)"],
    ]);
    // Only the closed case is queued, with the solution and the note marked as a staff note.
    const items = await sql`select title, content, status from ingest_items where kind = 'ticket'`;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "Creak from the bottom bracket", status: "pending" });
    expect(items[0]!.content).toContain("Whyte:\nClean and re-grease");
    expect(items[0]!.content).toContain("Whyte (staff note):\nSent a BB tool.");
    expect(open.id).toBeTruthy();

    // A later change to the solution updates the ticket and queues it again; nothing goes back to Zoho.
    zoho.edit("Cases", kase.id, { Solution: "Clean, re-grease and torque the bottom bracket to 40 Nm." });
    await applyNotified("Cases", [kase.id], "update");
    expect((await sql`select body from ticket_messages where zoho_note_id = ${"solution:" + kase.id}`)[0]!.body).toContain("40 Nm");
    expect((await sql`select content from ingest_items where kind = 'ticket'`)[0]!.content).toContain("40 Nm");
    expect(await outbox()).toEqual([]);
  });

  it("leaves Zoho notes out of drafts when that's switched off", async () => {
    await enableSync(admin);
    await saveSettings({ "zoho.notes_for_kb": "false" }, admin);
    const kase = zoho.add("Cases", { Subject: "Bent hanger", Status: "Closed", Description: "Gear hanger bent in a crash." });
    zoho.addNote(kase.id, "Sent a replacement hanger.");
    await sql`update sync_state set value = '{"since":"2000-01-01T00:00:00Z","page":1}' where key = ${cursorKey("Cases")}`;
    await pullModule("Cases", cursorKey("Cases"), deadline());
    // No Whyte answer without the notes, so nothing to draft from.
    expect((await sql`select count(*)::int as n from ingest_items`)[0]!.n).toBe(0);
  });

  it("applies Zoho's contact details to contacts it already has, and leaves others out", async () => {
    await enableSync(admin);
    await newTicket();
    await runOutbox({ deadline: deadline() });
    const zc = [...zoho.modules.Contacts!.values()][0]!;
    zoho.edit("Contacts", zc.id, { First_Name: "Janet", Phone: "01234 000000" });
    zoho.add("Contacts", { Last_Name: "Stranger", Email: "stranger@example.com" });
    await sql`update sync_state set value = '{"since":"2000-01-01T00:00:00Z","page":1}' where key = ${cursorKey("Contacts")}`;
    await pullModule("Contacts", cursorKey("Contacts"), deadline());
    expect(await sql`select name, phone, email from contacts`).toEqual([{ name: "Janet Doe", phone: "01234 000000", email: "jane@example.com" }]);
  });

  it("treats the account number field as optional, suggests likely fields, and reads the one chosen", async () => {
    const f = (api_name: string, field_label = api_name, data_type = "text") => ({ api_name, field_label, data_type });
    const pick = (api_name: string, values: string[]) => ({ api_name, data_type: "picklist", pick_list_values: values.map((actual_value) => ({ actual_value })) });
    zoho.fieldMeta = {
      Cases: [f("Subject"), pick("Status", ["New", "On Hold", "Escalated", "Closed"]), pick("Priority", ["-None-", "High", "Medium", "Low"]), pick("Case_Origin", ["Email", "Phone", "Web"]), f("Description", "Description", "textarea"), f("Solution", "Solution", "textarea"), f("Email", "Email", "email"), f("Phone", "Phone", "phone"), f("Related_To", "Contact Name", "lookup"), f("Account_Name", "Account Name", "lookup"), f("Case_Number", "Case Number", "autonumber")],
      Contacts: [f("First_Name"), f("Last_Name"), f("Email"), f("Phone"), f("Mobile"), f("Account_Name", "Account Name", "lookup")],
      Accounts: [f("Account_Name"), f("Account_Type", "Account Type", "picklist"), f("Website", "Website", "website"), f("Phone"), f("Trade_Account_No", "Trade Account No"), f("Rating")],
    };
    const report = await checkSetup();
    expect(report.missing).toEqual([]);
    expect(report.problems).toEqual([expect.stringContaining("Zoho Accounts has no field Account_Number")]);
    expect(report.accountNumberCandidates).toEqual([{ apiName: "Trade_Account_No", label: "Trade Account No" }]);

    await saveSettings({ "zoho.account_number_field": "Trade_Account_No" }, admin);
    expect((await checkSetup()).problems).toEqual([]);
    await enableSync(admin);
    zoho.add("Accounts", { Account_Name: "Ride Shop", Trade_Account_No: "WD-77" });
    await pullModule("Accounts", cursorKey("Accounts"), deadline());
    expect((await sql`select account_number from accounts`)[0]!.account_number).toBe("WD-77");
    expect(zoho.calls.find((c) => c.path === "/Accounts")).toBeTruthy();
  });

  it("swaps the consent code for a refresh token", async () => {
    expect(await exchangeCode("code-123", "https://support.example/api/zoho/callback")).toMatchObject({ refreshToken: "rt-from-code" });
  });

  it("keeps erased contacts erased", async () => {
    await enableSync(admin);
    await newTicket();
    await runOutbox({ deadline: deadline() });
    await sql`update contacts set name = '', email = null, phone = null, anonymised_at = now()`;
    const zc = [...zoho.modules.Contacts!.values()][0]!;
    zoho.edit("Contacts", zc.id, { First_Name: "Jane" });
    await applyNotified("Contacts", [zc.id], "update");
    expect(await sql`select name, email from contacts`).toEqual([{ name: "", email: null }]);
    await saveSettings({ "zoho.sync_enabled": "false" }, admin);
  });
});
