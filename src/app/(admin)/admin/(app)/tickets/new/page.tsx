import type { Metadata } from "next";
import { Breadcrumb, Button, Fieldset, PageHeader, Radio, Select, Stack, TextArea, TextField } from "@whyte/design-system";
import { ActionForm } from "@/components/ActionForm";
import { requireStaff } from "@/lib/auth/session";
import { TICKET_PRIORITIES } from "@/lib/db/schema";
import { CATEGORIES, PRIORITY_LABELS, SEGMENT_LABELS } from "@/lib/tickets/format";
import { createTicketAction } from "../actions";

export const metadata: Metadata = { title: "New ticket" };

export default async function NewTicketPage() {
  const staff = await requireStaff("tickets.create");
  const segments = staff.segmentsFor("tickets.create");
  return (
    <Stack>
      <PageHeader
        breadcrumb={<Breadcrumb items={[{ label: "Tickets", href: "/admin/tickets" }, { label: "New ticket" }]} />}
        title="New ticket"
        description="For an enquiry that came in by phone or in person. Nothing is emailed to the customer until you reply."
      />
      <div className="ds-width-8">
        <ActionForm action={createTicketAction} label="New ticket">
          <Fieldset legend="Customer type">
            {segments.map((s, i) => (
              <Radio key={s} name="segment" value={s} defaultChecked={i === 0} label={SEGMENT_LABELS[s]} description={s === "b2c" ? "A rider: bought a bike or parts" : "A dealer or trade account"} />
            ))}
          </Fieldset>
          <TextField label="Customer email" name="email" type="email" autoComplete="off" help="Replies go here. Leave blank only if they have no email." />
          <TextField label="Customer name" name="name" autoComplete="off" />
          <TextField label="Phone" name="phone" type="tel" autoComplete="off" />
          <TextField label="Business name" name="company" autoComplete="off" help="Dealers only." />
          <TextField label="Subject" name="subject" required maxLength={300} />
          <Select label="Category" name="category" defaultValue="Warranty">
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
          <Select label="Priority" name="priority" defaultValue="normal">
            {TICKET_PRIORITIES.map((p) => (
              <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
            ))}
          </Select>
          <TextField label="Bike model" name="productModel" />
          <TextField label="Frame number" name="frameNumber" />
          <TextArea label="What they need" name="body" rows={8} required help="In the customer's words where you can. It becomes the first message on the ticket." />
          <div className="ds-inline">
            <Button type="submit">Create ticket</Button>
            <Button href="/admin/tickets" variant="secondary">Cancel</Button>
          </div>
        </ActionForm>
      </div>
    </Stack>
  );
}
