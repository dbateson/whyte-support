/**
 * Splits an article's markdown into passages for search and the chatbot.
 * Breaks at headings, then packs paragraphs up to a size limit, so each
 * passage reads on its own. Each carries "Title › Section" as its heading.
 */

export interface Chunk {
  heading: string;
  content: string;
}

const MAX = 1200;
const HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/;

export function chunkArticle(title: string, markdown: string, max = MAX): Chunk[] {
  const sections: { heading: string; lines: string[] }[] = [{ heading: title, lines: [] }];
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const h = HEADING.exec(line);
    if (h) {
      const text = h[2]!.trim();
      // A top heading repeating the title adds nothing.
      if (text.toLowerCase() !== title.trim().toLowerCase()) sections.push({ heading: `${title} › ${text}`, lines: [] });
      continue;
    }
    sections.at(-1)!.lines.push(line);
  }

  const out: Chunk[] = [];
  for (const s of sections) {
    const paragraphs = s.lines
      .join("\n")
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
    let buf = "";
    const flush = () => {
      if (buf) out.push({ heading: s.heading, content: buf });
      buf = "";
    };
    for (const p of paragraphs) {
      if (p.length > max) {
        flush();
        // A very long paragraph: split at sentence ends.
        for (const sentence of p.split(/(?<=[.!?])\s+/)) {
          if (buf && buf.length + sentence.length + 1 > max) flush();
          buf += (buf ? " " : "") + sentence;
        }
        continue;
      }
      if (buf && buf.length + p.length + 2 > max) flush();
      buf += (buf ? "\n\n" : "") + p;
    }
    flush();
  }
  return out;
}
