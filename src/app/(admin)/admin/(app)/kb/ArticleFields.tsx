import { Select, TextField } from "@whyte/design-system";
import type { KbAudience } from "@/lib/db/schema";
import { AUDIENCE_LABELS } from "@/lib/kb/access";
import { CATEGORIES } from "@/lib/tickets/format";
import { ArticleEditor } from "@/components/ArticleEditor";

/** Title, audience, category and body: shared by New and Edit. */
export function ArticleFields({ title = "", body = "", audience, category, audiences }: { title?: string; body?: string; audience?: KbAudience; category?: string | null; audiences: KbAudience[] }) {
  return (
    <>
      <TextField label="Title" name="title" defaultValue={title} required maxLength={200} help="Phrase it as people ask: “How do I claim on my frame warranty?”" />
      <Select label="For" name="audience" defaultValue={audience ?? audiences[0]} help="The chatbot shows B2B articles only to dealers.">
        {audiences.map((a) => (
          <option key={a} value={a}>{AUDIENCE_LABELS[a]}</option>
        ))}
      </Select>
      <Select label="Category" name="category" defaultValue={category ?? ""}>
        <option value="">None</option>
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </Select>
      <ArticleEditor defaultValue={body} />
    </>
  );
}
