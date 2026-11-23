import type { ArticleState } from "./service";

/** How each article state reads, with its Status tone. */
export const STATE_LABELS: Record<ArticleState, { label: string; tone: "success" | "warning" | "neutral" | "error" }> = {
  published: { label: "Published", tone: "success" },
  published_with_changes: { label: "Published, changes in progress", tone: "success" },
  in_review: { label: "In review", tone: "warning" },
  draft: { label: "Draft", tone: "neutral" },
  retired: { label: "Retired", tone: "neutral" },
};

