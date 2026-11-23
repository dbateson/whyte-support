import { describe, expect, it } from "vitest";
import { mailboxKey, messageIdFor, parseMailboxKey, replyToAddress, safeEqual, stripQuotedReply, ticketNumberFromMessageId } from "./addresses";

describe("reply routing", () => {
  it("round-trips the mailbox key", () => {
    const key = mailboxKey(10234, "Ab3_dEf-9xYz");
    expect(key).toBe("t10234-Ab3_dEf-9xYz");
    expect(parseMailboxKey(key)).toEqual({ number: 10234, replyToken: "Ab3_dEf-9xYz" });
    expect(parseMailboxKey("t10234")).toBeNull();
    expect(parseMailboxKey("")).toBeNull();
  });

  it("builds a plus address on the inbound address", () => {
    expect(replyToAddress("abc123@inbound.postmarkapp.com", "t1-x")).toBe("abc123+t1-x@inbound.postmarkapp.com");
    expect(replyToAddress("", "k")).toBeUndefined();
  });

  it("finds the ticket in a Message-ID or References header", () => {
    const id = messageIdFor(10234, "0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(ticketNumberFromMessageId(`<other@x> ${id}`)).toBe(10234);
    expect(ticketNumberFromMessageId("<random@gmail.com>")).toBeNull();
  });

  it("compares credentials in constant time", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
  });
});

describe("stripQuotedReply", () => {
  it("drops Gmail-style quoted history", () => {
    expect(stripQuotedReply("Thanks, photos attached.\n\nOn Tue, 12 Nov 2026 at 09:44, Whyte Support <s@x> wrote:\n> Could you send photos?")).toBe(
      "Thanks, photos attached.",
    );
  });
  it("drops the Gmail header split over two lines", () => {
    expect(stripQuotedReply("Yes.\nOn Tue, 12 Nov 2026 at 09:44, Whyte Support\n<s@x> wrote:\n> q")).toBe("Yes.");
  });
  it("drops Outlook's quoted block", () => {
    expect(stripQuotedReply("Frame no. WB123\n\n________________________________\nFrom: Whyte Support\nSent: 12 November")).toBe("Frame no. WB123");
    expect(stripQuotedReply("Hi\nFrom: Whyte Support <s@x>\nSent: Tuesday")).toBe("Hi");
  });
  it("drops a signature", () => {
    expect(stripQuotedReply("See you then\n-- \nJane")).toBe("See you then");
  });
  it("keeps a message with no quote", () => {
    expect(stripQuotedReply("Line one\nLine two")).toBe("Line one\nLine two");
  });
});
