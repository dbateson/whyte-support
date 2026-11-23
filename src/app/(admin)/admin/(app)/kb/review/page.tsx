import type { Metadata } from "next";
import Link from "next/link";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { Badge, DataTable, EmptyState, PageHeader, Stack, type DataTableColumn } from "@whyte/design-system";
import { requireStaff } from "@/lib/auth/session";
import { db, schema } from "@/lib/db";
import { AUDIENCE_LABELS, visibleAudiences } from "@/lib/kb/access";
import { formatAgo } from "@/lib/tickets/format";

export const metadata: Metadata = { title: "Review" };
export const dynamic = "force-dynamic";

/** Everything waiting for a decision: submitted versions, then drafts the pipeline wrote. */
export default async function ReviewPage() {
  const staff = await requireStaff("kb.view");
  const audiences = visibleAudiences(staff);
  const rows = audiences.length
    ? await db()
        .select({ id: schema.kbArticles.id, audience: schema.kbArticles.audience, origin: schema.kbArticles.origin, title: schema.kbArticleVersions.title, status: schema.kbArticleVersions.status, author: schema.kbArticleVersions.authorLabel, at: schema.kbArticleVersions.updatedAt, published: schema.kbArticles.publishedVersionId })
        .from(schema.kbArticles)
        .innerJoin(schema.kbArticleVersions, eq(schema.kbArticleVersions.id, schema.kbArticles.workingVersionId))
        .where(and(inArray(schema.kbArticles.audience, audiences), isNull(schema.kbArticles.retiredAt), inArray(schema.kbArticleVersions.status, ["in_review", "draft"])))
        .orderBy(asc(schema.kbArticleVersions.updatedAt))
        .limit(200)
    : [];
  const waiting = rows.filter((r) => r.status === "in_review" || r.origin !== "manual");
  type Row = (typeof rows)[number];
  const columns: DataTableColumn<Row>[] = [
    { key: "title", header: "Article", cell: (r) => <Link href={`/admin/kb/articles/${r.id}`}>{r.title}</Link> },
    { key: "for", header: "For", cell: (r) => <Badge>{AUDIENCE_LABELS[r.audience]}</Badge> },
    { key: "what", header: "Waiting for", cell: (r) => (r.status === "in_review" ? (r.published ? "Approval of changes" : "Approval") : "A first read") },
    { key: "by", header: "By", cell: (r) => r.author },
    { key: "at", header: "Since", cell: (r) => formatAgo(r.at) },
  ];
  return (
    <Stack>
      <PageHeader title="Review" description="Versions sent for approval, and drafts written from past tickets and emails. Nothing here reaches the chatbot until it's published." />
      <DataTable label="Waiting for review" columns={columns} rows={waiting} rowKey={(r) => r.id} total={waiting.length} noun="articles" empty={<EmptyState title="Nothing waiting">New drafts from imports and submitted changes appear here.</EmptyState>} />
    </Stack>
  );
}
