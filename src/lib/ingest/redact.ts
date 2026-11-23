/**
 * Removes personal data from historical text before it's stored or sent to
 * the model: email addresses, phone numbers, UK postcodes, card-like numbers,
 * the name in a greeting, and signature blocks. It's a first pass: drafts
 * are also written to leave personal details out, and staff review them.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// UK numbers (07…, 01…, 02…, +44…) and other international formats with 9+ digits.
const PHONE = /(?<![\w/])(?:\+\d{1,3}[\s.-]?\(?\d{1,5}\)?|\(?0\d{2,5}\)?)[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?![\w/])/g;
const POSTCODE = /\b(?:GIR ?0AA|[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]? ?\d[ABD-HJLNP-UW-Z]{2})\b/gi;
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
// Case matters for the name (a capital letter), so only the greeting word ignores case.
const GREETING = /^(\s*(?:[Hh]i|[Hh]ello|[Hh]ey|[Dd]ear|[Mm]orning|[Aa]fternoon|[Gg]ood (?:[Mm]orning|[Aa]fternoon|[Ee]vening))[ ,]+)([A-Z][a-zA-Z'-]+(?: [A-Z][a-zA-Z'-]+)?)(\s*[,!.]?)/gm;
const SIGN_OFF = /^\s*(?:kind regards|best regards|regards|many thanks|thanks(?: again)?|thank you|cheers|best wishes|all the best|best|sincerely|yours sincerely|ta)[,.!]?\s*$/i;

export function redact(text: string): string {
  let out = text.replace(/\r\n/g, "\n");
  out = stripSignatures(out);
  out = out.replace(EMAIL, "[email]");
  out = out.replace(CARD, (m) => (m.replace(/\D/g, "").length >= 13 ? "[number]" : m));
  out = out.replace(PHONE, (m) => (m.replace(/\D/g, "").length >= 9 ? "[phone]" : m));
  out = out.replace(POSTCODE, "[postcode]");
  out = out.replace(GREETING, (_m, hello: string, _name: string, punct: string) => `${hello}[name]${punct}`);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Drops everything after a sign-off line ("Kind regards", "Thanks") when it
 * comes near the end of a message, where names, phone numbers and addresses sit.
 */
export function stripSignatures(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 12); i--) {
    if (SIGN_OFF.test(lines[i]!)) return lines.slice(0, i + 1).join("\n");
  }
  return text;
}
