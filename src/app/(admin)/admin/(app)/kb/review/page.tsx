import type { Metadata } from "next";
import Link from "next/link";
import { Badge, DataTable, EmptyState, PageHeader, Panel, Stack, type DataTableColumn } from "@whyte/design-system";
import { requireStaff } from "@/lib/auth/session";
import { AUDIENCE_LABELS, canChange, visibleAudiences } from "@/lib/kb/access";
import { reviewQueue } from "@/lib/kb/queries";
import { CATEGORIES, formatAgo } from "@/lib/tickets/format";
import { BulkEdit, RowSelect, SelectAllOnPage } from "../BulkEdit";

export const metadata: Metadata = { title: "Review" };
export const dynamic = "force-dynamic";

/** Everything waiting for a decision: submitted versions, then drafts the pipeline wrote. */
export default async function ReviewPage() {
  const staff = await requireStaff("kb.view");
  const audiences = visibleAudiences(staff);
  const waiting = await reviewQueue(audiences);
  type Row = (typeof waiting)[number];
  const canBulk = staff.can("kb.edit");
  const columns: DataTableColumn<Row>[] = [
    ...(canBulk ? [{ key: "select", header: <span className="vh">Select</span>, cell: (r: Row) => <RowSelect id={r.id} title={r.title} /> }] : []),
    { key: "title", header: "Article", cell: (r) => <Link href={`/admin/kb/articles/${r.id}`}>{r.title}</Link> },
    { key: "for", header: "For", cell: (r) => <Badge>{AUDIENCE_LABELS[r.audience]}</Badge> },
    { key: "what", header: "Waiting for", cell: (r) => (r.status === "in_review" ? (r.published ? "Approval of changes" : "Approval") : "A first read") },
    { key: "by", header: "By", cell: (r) => r.author },
    { key: "at", header: "Since", cell: (r) => formatAgo(r.at) },
  ];
  const shown = waiting.slice(0, 200);
  return (
    <Stack>
      <PageHeader title="Review" description="Versions sent for approval, and drafts written from past tickets and emails. Nothing here reaches the chatbot until it's published." />
      {canBulk && (
        <Panel title="Decide on several at once" description="Read each draft before publishing it: the chatbot answers from whatever is published. Anything your role can't approve is skipped.">
          <BulkEdit mode="review" canApprove={staff.can("kb.approve")} audiences={audiences.filter((a) => canChange(staff, "kb.edit", a))} categories={CATEGORIES} allCount={waiting.length} />
        </Panel>
      )}
      <DataTable
        label="Waiting for review"
        columns={columns}
        rows={shown}
        rowKey={(r) => r.id}
        total={shown.length}
        noun={waiting.length > shown.length ? `articles (the oldest 200 of ${waiting.length})` : "articles"}
        actions={canBulk && shown.length > 0 ? <SelectAllOnPage /> : undefined}
        empty={<EmptyState title="Nothing waiting">New drafts from imports and submitted changes appear here.</EmptyState>}
      />
    </Stack>
  );
}
