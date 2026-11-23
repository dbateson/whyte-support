import { describe, expect, it } from "vitest";
import { chunkArticle } from "./chunk";

describe("chunkArticle", () => {
  it("splits at headings and labels each passage with its section", () => {
    const chunks = chunkArticle(
      "Frame warranty",
      "# Frame warranty\n\nIntro para.\n\n## What's covered\n\nFrames for 5 years.\n\n## How to claim\n\nSend photos.\n\nAnd your receipt.",
    );
    expect(chunks).toEqual([
      { heading: "Frame warranty", content: "Intro para." },
      { heading: "Frame warranty › What's covered", content: "Frames for 5 years." },
      { heading: "Frame warranty › How to claim", content: "Send photos.\n\nAnd your receipt." },
    ]);
  });

  it("packs paragraphs up to the limit and splits long ones at sentences", () => {
    const para = "Word ".repeat(30).trim() + ".";
    const chunks = chunkArticle("T", [para, para, para].join("\n\n"), 400);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length <= 400)).toBe(true);
    const long = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const split = chunkArticle("T", long, 200);
    expect(split.length).toBeGreaterThan(2);
    expect(split.every((c) => c.content.length <= 200)).toBe(true);
    expect(split.map((c) => c.content).join(" ")).toBe(long);
  });

  it("returns nothing for an empty body", () => {
    expect(chunkArticle("T", "  \n\n ")).toEqual([]);
  });
});
