"use client";

import { useState } from "react";
import { Button, Checkbox, Fieldset, Inline, Radio, Select, TextArea, TextField } from "@whyte/design-system";
import { ActionForm } from "@/components/ActionForm";
import type { KbAudience } from "@/lib/db/schema";
import { bulkEditAction } from "./actions";

export const BULK_FORM_ID = "kb-bulk";

const AUDIENCE_LABELS: Record<KbAudience, string> = { b2c: "Riders (B2C)", b2b: "Dealers (B2B)", both: "Riders and dealers" };

/** The tick box in each row: a design-system Checkbox that belongs to the bulk form by its `form` attribute. */
export function RowSelect({ id, title }: { id: string; title: string }) {
  return <Checkbox name="ids" value={id} form={BULK_FORM_ID} label={<span className="vh">Select {title}</span>} />;
}

/** Ticks or clears every row on this page. */
export function SelectAllOnPage() {
  return (
    <Checkbox
      label="Select all on this page"
      onChange={(e) => {
        document.querySelectorAll<HTMLInputElement>(`input[name="ids"][form="${BULK_FORM_ID}"]`).forEach((box) => {
          box.checked = e.currentTarget.checked;
        });
      }}
    />
  );
}

/**
 * Bulk changes to knowledge-base articles. `mode` "articles" offers every
 * change and an "all matching these filters" scope; "review" is the review
 * queue's subset (decide on drafts), with an "everything waiting" scope.
 */
export function BulkEdit({
  mode,
  canApprove,
  audiences,
  categories,
  filters,
  allCount,
}: {
  mode: "articles" | "review";
  canApprove: boolean;
  audiences: KbAudience[];
  categories: readonly string[];
  filters?: { q?: string; state: string; audience?: string };
  allCount: number;
}) {
  const [action, setAction] = useState("");
  const options = [
    ...(canApprove ? [{ value: "publish", label: "Publish (approve)" }] : []),
    ...(canApprove ? [{ value: "changes", label: "Send back with a note" }] : []),
    { value: "submit", label: "Send for review" },
    { value: "discard", label: "Discard drafts" },
    ...(mode === "articles"
      ? [
          ...(canApprove ? [{ value: "retire", label: "Retire" }, { value: "restore", label: "Restore" }] : []),
          { value: "category", label: "Set category" },
          { value: "audience", label: "Set who it's for" },
          { value: "replace", label: "Find and replace text" },
        ]
      : [{ value: "audience", label: "Set who it's for" }]),
  ];
  return (
    <ActionForm action={bulkEditAction} id={BULK_FORM_ID} label="Change several articles">
      <Select label="Change" name="bulkAction" size="small" value={action} onChange={(e) => setAction(e.target.value)}>
        <option value="">Choose…</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
      {action === "changes" && <TextArea label="Note for the authors" name="note" rows={3} required />}
      {action === "category" && (
        <Select label="Category" name="category" size="small" defaultValue="">
          <option value="">No category</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      )}
      {action === "audience" && (
        <Select label="For" name="newAudience" size="small" defaultValue={audiences[0]} help="Changing who sees a published article needs approval in both audiences.">
          {audiences.map((a) => (
            <option key={a} value={a}>
              {AUDIENCE_LABELS[a]}
            </option>
          ))}
        </Select>
      )}
      {action === "replace" && (
        <>
          <TextField label="Find" name="find" size="small" required help="Exact text, including capitals. Titles and article text are both changed." />
          <TextField label="Replace with" name="replaceWith" size="small" />
          {canApprove ? (
            <Checkbox name="publishAfter" label="Publish the changes straight away" description="Otherwise each changed article becomes a draft to review." />
          ) : null}
        </>
      )}
      <Fieldset legend="Which articles">
        <Radio name="scope" value="ticked" label="The ones ticked below" defaultChecked />
        {mode === "articles" ? (
          <Radio name="scope" value="filtered" label={`All ${allCount.toLocaleString("en-GB")} matching these filters${allCount > 500 ? " (the first 500)" : ""}`} />
        ) : (
          <Radio name="scope" value="queue" label={`Everything waiting (${allCount.toLocaleString("en-GB")}${allCount > 500 ? ", the first 500" : ""})`} />
        )}
      </Fieldset>
      {filters && (
        <>
          <input type="hidden" name="fq" value={filters.q ?? ""} />
          <input type="hidden" name="fstate" value={filters.state} />
          <input type="hidden" name="faudience" value={filters.audience ?? ""} />
        </>
      )}
      <Inline gap="small">
        <Button type="submit" size="small" disabled={!action}>
          Apply
        </Button>
      </Inline>
    </ActionForm>
  );
}
