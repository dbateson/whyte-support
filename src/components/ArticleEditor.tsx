"use client";

import { useState } from "react";
import { EmptyState, TextArea } from "@whyte/design-system";
import { Tabs } from "@whyte/design-system/client";
import { Markdown } from "./Markdown";

/** The article body: write in Markdown, check it in Preview. Both stay in the form. */
export function ArticleEditor({ defaultValue }: { defaultValue: string }) {
  const [body, setBody] = useState(defaultValue);
  return (
    <Tabs
      label="Article body"
      items={[
        {
          id: "write",
          label: "Write",
          content: (
            <TextArea
              label="Article (Markdown)"
              name="body"
              rows={18}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              help="## for a section heading, - for a list, **bold**. Write for the customer: the chatbot quotes from this."
              required
            />
          ),
        },
        {
          id: "preview",
          label: "Preview",
          content: body.trim() ? <Markdown>{body}</Markdown> : <EmptyState title="Nothing to preview yet">Write the article first.</EmptyState>,
        },
      ]}
    />
  );
}
