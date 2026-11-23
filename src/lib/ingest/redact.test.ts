import { describe, expect, it } from "vitest";
import { redact } from "./redact";

describe("redact", () => {
  it("removes contact details", () => {
    const out = redact("Email me at jane.doe@gmail.com or call 07700 900123 / +44 20 7946 0958. I'm at SW1A 1AA.");
    expect(out).toBe("Email me at [email] or call [phone] / [phone]. I'm at [postcode].");
  });

  it("removes card-like numbers but keeps order numbers and dates", () => {
    const out = redact("Card 4111 1111 1111 1111 was charged for order #10423 on 12/11/2026.");
    expect(out).toBe("Card [number] was charged for order #10423 on 12/11/2026.");
  });

  it("removes the name in a greeting and the signature block", () => {
    const out = redact("Hi Jane,\n\nThe frame is covered.\n\nKind regards,\nJo Smith\nWhyte Bikes\n01234 567890");
    expect(out).toBe("Hi [name],\n\nThe frame is covered.\n\nKind regards,");
  });

  it("doesn't mistake an ordinary word after a greeting for a name", () => {
    expect(redact("Hi, my frame cracked.")).toBe("Hi, my frame cracked.");
    expect(redact("hello Sam Jones, thanks")).toBe("hello [name], thanks");
  });

  it("leaves ordinary text and frame numbers alone", () => {
    expect(redact("The 905 frame WB12345 fits a 2.6in tyre.")).toBe("The 905 frame WB12345 fits a 2.6in tyre.");
  });
});
