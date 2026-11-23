import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Button, DataTable, EmptyState, PageHeader, Select, Stack, Status, TextField, type DataTableColumn } from "@whyte/design-system";
import { FilterLayout, FilterToggle } from "@whyte/design-system/client";
import { requireStaff } from "@/lib/auth/session";
import { TICKET_PRIORITIES, TICKET_STATUSES } from "@/lib/db/schema";
import { formatAgo, PRIORITY_LABELS, ref, SEGMENT_LABELS, STATUS_LABELS, STATUS_TONES } from "@/lib/tickets/format";
import { assignableStaff, listTickets, PAGE_SIZE, parseQueueFilters, queueHref, type QueueRow, type SortKey } from "@/lib/tickets/queries";

export const metadata: Metadata = { title: "Tickets" };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function TicketsPage({ searchParams }: { searchParams: SP }) {
  const staff = await requireStaff("tickets.view");
  const segments = staff.segmentsFor("tickets.view");
  const f = parseQueueFilters(await searchParams);
  const [{ rows, total }, people] = await Promise.all([
    listTickets(f, { id: staff.id, segments }),
    Promise.all(segments.map(assignableStaff)).then((lists) => [...new Map(lists.flat().map((p) => [p.id, p])).values()]),
  ]);

  const columns: DataTableColumn<QueueRow>[] = [
    { key: "number", header: "Ref", sortable: true, cell: (r) => <Link href={`/admin/tickets/${r.number}`}>{ref(r.number)}</Link> },
    { key: "subject", header: "Subject", cell: (r) => r.subject },
    { key: "contact", header: "Contact", cell: (r) => r.contactName || r.contactEmail || "No contact" },
    { key: "segment", header: "Segment", cell: (r) => <Badge>{SEGMENT_LABELS[r.segment]}</Badge> },
    { key: "status", header: "Status", cell: (r) => <Status tone={STATUS_TONES[r.status]}>{STATUS_LABELS[r.status]}</Status> },
    { key: "priority", header: "Priority", sortable: true, cell: (r) => PRIORITY_LABELS[r.priority] },
    { key: "assignee", header: "Assignee", cell: (r) => r.assigneeName ?? "Unassigned" },
    { key: "updated", header: "Updated", sortable: true, cell: (r) => <time dateTime={r.updatedAt.toISOString()}>{formatAgo(r.updatedAt)}</time> },
  ];

  const statusValue = Array.isArray(f.status) ? f.status.join(",") : f.status;
  const filterCount = [f.status !== "open", f.priority, f.segment, f.assignee, f.q].filter(Boolean).length;
  const sortKey = f.sort === "updated" || f.sort === "number" || f.sort === "priority" ? f.sort : undefined;

  return (
    <Stack>
      <PageHeader
        title="Tickets"
        actions={staff.can("tickets.create") ? <Button href="/admin/tickets/new">New ticket</Button> : undefined}
      />
      <FilterLayout
        count={filterCount}
        clear={filterCount ? <Link href="/admin/tickets" className="btn-t">Clear filters</Link> : undefined}
        filters={
          <form action="/admin/tickets" className="ds-stack ds-stack-small" role="search">
            <TextField label="Search" name="q" type="search" size="small" defaultValue={f.q} placeholder="Ref, name, frame no., words" />
            <Select label="Status" name="status" size="small" defaultValue={statusValue}>
              <option value="open">Open (not resolved)</option>
              <option value="all">All</option>
              {TICKET_STATUSES.map((s) => (
                <option key={s} value={s}>{STATUS_LABELS[s]}</option>
              ))}
            </Select>
            <Select label="Assignee" name="assignee" size="small" defaultValue={f.assignee ?? ""}>
              <option value="">Anyone</option>
              <option value="me">Me</option>
              <option value="unassigned">Unassigned</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
            <Select label="Priority" name="priority" size="small" defaultValue={f.priority ?? ""}>
              <option value="">Any</option>
              {TICKET_PRIORITIES.map((p) => (
                <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
              ))}
            </Select>
            {segments.length > 1 && (
              <Select label="Segment" name="segment" size="small" defaultValue={f.segment ?? ""}>
                <option value="">B2C and B2B</option>
                <option value="b2c">B2C</option>
                <option value="b2b">B2B</option>
              </Select>
            )}
            <div className="ds-inline">
              <Button type="submit" size="small">Apply</Button>
            </div>
          </form>
        }
      >
        <DataTable
          label="Tickets"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          total={total}
          page={f.page}
          pageSize={PAGE_SIZE}
          noun="tickets"
          sort={sortKey ? { key: sortKey, direction: f.dir } : undefined}
          sortHref={(key) => queueHref(f, { sort: key as SortKey, dir: f.sort === key && f.dir === "descending" ? "ascending" : "descending", page: 1 })}
          pageHref={(page) => queueHref(f, { page })}
          actions={<FilterToggle />}
          renderLink={({ children, ...p }) => <Link {...p}>{children}</Link>}
          empty={
            <EmptyState title={f.q ? "No tickets match that search" : "No tickets here"}>
              {filterCount ? "Try fewer filters." : "New tickets from the form, email and chatbot will appear here."}
            </EmptyState>
          }
        />
      </FilterLayout>
    </Stack>
  );
}
