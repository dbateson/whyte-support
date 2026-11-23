import type { Metadata } from "next";
import Link from "next/link";
import { desc } from "drizzle-orm";
import { CardGrid, DataTable, GridItem, PageHeader, Stack, Status, type DataTableColumn } from "@whyte/design-system";
import { requireStaff } from "@/lib/auth/session";
import { db, schema } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { formatAgo } from "@/lib/tickets/format";
import { ImportForms } from "./ImportForms";
import { JOB_KIND, JOB_STATUS } from "./labels";

export const metadata: Metadata = { title: "Import" };
export const dynamic = "force-dynamic";

type Row = typeof schema.ingestJobs.$inferSelect;

export default async function ImportPage() {
  await requireStaff("kb.edit");
  const [jobs, from] = await Promise.all([db().select().from(schema.ingestJobs).orderBy(desc(schema.ingestJobs.createdAt)).limit(50), getSetting("email.from_address")]);
  const domain = from.split("@")[1] || "whytebikes.com";
  const columns: DataTableColumn<Row>[] = [
    { key: "label", header: "Import", cell: (j) => <Link href={`/admin/kb/import/${j.id}`}>{j.label}</Link> },
    { key: "kind", header: "Source", cell: (j) => JOB_KIND[j.kind] },
    { key: "status", header: "Status", cell: (j) => <Status tone={JOB_STATUS[j.status].tone}>{JOB_STATUS[j.status].label}</Status> },
    { key: "articles", header: "Draft articles", numeric: true, cell: (j) => (j.stats as { articles?: number }).articles ?? 0 },
    { key: "when", header: "Started", cell: (j) => formatAgo(j.createdAt) },
  ];
  return (
    <Stack>
      <PageHeader
        title="Import"
        description="Turn past support emails, Zoho cases and whytebikes.com into draft articles. Personal details are removed first; every draft waits in Review until someone publishes it."
      />
      <CardGrid>
        <GridItem span={8}>
          <ImportForms defaultDomains={domain} />
        </GridItem>
        <GridItem span={4}>
          <DataTable label="Imports" columns={columns.filter((c) => c.key !== "kind" && c.key !== "when")} rows={jobs} rowKey={(j) => j.id} total={jobs.length} noun="imports" />
        </GridItem>
      </CardGrid>
    </Stack>
  );
}
