import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Button, CardGrid, DataTable, EmptyState, GridItem, MetricCard, PageHeader, Select, Stack, Status, type DataTableColumn } from "@whyte/design-system";
import { FilterLayout, FilterToggle } from "@whyte/design-system/client";
import { requireStaff } from "@/lib/auth/session";
import { OUTCOME_LABELS } from "@/lib/chat/labels";
import { CHAT_PAGE_SIZE, chatHref, chatStats, listChats, parseChatFilters } from "@/lib/chat/queries";
import { CHAT_OUTCOMES, type ChatOutcome } from "@/lib/db/schema";
import { formatAgo } from "@/lib/tickets/format";

export const metadata: Metadata = { title: "Chatbot" };
export const dynamic = "force-dynamic";

type Row = Awaited<ReturnType<typeof listChats>>["rows"][number];

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "–");

/** The worst outcome in a conversation, which is what staff need to see first. */
const WORST: ChatOutcome[] = ["error", "needs_human", "no_answer", "declined", "partial", "answered"];

export default async function ChatPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff("chat.view");
  const segments = staff.segmentsFor("chat.view");
  const f = parseChatFilters(await searchParams);
  const [{ rows, total }, stats] = await Promise.all([listChats(f, segments), chatStats(segments)]);
  const answered = (stats.outcomes.answered ?? 0) + (stats.outcomes.partial ?? 0);
  const filterCount = [f.segment, f.outcome].filter(Boolean).length;

  const columns: DataTableColumn<Row>[] = [
    { key: "question", header: "First question", cell: (r) => <Link href={`/admin/chat/${r.id}`}>{(r.firstQuestion ?? "No messages").slice(0, 90)}</Link> },
    { key: "segment", header: "From", cell: (r) => <Badge>{r.segment === "b2b" ? "B2B" : "B2C"}</Badge> },
    {
      key: "outcome",
      header: "How it went",
      cell: (r) => {
        const worst = WORST.find((o) => r.outcomes?.includes(o));
        return worst ? <Status tone={OUTCOME_LABELS[worst].tone}>{OUTCOME_LABELS[worst].label}</Status> : "No answers";
      },
    },
    { key: "feedback", header: "Feedback", cell: (r) => (r.helpful || r.unhelpful ? `${r.helpful} helpful, ${r.unhelpful} not` : "None") },
    { key: "ticket", header: "Ticket", cell: (r) => (r.ticketNumber ? <Link href={`/admin/tickets/${r.ticketNumber}`}>WS-{r.ticketNumber}</Link> : "") },
    { key: "last", header: "Last message", cell: (r) => formatAgo(r.lastMessageAt) },
  ];

  return (
    <Stack>
      <PageHeader title="Chatbot" description="Every conversation, with the knowledge-base passages behind each answer. Conversations are deleted after 12 months." />
      <CardGrid label="Last 30 days">
        <GridItem span={3}>
          <MetricCard title="Conversations, last 30 days" value={stats.chats.toLocaleString("en-GB")} />
        </GridItem>
        <GridItem span={3}>
          <MetricCard title="Answered from articles" value={pct(answered, stats.answers)} />
        </GridItem>
        <GridItem span={3}>
          <MetricCard title="Passed to the team" value={pct(stats.escalated, stats.chats)} href={chatHref({ page: 1, outcome: "escalated" })} renderLink={({ children, ...p }) => <Link {...p}>{children}</Link>} />
        </GridItem>
        <GridItem span={3}>
          <MetricCard title="Rated unhelpful" value={stats.unhelpful.toLocaleString("en-GB")} href={chatHref({ page: 1, outcome: "unhelpful" })} renderLink={({ children, ...p }) => <Link {...p}>{children}</Link>} />
        </GridItem>
      </CardGrid>
      <FilterLayout
        count={filterCount}
        clear={filterCount ? <Link href="/admin/chat" className="btn-t">Clear filters</Link> : undefined}
        filters={
          <form action="/admin/chat" className="ds-stack ds-stack-small">
            <Select label="Showing" name="outcome" size="small" defaultValue={f.outcome ?? ""}>
              <option value="">All conversations</option>
              <option value="escalated">Passed to the team</option>
              <option value="unhelpful">Rated unhelpful</option>
              {CHAT_OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  With an answer: {OUTCOME_LABELS[o].label.toLowerCase()}
                </option>
              ))}
            </Select>
            {segments.length > 1 && (
              <Select label="From" name="segment" size="small" defaultValue={f.segment ?? ""}>
                <option value="">Riders and dealers</option>
                <option value="b2c">Riders (B2C)</option>
                <option value="b2b">Dealers (B2B)</option>
              </Select>
            )}
            <div className="ds-inline">
              <Button type="submit" size="small">Apply</Button>
            </div>
          </form>
        }
      >
        <DataTable
          label="Conversations"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          total={total}
          page={f.page}
          pageSize={CHAT_PAGE_SIZE}
          pageHref={(page) => chatHref(f, { page })}
          noun="conversations"
          actions={<FilterToggle />}
          renderLink={({ children, ...p }) => <Link {...p}>{children}</Link>}
          empty={<EmptyState title={filterCount ? "No conversations match" : "No conversations yet"}>{filterCount ? "Try fewer filters." : "Once the Anthropic key is set and articles are published, conversations show here."}</EmptyState>}
        />
      </FilterLayout>
    </Stack>
  );
}
