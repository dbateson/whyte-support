import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  Alert,
  Badge,
  Breadcrumb,
  ChatAttachment,
  Button,
  CardGrid,
  DescriptionList,
  GridItem,
  PageHeader,
  Panel,
  Select,
  Stack,
  Status,
  TextArea,
  TextField,
  TicketEvent,
  TicketMessage,
  TicketThread,
} from "@whyte/design-system";
import { ActionForm } from "@/components/ActionForm";
import { MessageBody } from "@/components/MessageBody";
import { requireStaff } from "@/lib/auth/session";
import { TICKET_PRIORITIES, TICKET_STATUSES } from "@/lib/db/schema";
import {
  CATEGORIES,
  formatBytes,
  formatDate,
  formatDateTime,
  parseRef,
  PRIORITY_LABELS,
  ref,
  SEGMENT_LABELS,
  SOURCE_LABELS,
  STATUS_LABELS,
  STATUS_TONES,
} from "@/lib/tickets/format";
import { attachmentsForTicket } from "@/lib/storage/attachments";
import { assignableStaff, getThread, getTicketByNumber } from "@/lib/tickets/queries";
import { assignToMe, replyToTicket, retryEmail, updateTicketDetails } from "../actions";

type Params = Promise<{ number: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const n = parseRef((await params).number);
  return { title: n ? ref(n) : "Ticket" };
}

const EVENT_TEXT: Record<string, (from: string | null, to: string | null) => string> = {
  status: (_, to) => `changed the status to ${to}`,
  priority: (_, to) => `changed the priority to ${to}`,
  assignee: (_, to) => (to ? `assigned it to ${to}` : "unassigned it"),
  segment: (_, to) => `moved it to ${to}`,
  category: (_, to) => (to ? `set the category to ${to}` : "cleared the category"),
  reopened: () => "reopened it: the customer replied",
};

export default async function TicketPage({ params, searchParams }: { params: Params; searchParams: Promise<{ created?: string }> }) {
  const staff = await requireStaff("tickets.view");
  const number = parseRef((await params).number);
  const row = number ? await getTicketByNumber(number) : null;
  if (!row || !staff.can("tickets.view", row.ticket.segment)) notFound();
  const { ticket, contact } = row;
  const { created } = await searchParams;
  const [thread, people, attachments] = await Promise.all([getThread(ticket.id), assignableStaff(ticket.segment), attachmentsForTicket(ticket.id)]);
  const filesFor = (messageId: string) => attachments.filter((a) => a.messageId === messageId);
  const assignee = people.find((p) => p.id === ticket.assigneeId);
  const may = {
    reply: staff.can("tickets.reply", ticket.segment),
    note: staff.can("tickets.note", ticket.segment),
    update: staff.can("tickets.update", ticket.segment),
    assign: staff.can("tickets.assign", ticket.segment),
  };

  return (
    <Stack>
      <PageHeader
        breadcrumb={<Breadcrumb items={[{ label: "Tickets", href: "/admin/tickets" }, { label: ref(ticket.number) }]} />}
        title={ticket.subject}
        description={
          <span className="ds-inline ds-inline-small">
            <span>{ref(ticket.number)}</span>
            <Badge>{SEGMENT_LABELS[ticket.segment]}</Badge>
            <Status tone={STATUS_TONES[ticket.status]}>{STATUS_LABELS[ticket.status]}</Status>
            <span>
              {SOURCE_LABELS[ticket.source]}, {formatDateTime(ticket.createdAt)}
            </span>
          </span>
        }
        actions={
          !ticket.assigneeId && may.assign && may.reply ? (
            <form action={assignToMe}>
              <input type="hidden" name="number" value={ticket.number} />
              <Button type="submit" variant="secondary">Assign to me</Button>
            </form>
          ) : undefined
        }
      />
      {created && <Alert tone="success">Ticket {created} created.</Alert>}
      <CardGrid>
        <GridItem span={8}>
          <Stack>
            <TicketThread label={`History of ${ref(ticket.number)}`}>
              {thread.map((item) =>
                item.kind === "event" ? (
                  <TicketEvent key={`e${item.event.id}`} meta={formatDateTime(item.at)}>
                    {item.event.actorLabel} {EVENT_TEXT[item.event.type]?.(item.event.fromValue, item.event.toValue) ?? "changed the ticket"}
                  </TicketEvent>
                ) : (
                  <TicketMessage
                    key={item.message.id}
                    from={item.message.authorType === "customer" ? "customer" : item.message.authorType === "assistant" ? "assistant" : "agent"}
                    author={item.message.authorName || (item.message.authorType === "customer" ? "Customer" : "Whyte")}
                    internal={item.message.internal}
                    meta={[
                      formatDateTime(item.message.createdAt),
                      item.message.channel === "email" ? "Email" : item.message.channel === "web" ? "Web" : item.message.channel === "chat" ? "Chat" : null,
                      item.message.emailStatus === "sending" ? "Sending" : item.message.emailStatus === "failed" ? "Not sent" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    footer={
                      filesFor(item.message.id).length > 0 ? (
                        <div className="ds-inline ds-inline-small">
                          {filesFor(item.message.id).map((a) => (
                            <ChatAttachment key={a.id} name={a.fileName} detail={`${a.contentType.split("/")[1]?.toUpperCase() ?? "File"} · ${formatBytes(a.sizeBytes)}`} href={`/admin/attachments/${a.id}`} />
                          ))}
                        </div>
                      ) : item.message.emailStatus === "failed" && may.reply ? (
                        <ActionForm action={retryEmail} label="Resend email">
                          <Alert tone="error">{item.message.emailError ?? "The email wasn't sent."}</Alert>
                          <input type="hidden" name="number" value={ticket.number} />
                          <input type="hidden" name="messageId" value={item.message.id} />
                          <div className="ds-inline">
                            <Button type="submit" size="small" variant="secondary">Send again</Button>
                          </div>
                        </ActionForm>
                      ) : undefined
                    }
                  >
                    <MessageBody text={item.message.body} />
                  </TicketMessage>
                ),
              )}
            </TicketThread>
            {(may.reply || may.note) && (
              <Panel title={may.reply ? "Reply" : "Internal note"} description={may.reply ? (contact?.email ? `Emailed to ${contact.email}` : "This contact has no email address, so replies can't be sent.") : undefined}>
                <ActionForm action={replyToTicket} resetOnSuccess label="Reply or note">
                  <input type="hidden" name="number" value={ticket.number} />
                  <TextArea label="Message" name="body" rows={6} required />
                  {may.reply && may.update && (
                    <Select label="Then set the status to" name="statusAfter" size="small" defaultValue="pending_customer" help="Applies to replies, not notes.">
                      {TICKET_STATUSES.map((s) => (
                        <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                      ))}
                    </Select>
                  )}
                  <div className="ds-inline">
                    {may.reply && contact?.email && (
                      <Button type="submit" name="intent" value="reply">Send reply</Button>
                    )}
                    {may.note && (
                      <Button type="submit" name="intent" value="note" variant="secondary">Add internal note</Button>
                    )}
                  </div>
                </ActionForm>
              </Panel>
            )}
          </Stack>
        </GridItem>
        <GridItem span={4}>
          <Stack>
            <Panel title="Details">
              {may.update ? (
                <ActionForm action={updateTicketDetails} label="Ticket details">
                  <input type="hidden" name="number" value={ticket.number} />
                  {/* Re-keyed when the ticket changes, so the fields show its current values. */}
                  <Stack gap="small" key={ticket.updatedAt.toISOString()}>
                  {(
                    [
                      ["status", ticket.status],
                      ["priority", ticket.priority],
                      ["assigneeId", ticket.assigneeId ?? ""],
                      ["segment", ticket.segment],
                      ["category", ticket.category ?? ""],
                      ["productModel", ticket.productModel ?? ""],
                      ["frameNumber", ticket.frameNumber ?? ""],
                      ["purchaseDate", ticket.purchaseDate ?? ""],
                    ] as const
                  ).map(([k, v]) => (
                    <input key={k} type="hidden" name={`was:${k}`} value={v} />
                  ))}
                  <Select label="Status" name="status" size="small" defaultValue={ticket.status}>
                    {TICKET_STATUSES.map((s) => (
                      <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                    ))}
                  </Select>
                  <Select label="Priority" name="priority" size="small" defaultValue={ticket.priority}>
                    {TICKET_PRIORITIES.map((p) => (
                      <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
                    ))}
                  </Select>
                  <Select label="Assignee" name="assigneeId" size="small" defaultValue={ticket.assigneeId ?? ""} disabled={!may.assign}>
                    <option value="">Unassigned</option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </Select>
                  <Select label="Segment" name="segment" size="small" defaultValue={ticket.segment}>
                    {staff.segmentsFor("tickets.update").map((s) => (
                      <option key={s} value={s}>{SEGMENT_LABELS[s]}</option>
                    ))}
                  </Select>
                  <Select label="Category" name="category" size="small" defaultValue={ticket.category ?? ""}>
                    <option value="">None</option>
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </Select>
                  <TextField label="Bike model" name="productModel" size="small" defaultValue={ticket.productModel ?? ""} />
                  <TextField label="Frame number" name="frameNumber" size="small" defaultValue={ticket.frameNumber ?? ""} />
                  <TextField label="Purchase date" name="purchaseDate" type="date" size="small" defaultValue={ticket.purchaseDate ?? ""} />
                  </Stack>
                  <div className="ds-inline">
                    <Button type="submit" size="small">Save details</Button>
                  </div>
                </ActionForm>
              ) : (
                <DescriptionList
                  items={[
                    { term: "Priority", detail: PRIORITY_LABELS[ticket.priority] },
                    { term: "Assignee", detail: assignee?.name ?? "Unassigned" },
                    { term: "Category", detail: ticket.category ?? "None" },
                    { term: "Bike model", detail: ticket.productModel ?? "Not given" },
                    { term: "Frame number", detail: ticket.frameNumber ?? "Not given" },
                    { term: "Purchase date", detail: ticket.purchaseDate ? formatDate(new Date(ticket.purchaseDate)) : "Not given" },
                  ]}
                />
              )}
            </Panel>
            <Panel title="Customer">
              <DescriptionList
                items={[
                  { term: "Name", detail: contact?.name || "Not given" },
                  { term: "Email", detail: contact?.email ?? "None" },
                  { term: "Phone", detail: contact?.phone ?? "None" },
                  ...(contact?.companyName ? [{ term: "Business", detail: contact.companyName }] : []),
                  ...(contact?.accountCode ? [{ term: "Account number", detail: contact.accountCode }] : []),
                  ...(contact?.shopifyCustomerId ? [{ term: "Shopify", detail: "Signed in when they wrote" }] : []),
                  ...(ticket.purchasedFrom ? [{ term: "Bought from", detail: ticket.purchasedFrom }] : []),
                  ...(ticket.orderNumber ? [{ term: "Order number", detail: ticket.orderNumber }] : []),
                ]}
              />
            </Panel>
          </Stack>
        </GridItem>
      </CardGrid>
    </Stack>
  );
}
