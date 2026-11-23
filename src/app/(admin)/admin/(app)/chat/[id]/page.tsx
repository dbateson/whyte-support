import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Breadcrumb, ChatMessage, ChatThread, DataTable, DescriptionList, PageHeader, Panel, Stack, Status, type DataTableColumn } from "@whyte/design-system";
import { Markdown } from "@/components/Markdown";
import { requireStaff } from "@/lib/auth/session";
import { OUTCOME_LABELS } from "@/lib/chat/labels";
import { getChat } from "@/lib/chat/queries";
import { formatAgo } from "@/lib/tickets/format";

export const metadata: Metadata = { title: "Conversation" };
export const dynamic = "force-dynamic";

type Chat = NonNullable<Awaited<ReturnType<typeof getChat>>>;
type Source = Chat["messages"][number]["sources"][number];

const time = (d: Date) => d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });

export default async function ChatDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaff("chat.view");
  const chat = await getChat((await params).id);
  if (!chat || !staff.can("chat.view", chat.segment)) notFound();
  const details = chat.details as { product?: string; frameNumber?: string; orderNumber?: string };
  const answers = chat.messages.filter((m) => m.role === "assistant");
  const tokens = answers.reduce((n, m) => n + (m.inputTokens ?? 0) + (m.outputTokens ?? 0), 0);

  const columns: DataTableColumn<Source>[] = [
    { key: "rank", header: "Rank", cell: (s) => s.rank },
    { key: "used", header: "Used", cell: (s) => (s.cited ? <Status tone="success">Cited</Status> : <Status tone="neutral">Given, not cited</Status>) },
    {
      key: "passage",
      header: "Passage",
      cell: (s) => (
        <span>
          {s.articleId ? <Link href={`/admin/kb/articles/${s.articleId}`}>{s.heading}</Link> : `${s.heading} (article deleted)`}
          {s.versionNumber ? ` · version ${s.versionNumber}` : ""}
          <br />
          {s.content.length > 240 ? `${s.content.slice(0, 240)}…` : s.content}
        </span>
      ),
    },
    { key: "score", header: "Score", cell: (s) => Number(s.score).toFixed(3) },
  ];

  return (
    <Stack>
      <PageHeader
        breadcrumb={<Breadcrumb items={[{ label: "Chatbot", href: "/admin/chat" }, { label: "Conversation" }]} />}
        title={chat.messages.find((m) => m.role === "user")?.content.slice(0, 90) ?? "Conversation"}
      />
      <DescriptionList
        items={[
          { term: "From", detail: <Badge>{chat.segment === "b2b" ? "B2B" : "B2C"}</Badge> },
          { term: "Started", detail: `${time(chat.createdAt)} (${formatAgo(chat.createdAt)})` },
          { term: "Site", detail: chat.origin || "Unknown" },
          { term: "Ticket", detail: chat.ticketNumber ? <Link href={`/admin/tickets/${chat.ticketNumber}`}>WS-{chat.ticketNumber}</Link> : "None" },
          { term: "Signed in to Shopify", detail: chat.shopifyCustomerId ? "Yes" : "No" },
          { term: "Tokens", detail: tokens.toLocaleString("en-GB") },
          ...(details.product ? [{ term: "Bike", detail: details.product }] : []),
          ...(details.frameNumber ? [{ term: "Frame number", detail: details.frameNumber }] : []),
          ...(details.orderNumber ? [{ term: "Order", detail: details.orderNumber }] : []),
        ]}
      />
      <Panel title="Transcript">
        <ChatThread label="Transcript">
          {chat.messages.map((m) =>
            m.role === "user" ? (
              <ChatMessage key={m.id} role="user" author="Customer" meta={time(m.createdAt)}>
                {m.content}
              </ChatMessage>
            ) : (
              <ChatMessage
                key={m.id}
                role="assistant"
                author="Assistant"
                meta={
                  <>
                    {m.outcome && <Status tone={OUTCOME_LABELS[m.outcome].tone}>{OUTCOME_LABELS[m.outcome].label}</Status>}{" "}
                    {time(m.createdAt)} · {m.model ?? "no model"} · {(m.inputTokens ?? 0) + (m.outputTokens ?? 0)} tokens · {m.latencyMs != null ? `${(m.latencyMs / 1000).toFixed(1)}s` : ""}
                    {m.feedback === 1 ? " · rated helpful" : m.feedback === -1 ? " · rated unhelpful" : ""}
                    {" · "}
                    {m.sources.filter((s) => s.cited).length} of {m.sources.length} passages cited
                  </>
                }
              >
                <Markdown>{m.content}</Markdown>
              </ChatMessage>
            ),
          )}
        </ChatThread>
      </Panel>
      {answers.map((m, i) =>
        m.sources.length ? (
          <Panel key={m.id} title={`Sources for answer ${i + 1}`} description="Everything the assistant was given, in search order. Only cited passages may support an answer.">
            <DataTable label={`Sources for answer ${i + 1}`} columns={columns} rows={m.sources} rowKey={(s) => String(s.id)} total={m.sources.length} noun="passages" />
          </Panel>
        ) : null,
      )}
    </Stack>
  );
}
