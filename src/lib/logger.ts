/**
 * Structured JSON logger that never writes secrets or raw customer contact details.
 *
 * Three layers of redaction:
 * 1. Any field whose name looks sensitive (key, token, secret, password,
 *    authorization, cookie...) is replaced wholesale.
 * 2. Known credential shapes in free text (Anthropic/Voyage keys, bearer
 *    tokens, Zoho tokens, JWTs) are masked.
 * 3. Every secret value the app has decrypted is registered here and masked
 *    wherever it appears, whatever its shape.
 * Email addresses are partly masked (GDPR: logs aren't a customer record).
 */

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACTED = "[redacted]";
const SENSITIVE_KEY = /(pass(word)?|secret|token|api[-_]?key|authori[sz]ation|cookie|session|credential|private[-_]?key|refresh|signature)/i;

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /\bpa-[A-Za-z0-9_-]{16,}/g, // Voyage
  /\b1000\.[a-f0-9]{16,}\.[a-f0-9]{16,}/gi, // Zoho OAuth tokens
  /\bshp(at|ss|ca|pa)_[A-Za-z0-9]{16,}/g, // Shopify
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
  /(Bearer|Zoho-oauthtoken|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, // auth headers in messages
];
const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

const knownSecrets = new Set<string>();

/** Registers a decrypted secret so it's masked if it ever reaches a log line. */
export function registerSecretValue(value: string) {
  if (value.length >= 6) knownSecrets.add(value);
}

export function redactString(input: string): string {
  let out = input;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
  return out.replace(EMAIL, "$1***@$2");
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth]";
  if (typeof value === "string") return redactString(value);
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), stack: value.stack ? redactString(value.stack) : undefined };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) && v != null && v !== "" ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function minLevel(): number {
  const l = (process.env.LOG_LEVEL ?? "info") as Level;
  return LEVELS[l] ?? LEVELS.info;
}

function write(level: Level, message: string, context?: Record<string, unknown>) {
  if (LEVELS[level] < minLevel()) return;
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    msg: redactString(message),
    ...(context ? (redact(context) as Record<string, unknown>) : {}),
  });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, ctx?: Record<string, unknown>) => write("debug", msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => write("info", msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => write("warn", msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => write("error", msg, ctx),
};
