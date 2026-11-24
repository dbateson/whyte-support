import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, useTestDatabase } from "@/test/db";
import type { Staff } from "../auth/session";
import { can, segmentsFor, SYSTEM_ROLES } from "../auth/permissions";

const { bulkApply } = await import("./bulk");
const { createArticle, getArticle, publish, submitForReview } = await import("./service");
const { searchKb } = await import("./queries");

const staffWith = (roleName: string): Staff => {
  const roles = [SYSTEM_ROLES.find((r) => r.name === roleName)!];
  return { id: undefined as unknown as string, name: roleName, email: "x@example.com", roleNames: [roleName], roles, can: (p, s) => can(roles, p, s), segmentsFor: (p) => segmentsFor(roles, p) };
};

describe.skipIf(!TEST_DATABASE_URL)("bulk knowledge-base edits", () => {
  const { sql, reset } = useTestDatabase();
  const admin = staffWith("Admin");
  const editor = staffWith("KB Editor");
  const actor = { label: "T" };
  beforeEach(reset);
  afterAll(async () => {
    await sql.end();
  });

  const article = async (title: string, audience: "b2c" | "b2b" | "both" = "b2c", opts: { publish?: boolean; review?: boolean } = {}) => {
    const { article } = await createArticle({ title, audience, body: `${title}: call 01234 567890 for help with this.` }, actor);
    if (opts.review) await submitForReview(article.id, actor);
    if (opts.publish) await publish(article.id, actor);
    return article.id;
  };

  it("publishes several drafts at once and reports what it skipped", async () => {
    const a = await article("Bottom bracket creak", "b2c", { review: true });
    const b = await article("Hanger alignment", "b2c");
    const live = await article("Frame warranty", "b2c", { publish: true });
    const r = await bulkApply(admin, [a, b, live], { kind: "publish" });
    expect(r.done).toBe(2);
    expect(r.skipped).toEqual([{ id: live, title: "Frame warranty", reason: "Nothing to publish." }]);
    expect((await getArticle(a))!.published?.title).toBe("Bottom bracket creak");
  });

  it("only lets approvers publish or send back, and asks editors' changes to go through review", async () => {
    const a = await article("Hanger alignment", "b2c", { review: true });
    const asEditor = await bulkApply(staffWith("B2B Agent"), [a], { kind: "publish" });
    expect(asEditor.done).toBe(0);
    expect(asEditor.skipped[0]!.reason).toMatch(/can't (approve|edit)/);
    expect((await bulkApply(admin, [a], { kind: "changes", note: "Add torque values." })).done).toBe(1);
    expect((await getArticle(a))!.working).toMatchObject({ status: "draft", reviewNote: "Add torque values." });
  });

  it("finds and replaces text: drafts for review, or published straight away", async () => {
    const one = await article("Contact", "b2c", { publish: true });
    const two = await article("Other", "b2c", { publish: true });
    await sql`update kb_article_versions set body = 'No number here, but long enough to publish.' where article_id = ${two}`;
    const r = await bulkApply(editor, [one, two], { kind: "replace", find: "01234 567890", replace: "01234 000111", publish: false });
    expect(r).toMatchObject({ done: 1, skipped: [{ id: two, reason: "Doesn't contain the text." }] });
    const after = (await getArticle(one))!;
    expect(after.working!.body).toContain("01234 000111");
    expect(after.published!.body).toContain("01234 567890"); // live until approved
    await bulkApply(admin, [one], { kind: "publish" });
    expect((await getArticle(one))!.published!.body).toContain("01234 000111");
  });

  it("changes audience: drafts straight away, live articles only for approvers", async () => {
    const draft = await article("Trade pricing", "b2c");
    const live = await article("Dealer claims", "b2b", { publish: true });
    expect((await bulkApply(editor, [draft], { kind: "audience", audience: "b2b" })).done).toBe(1);
    expect((await getArticle(draft))!.article.audience).toBe("b2b");
    expect((await bulkApply(staffWith("B2B Agent"), [live], { kind: "audience", audience: "both" })).done).toBe(0);
    expect((await bulkApply(admin, [live], { kind: "audience", audience: "both" })).done).toBe(1);
    expect((await getArticle(live))!.article.audience).toBe("both");
    expect((await searchKb("dealer claims", "b2c", 5)).length).toBeGreaterThan(0);
  });

  it("sets categories, retires and restores", async () => {
    const a = await article("Gear hanger", "b2c", { publish: true });
    await bulkApply(editor, [a], { kind: "category", category: "Parts and spares" });
    expect((await getArticle(a))!.article.category).toBe("Parts and spares");
    await bulkApply(admin, [a], { kind: "retire" });
    expect((await getArticle(a))!.article.retiredAt).not.toBeNull();
    expect((await bulkApply(admin, [a], { kind: "retire" })).skipped[0]!.reason).toBe("Already retired.");
    await bulkApply(admin, [a], { kind: "restore" });
    expect((await getArticle(a))!.article.retiredAt).toBeNull();
  });
});
