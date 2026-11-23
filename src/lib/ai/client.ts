import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getSecret } from "../secrets";

export class AnthropicNotConfiguredError extends Error {
  constructor() {
    super("Add the Anthropic API key in Settings → Integrations.");
  }
}

/** A client built from the key in the encrypted store, never from the environment. */
export async function anthropic(): Promise<Anthropic> {
  const apiKey = await getSecret("anthropic.api_key");
  if (!apiKey) throw new AnthropicNotConfiguredError();
  return new Anthropic({ apiKey, maxRetries: 2 });
}

/** For "Test connection": confirms the key works and the chatbot's model is available to it. */
export async function testAnthropicConnection(model: string): Promise<string> {
  const client = await anthropic();
  try {
    const info = await client.models.retrieve(model);
    return `Connected. The chatbot model, ${info.display_name}, is available.`;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error("Anthropic rejected the API key.");
    if (err instanceof Anthropic.NotFoundError) throw new Error(`The key works, but the model ${model} isn't available to it.`);
    if (err instanceof Anthropic.RateLimitError) throw new Error("Anthropic is rate-limiting this key. Try again in a minute.");
    if (err instanceof Anthropic.APIError) throw new Error(`Anthropic returned an error (${err.status}).`);
    throw new Error("Couldn't reach Anthropic.");
  }
}
