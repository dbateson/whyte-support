import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_DATABASE_URL, useTestDatabase } from "@/test/db";

// A stand-in for Voyage: words map to fixed directions, so "crack" and "fracture" land close together.
const DIRS: Record<string, number> = { crack: 0, fracture: 0, cracked: 0, creak: 1, noise: 1, delivery: 2, parcel: 2 };
function vectorFor(text: string): number[] {
  const v = new Array(1024).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) if (w in DIRS) v[DIRS[w]!] += 1;
  if (v.every((x) => x === 0)) v[1023] = 1;
  return v;
}
vi.mock("./embeddings", () => ({
  embeddingsConfigured: async () => true,
  embed: vi.fn(async (texts: string[]) => ({ vectors: texts.map(vectorFor), model: "test-embed" })),
}));

const { createArticle, publish, embedMissing } = await import("./service");
const { searchKb } = await import("./queries");

describe.skipIf(!TEST_DATABASE_URL)("semantic search", () => {
  const { sql, reset } = useTestDatabase();
  const actor = { label: "Test" };
  beforeEach(reset);
  afterAll(async () => {
    await sql.end();
  });

  it("embeds passages on publish and finds them by meaning when the words differ", async () => {
    const frame = await createArticle({ title: "Frame damage", audience: "b2c", body: "If your frame shows a crack, stop riding and send us photos for a warranty assessment." }, actor);
    await publish(frame.article.id, actor);
    const parcel = await createArticle({ title: "Tracking a parcel", audience: "b2c", body: "Your delivery tracking link arrives by email when the parcel leaves us." }, actor);
    await publish(parcel.article.id, actor);

    const [row] = await sql`select embedding_model, vector_dims(embedding) as dims from kb_chunks limit 1`;
    expect(row).toMatchObject({ embedding_model: "test-embed", dims: 1024 });

    // "fracture" shares no word with the article, so only the semantic half can find it.
    const hits = await searchKb("Is a fracture covered?", "b2c");
    expect(hits[0]?.articleId).toBe(frame.article.id);
    expect(hits[0]?.matchedBy).toEqual(["meaning"]);

    // Both halves agreeing ranks a passage above one that matched by meaning only.
    const both = await searchKb("crack warranty", "b2c");
    expect(both[0]).toMatchObject({ articleId: frame.article.id, matchedBy: ["text", "meaning"] });
  });

  it("fills in embeddings that are missing", async () => {
    const a = await createArticle({ title: "Creaks", audience: "b2c", body: "A creak or noise from the bottom bracket usually means it needs regreasing." }, actor);
    await publish(a.article.id, actor);
    await sql`update kb_chunks set embedding = null, embedding_model = null`;
    expect(await embedMissing()).toBe(1);
    expect((await sql`select count(*)::int as n from kb_chunks where embedding is null`)[0]!.n).toBe(0);
  });
});
