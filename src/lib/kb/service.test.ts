import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, useTestDatabase } from "@/test/db";
import { searchKb } from "./queries";
import { createArticle, discardDraft, getArticle, KbError, publish, requestChanges, restore, retire, saveDraft, submitForReview } from "./service";

describe.skipIf(!TEST_DATABASE_URL)("knowledge base", () => {
  const { sql, reset } = useTestDatabase();
  const actor = { label: "Jo Smith" };
  beforeEach(reset);
  afterAll(async () => {
    await sql.end();
  });

  const warranty = () =>
    createArticle(
      {
        title: "Frame warranty",
        audience: "b2c",
        category: "Warranty",
        body: "## What's covered\n\nWhyte frames are covered against manufacturing defects for five years from purchase.\n\n## How to claim\n\nSend photos of the damage, the frame number and your receipt.",
        sources: [{ kind: "ticket", reference: "WS-10001", title: "Cracked rear triangle" }],
      },
      actor,
    );

  it("runs draft → review → changes requested → review → published", async () => {
    const { article } = await warranty();
    await expect(publish(article.id, actor).then(() => "ok")).resolves.toBe("ok"); // approvers may publish a draft directly
    const published = await getArticle(article.id);
    expect(published?.published?.status).toBe("published");
    expect(published?.working).toBeNull();
    expect((await sql`select count(*)::int as n from kb_chunks`)[0]!.n).toBe(2);

    // Editing a published article makes a new working version; the live one stays live.
    await saveDraft(article.id, { title: "Frame warranty", body: "## What's covered\n\nFrames: lifetime for the original owner.", audience: "b2c", category: "Warranty" }, actor);
    await submitForReview(article.id, actor);
    await requestChanges(article.id, "Check the term with the warranty team", actor);
    let a = await getArticle(article.id);
    expect(a?.working).toMatchObject({ number: 2, status: "draft", reviewNote: "Check the term with the warranty team" });
    expect(a?.published?.number).toBe(1);
    const liveBefore = await sql`select content from kb_chunks order by position`;
    expect(liveBefore[0]!.content).toMatch(/five years/);

    await submitForReview(article.id, actor);
    await publish(article.id, actor);
    a = await getArticle(article.id);
    expect(a?.published?.number).toBe(2);
    expect(a?.versions.map((v) => [v.number, v.status])).toEqual([
      [2, "published"],
      [1, "superseded"],
    ]);
    const live = await sql`select content, version_id from kb_chunks`;
    expect(live.map((c) => c.content)).toEqual(["Frames: lifetime for the original owner."]);
    expect(live[0]!.version_id).toBe(a?.published?.id);
    expect(a?.sources[0]).toMatchObject({ kind: "ticket", reference: "WS-10001" });
  });

  it("keeps a live article's audience until an audience change is published", async () => {
    const { article } = await createArticle({ title: "Trade warranty claims", audience: "b2b", body: "Dealers lodge claims through the trade portal with photos." }, actor);
    await publish(article.id, actor);
    await saveDraft(article.id, { title: "Trade warranty claims", body: "Dealers lodge claims through the trade portal with photos.", audience: "both", category: null }, actor);
    // Saved, not approved: riders still can't find it.
    expect((await getArticle(article.id))!.article.audience).toBe("b2b");
    expect(await searchKb("trade portal claims", "b2c", 5)).toEqual([]);
    await publish(article.id, actor);
    expect((await getArticle(article.id))!.article.audience).toBe("both");
    expect((await searchKb("trade portal claims", "b2c", 5)).length).toBeGreaterThan(0);
  });

  it("refuses to publish an empty article and to submit twice", async () => {
    const { article } = await createArticle({ title: "Stub", body: "tiny", audience: "both" }, actor);
    await expect(publish(article.id, actor)).rejects.toBeInstanceOf(KbError);
    await submitForReview(article.id, actor);
    await expect(submitForReview(article.id, actor)).rejects.toThrow(/no draft/);
  });

  it("discards: a never-published article is deleted, otherwise the draft is", async () => {
    const { article } = await createArticle({ title: "Gone", body: "x".repeat(30), audience: "b2b" }, actor);
    expect(await discardDraft(article.id, actor)).toBe("deleted");
    expect(await getArticle(article.id)).toBeNull();
    const w = await warranty();
    await publish(w.article.id, actor);
    await saveDraft(w.article.id, { title: "Edit", body: "y".repeat(30), audience: "b2c", category: null }, actor);
    expect(await discardDraft(w.article.id, actor)).toBe("discarded");
    expect((await getArticle(w.article.id))?.published?.title).toBe("Frame warranty");
  });

  it("finds published passages for the right audience only, and stops at retirement", async () => {
    const w = await warranty();
    await publish(w.article.id, actor);
    const dealer = await createArticle({ title: "Dealer warranty claims", audience: "b2b", body: "Dealers submit warranty claims through the trade portal with the frame number." }, actor);
    await publish(dealer.article.id, actor);
    const both = await createArticle({ title: "Finding your frame number", audience: "both", body: "The frame number is stamped under the bottom bracket." }, actor);
    await publish(both.article.id, actor);

    const rider = await searchKb("how do I claim warranty on a cracked frame", "b2c");
    expect(rider.length).toBeGreaterThan(0);
    expect(rider[0]!.articleId).toBe(w.article.id);
    expect(rider.every((h) => h.audience === "b2c" || h.audience === "both")).toBe(true);
    expect(rider.some((h) => h.articleId === dealer.article.id)).toBe(false);
    expect(rider.every((h) => h.matchedBy.includes("text"))).toBe(true);

    const trade = await searchKb("warranty claim frame number", "b2b");
    expect(trade.map((h) => h.articleId)).toContain(dealer.article.id);
    expect(trade.some((h) => h.articleId === w.article.id)).toBe(false);

    await retire(w.article.id, actor);
    expect((await searchKb("warranty cracked frame", "b2c")).some((h) => h.articleId === w.article.id)).toBe(false);
    await restore(w.article.id, actor);
    expect((await searchKb("warranty cracked frame", "b2c")).some((h) => h.articleId === w.article.id)).toBe(true);
    expect(await searchKb("   ", "b2c")).toEqual([]);
  });
});
