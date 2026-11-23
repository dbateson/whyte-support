import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Badge, Button, DataTable, EmptyState, PageHeader, Select, Stack, Status, TextField, type DataTableColumn } from "@whyte/design-system";
import { FilterLayout, FilterToggle } from "@whyte/design-system/client";
import { requireStaff } from "@/lib/auth/session";
import { AUDIENCE_LABELS, visibleAudiences } from "@/lib/kb/access";
import { kbHref, KB_PAGE_SIZE, listArticles, parseKbFilters } from "@/lib/kb/queries";
import { STATE_LABELS } from "@/lib/kb/labels";
import { articleState } from "@/lib/kb/service";
import { formatAgo } from "@/lib/tickets/format";

export const metadata: Metadata = { title: "Knowledge base" };


const ORIGIN = { manual: "Written by staff", ingestion: "Drafted from history", ticket: "From a ticket" } as const;

type Row = Awaited<ReturnType<typeof listArticles>>["rows"][number];

export default async function KbPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff("kb.view");
  const sp = await searchParams;
  const f = parseKbFilters(sp);
  const audiences = visibleAudiences(staff);
  const { rows, total } = await listArticles(f, audiences);
  const filterCount = [f.q, f.state !== "all", f.audience].filter(Boolean).length;
  const columns: DataTableColumn<Row>[] = [
    { key: "title", header: "Article", cell: (r) => <Link href={`/admin/kb/articles/${r.id}`}>{r.title}</Link> },
    { key: "audience", header: "For", cell: (r) => <Badge>{AUDIENCE_LABELS[r.audience]}</Badge> },
    {
      key: "state",
      header: "Status",
      cell: (r) => {
        const s = STATE_LABELS[articleState(r)];
        return <Status tone={s.tone}>{s.label}</Status>;
      },
    },
    { key: "category", header: "Category", cell: (r) => r.category ?? "None" },
    { key: "origin", header: "Origin", cell: (r) => ORIGIN[r.origin] },
    { key: "updated", header: "Updated", cell: (r) => formatAgo(r.updatedAt) },
  ];
  return (
    <Stack>
      <PageHeader
        title="Knowledge base"
        description="The chatbot answers only from published articles. Drafts, including ones written from past tickets and emails, need approval first."
        actions={staff.can("kb.edit") ? <Button href="/admin/kb/articles/new">New article</Button> : undefined}
      />
      {sp.deleted && <Alert tone="success">Draft deleted.</Alert>}
      <FilterLayout
        count={filterCount}
        clear={filterCount ? <Link href="/admin/kb" className="btn-t">Clear filters</Link> : undefined}
        filters={
          <form action="/admin/kb" className="ds-stack ds-stack-small" role="search">
            <TextField label="Search" name="q" type="search" size="small" defaultValue={f.q} />
            <Select label="Status" name="state" size="small" defaultValue={f.state}>
              <option value="all">Any</option>
              <option value="published">Published</option>
              <option value="changes">Published, changes in progress</option>
              <option value="review">In review</option>
              <option value="draft">Draft</option>
              <option value="retired">Retired</option>
            </Select>
            <Select label="For" name="audience" size="small" defaultValue={f.audience ?? ""}>
              <option value="">Anyone</option>
              {audiences.map((a) => (
                <option key={a} value={a}>{AUDIENCE_LABELS[a]}</option>
              ))}
            </Select>
            <div className="ds-inline">
              <Button type="submit" size="small">Apply</Button>
            </div>
          </form>
        }
      >
        <DataTable
          label="Articles"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          total={total}
          page={f.page}
          pageSize={KB_PAGE_SIZE}
          pageHref={(page) => kbHref(f, { page })}
          noun="articles"
          actions={<FilterToggle />}
          renderLink={({ children, ...p }) => <Link {...p}>{children}</Link>}
          empty={<EmptyState title={filterCount ? "No articles match" : "No articles yet"}>{filterCount ? "Try fewer filters." : "Write one, or import past emails, Zoho cases and whytebikes.com pages."}</EmptyState>}
        />
      </FilterLayout>
    </Stack>
  );
}
