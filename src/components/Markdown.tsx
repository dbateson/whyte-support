import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prose } from "@whyte/design-system";

/**
 * Article markdown as the design system's prose. Raw HTML in the source is
 * ignored (react-markdown's default), so article text can't inject markup.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <Prose>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // eslint-disable-next-line @typescript-eslint/no-unused-vars -- drop react-markdown's AST node from the DOM props
          a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </Prose>
  );
}
