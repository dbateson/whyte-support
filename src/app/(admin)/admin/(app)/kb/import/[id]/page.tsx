import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, notLike } from "drizzle-orm";
import { Alert, Breadcrumb, CardGrid, DataTable, GridItem, MetricCard, PageHeader, Stack, Status, type DataTableColumn } from "@whyte/design-system";
import { requireStaff } from "@/lib/auth/session";
import { db, schema } from "@/lib/db";
import { jobStats } from "@/lib/ingest/pipeline";
import { formatAgo } from "@/lib/tickets/format";
import { JOB_KIND, JOB_STATUS } from "../labels";
import { JobRunner } from "./JobRunner";

export const metadata: Metadata = { title: "Import" };
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ITEM_STATUS = {
  pending: { label: "Waiting", tone: "neutral" },
  extracted: { label: "Answer found: waiting for a second", tone: "neutral" },
  drafted: { label: "In a draft", tone: "success" },
  skipped: { label: "Not used", tone: "neutral" },
  failed: { label: "Failed", tone: "error" },
} as const;

type Item = typeof schema.ingestItems.$inferSelect;

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff("kb.edit");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [job] = await db().select().from(schema.ingestJobs).where(eq(schema.ingestJobs.id, id));
  if (!job) notFound();
  const [stats, items] = await Promise.all([
    jobStats(id),
    db().select().from(schema.ingestItems).where(and(eq(schema.ingestItems.jobId, id), notLike(schema.ingestItems.externalId, "msg:%"))).orderBy(desc(schema.ingestItems.updatedAt)).limit(100),
  ]);
  const status = JOB_STATUS[job.status];
  const p = job.params as { size?: number; offset?: number; urls?: string[]; index?: number };
  const reading =
    job.status === "importing" && p.size ? `${Math.round(((p.offset ?? 0) / p.size) * 100)}% of the file read` : job.status === "importing" && p.urls ? `${p.index ?? 0} of ${p.urls.length} pages read` : null;
  const columns: DataTableColumn<Item>[] = [
    { key: "title", header: "Conversation or page", cell: (i) => i.title || i.externalId.replace(/^thread:/, "").slice(0, 80) },
    { key: "topic", header: "Topic", cell: (i) => i.topic ?? "" },
    { key: "status", header: "Status", cell: (i) => <Status tone={ITEM_STATUS[i.status].tone}>{ITEM_STATUS[i.status].label}</Status> },
    { key: "article", header: "Draft", cell: (i) => (i.articleId ? <Link href={`/admin/kb/articles/${i.articleId}`}>Open</Link> : (i.error ?? "")) },
  ];
  return (
    <Stack>
      <PageHeader
        breadcrumb={<Breadcrumb items={[{ label: "Import", href: "/admin/kb/import" }, { label: job.label }]} />}
        title={job.label}
        description={
          <span className="ds-inline ds-inline-small">
            <Status tone={status.tone}>{status.label}</Status>
            <span>{JOB_KIND[job.kind]} · started {formatAgo(job.createdAt)}{reading ? ` · ${reading}` : ""}</span>
          </span>
        }
      />
      {job.error && <Alert tone="error" title="The import stopped">{job.error}</Alert>}
      <JobRunner jobId={job.id} active={["importing", "extracting", "drafting"].includes(job.status)} />
      <CardGrid label="Progress">
        <GridItem span={3}>
          <MetricCard title="Waiting" value={stats.pending.toLocaleString("en-GB")} />
        </GridItem>
        <GridItem span={3}>
          <MetricCard title="Answers found" value={(stats.extracted + stats.drafted).toLocaleString("en-GB")} />
        </GridItem>
        <GridItem span={3}>
          <MetricCard title="Not used" value={stats.skipped.toLocaleString("en-GB")} />
        </GridItem>
        <GridItem span={3}>
          <MetricCard title="Draft articles" value={stats.articles.toLocaleString("en-GB")} href="/admin/kb/review" renderLink={({ children, ...p2 }) => <Link {...p2}>{children}</Link>} />
        </GridItem>
      </CardGrid>
      <DataTable label="Items" columns={columns} rows={items} rowKey={(i) => i.id} total={items.length} noun="most recent items" />
    </Stack>
  );
}
