import { Fragment } from "react";

/** Plain-text message as paragraphs and line breaks (React escapes the text). */
export function MessageBody({ text }: { text: string }) {
  const paragraphs = text.replace(/\r\n/g, "\n").split(/\n{2,}/).filter((p) => p.trim());
  return (
    <>
      {paragraphs.map((p, i) => (
        <p key={i}>
          {p.split("\n").map((line, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {line}
            </Fragment>
          ))}
        </p>
      ))}
    </>
  );
}
