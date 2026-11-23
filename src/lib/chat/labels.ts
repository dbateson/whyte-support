
import type { StatusTone } from "@whyte/design-system";
import type { ChatOutcome } from "../db/schema";

type Tone = StatusTone;

export const OUTCOME_LABELS: Record<ChatOutcome, { label: string; tone: Tone }> = {
  answered: { label: "Answered", tone: "success" },
  partial: { label: "Partly answered", tone: "success" },
  no_answer: { label: "Not in the articles", tone: "warning" },
  needs_human: { label: "Needs a person", tone: "warning" },
  declined: { label: "Declined", tone: "neutral" },
  error: { label: "Error", tone: "error" },
};
