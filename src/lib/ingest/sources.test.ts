import { describe, expect, it } from "vitest";
import { htmlToText, parseEmail, parseSitemap, parseZohoCases, splitMbox } from "./sources";

const msg = (id: string, from: string, body: string, extra = "") =>
  `From: ${from}\r\nTo: support@whytebikes.com\r\nSubject: Re: Cracked frame\r\nMessage-ID: ${id}\r\n${extra}Date: Tue, 12 Nov 2026 09:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;

describe("email parsing", () => {
  it("threads by the oldest reference, marks staff and redacts", async () => {
    const e = await parseEmail(
      msg("<b@x>", "Jo <jo@whytebikes.com>", "Hi Jane,\n\nYes, that's covered. Send photos.\n\nKind regards,\nJo\n07700 900123\n\nOn Mon, Jane wrote:\n> my frame cracked", "References: <a@x> <q@x>\r\nIn-Reply-To: <q@x>\r\n"),
      ["whytebikes.com"],
    );
    expect(e).toMatchObject({ messageId: "<b@x>", threadKey: "<a@x>", fromStaff: true, subject: "Re: Cracked frame" });
    expect(e!.text).toBe("Hi [name],\n\nYes, that's covered. Send photos.\n\nKind regards,");
  });

  it("keys an original by its own id and keeps its subject for joining", async () => {
    const e = await parseEmail(msg("<c@x>", "jane@gmail.com", "My frame cracked, call me on 07700 900123"), ["whytebikes.com"]);
    expect(e).toMatchObject({ threadKey: "<c@x>", subjectKey: "cracked frame", fromStaff: false });
    expect(e!.text).toContain("[phone]");
  });

  it("splits mbox text across reads", () => {
    const one = "From a@x Tue Nov 12 09:00:00 2026\nSubject: one\n\nbody one\n>From the start\n";
    const two = "From b@x Tue Nov 12 10:00:00 2026\nSubject: two\n\nbody two\n";
    const all = one + two;
    const cut = all.length - 10;
    const first = splitMbox(all.slice(0, cut), false);
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toContain("From the start");
    expect(first.messages[0]).not.toContain(">From");
    const second = splitMbox(first.rest + all.slice(cut), true);
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]).toContain("body two");
  });
});

describe("Zoho cases CSV", () => {
  it("maps the usual columns, flags dealer cases and redacts", () => {
    const csv = [
      "Case Number,Subject,Description,Solution,Status,Account Name,Product Name",
      '1001,Creaking BB,"Creak from the bottom bracket, email me jane@gmail.com",Regrease the BB shell,Closed,,905',
      "1002,Warranty claim for shop,Customer frame cracked,Replacement frame sent,Closed,Ride Shop Ltd,T-130",
      "1003,Empty,,,Open,,",
    ].join("\n");
    const cases = parseZohoCases(csv);
    expect(cases.map((c) => c.externalId)).toEqual(["1001", "1002"]);
    expect(cases[0]!.text).toContain("Customer:\nCreak from the bottom bracket, email me [email]");
    expect(cases[0]!.text).toContain("Whyte:\nRegrease the BB shell");
    expect(cases[0]!.audienceHint).toBeNull();
    expect(cases[1]!.audienceHint).toBe("b2b");
  });
});

describe("web pages", () => {
  it("keeps the main content and drops menus and scripts", () => {
    const { title, text } = htmlToText(
      "<html><head><title>Warranty | Whyte</title><script>var x=1</script></head><body><header><nav>Bikes Shop</nav></header><main><h1>Warranty</h1><p>Frames are covered for <b>5 years</b>.</p><ul><li>Keep your receipt</li></ul></main><footer>© Whyte</footer></body></html>",
    );
    expect(title).toBe("Warranty");
    expect(text).toBe("Warranty\nFrames are covered for 5 years.\nKeep your receipt");
  });

  it("reads sitemaps and sitemap indexes", () => {
    expect(parseSitemap("<sitemapindex><sitemap><loc>https://x/sitemap_pages_1.xml</loc></sitemap></sitemapindex>")).toEqual({ pages: [], sitemaps: ["https://x/sitemap_pages_1.xml"] });
    expect(parseSitemap("<urlset><url><loc>https://x/pages/warranty?a=1&amp;b=2</loc></url></urlset>").pages).toEqual(["https://x/pages/warranty?a=1&b=2"]);
  });
});
