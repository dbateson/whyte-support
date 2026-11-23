import "server-only";
import { log } from "../logger";
import { getSecret } from "../secrets";
import { getSetting } from "../settings";

/**
 * Voyage AI embeddings (1024 dimensions) for semantic search. Optional:
 * without a key, search falls back to full text alone.
 */

const URL_ = "https://api.voyageai.com/v1/embeddings";
const BATCH = 128;

export async function embeddingsConfigured(): Promise<boolean> {
  return Boolean(await getSecret("voyage.api_key"));
}

/** Embeds texts as documents (for storage) or a query (for search). Null when Voyage isn't set up. */
export async function embed(texts: string[], inputType: "document" | "query"): Promise<{ vectors: number[][]; model: string } | null> {
  const key = await getSecret("voyage.api_key");
  if (!key || texts.length === 0) return null;
  const model = await getSetting("voyage.model");
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = await fetch(URL_, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ input: batch, model, input_type: inputType, output_dimension: 1024 }),
    });
    if (!res.ok) {
      log.warn("Voyage embeddings failed", { status: res.status });
      throw new Error(res.status === 401 ? "Voyage rejected the API key." : `Voyage returned ${res.status}.`);
    }
    const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    const ordered = [...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    vectors.push(...ordered);
  }
  return { vectors, model };
}

/** For "Test connection". */
export async function testVoyageConnection(): Promise<string> {
  const r = await embed(["Test"], "query");
  if (!r) throw new Error("Add the Voyage API key first.");
  return `Connected. ${r.model} returned a ${r.vectors[0]?.length ?? 0}-dimension embedding.`;
}
