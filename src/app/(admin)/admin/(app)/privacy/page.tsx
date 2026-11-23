import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Button, Checkbox, DataTable, DescriptionList, EmptyState, PageHeader, Panel, Stack, Status, TextField, type DataTableColumn } from "@whyte/design-system";
import { ActionForm } from "@/components/ActionForm";
import { requireStaff } from "@/lib/auth/session";
import { findSubject, recentRequests } from "@/lib/privacy/service";
import { getSettings } from "@/lib/settings";
import { formatAgo, STATUS_LABELS } from "@/lib/tickets/format";
import { eraseAction } from "./actions";

export const metadata: Metadata = { title: "Privacy requests" };
export const dynamic = "force-dynamic";

type Request = Awaited<ReturnType<typeof recentRequests>>[number];
type Ticket = NonNullable<Awaited<ReturnType<typeof findSubject>>>["tickets"][number];

const ACTION: Record<string, string> = { "gdpr.export": "Exported", "gdpr.erase": "Erased", "gdpr.retention": "Retention" };

export default async function PrivacyPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  await requireStaff("gdpr.process");
  const email = ((await searchParams).email ?? "").trim();
  const [found, requests, s] = await Promise.all([email ? findSubject(email) : null, recentRequests(), getSettings(["retention.ticket_years"])]);

  const ticketColumns: DataTableColumn<Ticket>[] = [
    { key: "ref", header: "Ticket", cell: (t) => <Link href={`/admin/tickets/${t.number}`}>WS-{t.number}</Link> },
    { key: "subject", header: "Subject", cell: (t) => t.subject },
    { key: "status", header: "Status", cell: (t) => (t.erasedAt ? <Status tone="neutral">Erased</Status> : STATUS_LABELS[t.status]) },
    { key: "zoho", header: "Zoho case", cell: (t) => t.zohoCaseNumber ?? "" },
    { key: "created", header: "Created", cell: (t) => t.createdAt.toLocaleDateString("en-GB") },
  ];
  const requestColumns: DataTableColumn<Request>[] = [
    { key: "at", header: "When", cell: (r) => formatAgo(r.at) },
    { key: "action", header: "What", cell: (r) => ACTION[r.action] ?? r.action },
    { key: "who", header: "By", cell: (r) => r.actor },
    {
      key: "detail",
      header: "Detail",
      cell: (r) => {
        const d = r.detail as { tickets?: string[] | number; files?: number; zoho?: string; contacts?: number };
        if (r.action === "gdpr.retention") return `${d.tickets} tickets, ${d.contacts} people`;
        return [Array.isArray(d.tickets) ? `${d.tickets.length} tickets` : `${d.tickets ?? 0} tickets`, d.files != null ? `${d.files} files` : null, d.zoho ? `Zoho: ${d.zoho}` : null].filter(Boolean).join(", ");
      },
    },
  ];

  return (
    <Stack>
      <PageHeader
        title="Privacy requests"
        description={`Find what's held about a person, export it, or erase it (UK GDPR: respond within one month). Closed tickets are erased automatically ${s["retention.ticket_years"]} years after they were last touched, and chats after 12 months.`}
      />
      <Panel title="Find a person">
        <form action="/admin/privacy" className="ds-stack ds-stack-small" role="search">
          <TextField label="Email address" name="email" type="email" defaultValue={email} />
          <div className="ds-inline">
            <Button type="submit" size="small">Find</Button>
          </div>
        </form>
      </Panel>

      {email && !found && <Alert tone="info">Nothing is held under {email}. (Chats that never became a ticket hold no email address.)</Alert>}

      {found && (
        <>
          <Panel
            title={found.contact.anonymisedAt ? "Already erased" : found.contact.name || found.contact.email || "This person"}
            actions={!found.contact.anonymisedAt ? <Button href={`/admin/privacy/export/${found.contact.id}`} size="small" variant="secondary">Export their data (JSON)</Button> : undefined}
          >
            <Stack gap="small">
              <DescriptionList
                items={[
                  { term: "Email", detail: found.contact.email ?? "Erased" },
                  { term: "Phone", detail: found.contact.phone ?? "None" },
                  { term: "Type", detail: found.contact.segment === "b2b" ? "Dealer or trade" : "Rider" },
                  { term: "In Zoho", detail: found.contact.zohoContactId ? "Yes" : "No" },
                  { term: "First contact", detail: found.contact.createdAt.toLocaleDateString("en-GB") },
                ]}
              />
              <DataTable label="Their tickets" columns={ticketColumns} rows={found.tickets} rowKey={(t) => t.id} total={found.tickets.length} noun="tickets" empty={<EmptyState title="No tickets" />} />
            </Stack>
          </Panel>
          {!found.contact.anonymisedAt && (
            <Panel title="Erase" description="Removes their name, contact details, every message on their tickets, their files and any chat that became a ticket. Ticket dates, categories and statuses stay, without anything personal, for statistics. This can't be undone.">
              <ActionForm action={eraseAction} label="Erase this person">
                <input type="hidden" name="contactId" value={found.contact.id} />
                <Checkbox name="zoho" label="Ask Zoho to erase its copy too" description="Creates a task in Zoho CRM naming the contact and cases, for someone to erase there." defaultChecked />
                <TextField label="Type ERASE to confirm" name="confirm" autoComplete="off" />
                <div className="ds-inline">
                  <Button type="submit" size="small">Erase everything about this person</Button>
                </div>
              </ActionForm>
            </Panel>
          )}
        </>
      )}

      <Panel title="Recent requests" description="Exports, erasures and retention runs. Email addresses aren't kept here.">
        <DataTable label="Recent privacy requests" columns={requestColumns} rows={requests} rowKey={(r) => String(r.id)} total={requests.length} noun="requests" empty={<EmptyState title="None yet" />} />
      </Panel>
    </Stack>
  );
}
