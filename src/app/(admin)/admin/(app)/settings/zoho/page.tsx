import type { Metadata } from "next";
import Link from "next/link";
import { desc } from "drizzle-orm";
import { Alert, Button, CardGrid, Checkbox, DataTable, DescriptionList, GridItem, MetricCard, PageHeader, Panel, Stack, Status, TextArea, TextField, type DataTableColumn } from "@whyte/design-system";
import { ActionForm } from "@/components/ActionForm";
import { requireStaff } from "@/lib/auth/session";
import { db, schema } from "@/lib/db";
import { getSecret } from "@/lib/secrets";
import { getSettings } from "@/lib/settings";
import { formatAgo } from "@/lib/tickets/format";
import { zohoConnected, ZOHO_SCOPES } from "@/lib/zoho/client";
import { failedChanges, outboxCounts } from "@/lib/zoho/push";
import { readState } from "@/lib/zoho/state";
import { historyStatus, notificationChannel, type SetupReport } from "@/lib/zoho/sync";
import { checkSetupAction, disconnectAction, historyAction, notificationsAction, retryAction, runNowAction, saveMappingAction, setSyncAction } from "./actions";

export const metadata: Metadata = { title: "Zoho CRM" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  client: "Add the Zoho client ID and secret in Integrations first.",
  state: "The sign-in took too long or came from another tab. Try connecting again.",
  denied: "Zoho sign-in was cancelled.",
  code: "Zoho didn't send a sign-in code. Try again.",
  exchange: "Zoho refused the sign-in. Check the client ID, secret and the redirect address in Zoho's API console.",
};

type LogRow = typeof schema.syncLog.$inferSelect;
type Failed = Awaited<ReturnType<typeof failedChanges>>[number];

export default async function ZohoPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  await requireStaff("settings.manage");
  const sp = await searchParams;
  const [connected, hasClient, s, counts, failed, channel, history, lastRun, report, recent] = await Promise.all([
    zohoConnected(),
    getSecret("zoho.client_id").then(Boolean),
    getSettings(["zoho.sync_enabled", "zoho.status_map", "zoho.priority_map", "zoho.dealer_account_types", "zoho.notes_for_kb", "app.public_url", "zoho.accounts_domain"]),
    outboxCounts(),
    failedChanges(),
    notificationChannel(),
    historyStatus(),
    readState<{ at: string; sent: number; failed: number; error?: string }>("zoho.last_run"),
    readState<SetupReport & { at: string }>("zoho.setup_report"),
    db().select().from(schema.syncLog).orderBy(desc(schema.syncLog.at)).limit(30),
  ]);
  const on = s["zoho.sync_enabled"] === "true";
  const redirectUri = `${(s["app.public_url"] || "https://<support site>").replace(/\/$/, "")}/api/zoho/callback`;

  const failedColumns: DataTableColumn<Failed>[] = [
    { key: "what", header: "Change", cell: (f) => (f.number ? <Link href={`/admin/tickets/${f.number}`}>WS-{f.number}</Link> : f.entity) },
    { key: "tries", header: "Tries", cell: (f) => f.attempts },
    { key: "error", header: "Last error", cell: (f) => f.lastError ?? "" },
    { key: "next", header: "Next try", cell: (f) => formatAgo(f.nextAttemptAt).replace(" ago", "") },
  ];
  const logColumns: DataTableColumn<LogRow>[] = [
    { key: "at", header: "When", cell: (r) => formatAgo(r.at) },
    { key: "dir", header: "Direction", cell: (r) => (r.direction === "out" ? "To Zoho" : "From Zoho") },
    { key: "level", header: "", cell: (r) => (r.level === "info" ? null : <Status tone={r.level === "error" ? "error" : "warning"}>{r.level === "error" ? "Error" : "Warning"}</Status>) },
    { key: "msg", header: "What happened", cell: (r) => r.message },
  ];

  return (
    <Stack>
      <PageHeader
        title="Zoho CRM"
        description="Tickets go to Zoho as Cases, with every message as a note. Contacts and dealer accounts come from Zoho. Changes go both ways within seconds, and everything is checked again every 15 minutes."
      />
      {sp.connected && <Alert tone="success">Connected to Zoho. Check the setup below, then switch sync on.</Alert>}
      {sp.error && <Alert tone="error">{ERRORS[sp.error] ?? "Connecting to Zoho failed."}</Alert>}

      <Panel
        title="Connection"
        description={connected ? "Connected. The refresh token is stored encrypted." : "Not connected."}
        actions={<Status tone={connected ? (on ? "success" : "warning") : "neutral"}>{connected ? (on ? "Syncing" : "Connected, sync off") : "Not connected"}</Status>}
      >
        <Stack gap="small">
          {!hasClient && (
            <Alert tone="info" title="First, create a Zoho API client">
              In Zoho&apos;s API console ({s["zoho.accounts_domain"].replace("https://accounts.", "api-console.")}), add a Server-based Application with the redirect address{" "}
              <code>{redirectUri}</code>, then save its client ID and secret in <Link href="/admin/settings/integrations">Integrations</Link>.
            </Alert>
          )}
          <DescriptionList
            items={[
              { term: "Permissions asked for", detail: ZOHO_SCOPES.join(", ") },
              { term: "Last run", detail: lastRun ? `${formatAgo(new Date(lastRun.at))}${lastRun.error ? `: ${lastRun.error}` : ""}` : "Never" },
              { term: "Notifications", detail: channel ? `On until ${new Date(channel.expiresAt).toLocaleDateString("en-GB")} (renewed automatically)` : "Off: changes in Zoho arrive within 15 minutes" },
            ]}
          />
          <div className="ds-inline">
            <Button href="/api/zoho/connect" variant={connected ? "secondary" : "primary"} size="small">
              {connected ? "Reconnect" : "Connect Zoho"}
            </Button>
            {connected && (
              <ActionForm action={setSyncAction}>
                <input type="hidden" name="on" value={on ? "false" : "true"} />
                <Button type="submit" size="small" variant={on ? "secondary" : "primary"}>
                  {on ? "Switch sync off" : "Switch sync on"}
                </Button>
              </ActionForm>
            )}
            {on && (
              <ActionForm action={runNowAction}>
                <Button type="submit" size="small" variant="secondary">Sync now</Button>
              </ActionForm>
            )}
            {on && (
              <ActionForm action={notificationsAction}>
                <input type="hidden" name="on" value={channel ? "false" : "true"} />
                <Button type="submit" size="small" variant="secondary">{channel ? "Turn notifications off" : "Turn notifications on"}</Button>
              </ActionForm>
            )}
            {connected && (
              <ActionForm action={disconnectAction}>
                <Button type="submit" size="small" variant="tertiary">Disconnect</Button>
              </ActionForm>
            )}
          </div>
        </Stack>
      </Panel>

      {on && (
        <CardGrid label="Sending to Zoho">
          <GridItem span={4}>
            <MetricCard title="Waiting to send" value={counts.waiting.toLocaleString("en-GB")} />
          </GridItem>
          <GridItem span={4}>
            <MetricCard title="Retrying" value={counts.retrying.toLocaleString("en-GB")} />
          </GridItem>
          <GridItem span={4}>
            <MetricCard title="Failed (still retried hourly)" value={counts.failed.toLocaleString("en-GB")} />
          </GridItem>
        </CardGrid>
      )}
      {failed.length > 0 && (
        <Panel
          title="Changes Zoho hasn't accepted"
          actions={
            <ActionForm action={retryAction}>
              <Button type="submit" size="small" variant="secondary">Retry now</Button>
            </ActionForm>
          }
        >
          <DataTable label="Failed changes" columns={failedColumns} rows={failed} rowKey={(f) => String(f.id)} total={failed.length} noun="changes" />
        </Panel>
      )}

      {connected && (
        <Panel
          title="Setup check"
          description="Whether Zoho has the fields and picklist values this app sends. Run it after changing Zoho's layouts."
          actions={
            <ActionForm action={checkSetupAction}>
              <Button type="submit" size="small" variant="secondary">Check now</Button>
            </ActionForm>
          }
        >
          {!report ? (
            <p>Not checked yet.</p>
          ) : (
            <Stack gap="small">
              {report.missing.length === 0 && report.problems.length === 0 ? (
                <Alert tone="success">Everything this app uses exists in Zoho (checked {formatAgo(new Date(report.at))}).</Alert>
              ) : (
                <Alert tone="warning" title="Needs attention">
                  {[...report.missing.map((m) => `Zoho ${m.module} has no field ${m.field}.`), ...report.problems].join(" ")}
                </Alert>
              )}
              <DescriptionList items={Object.entries(report.picklists).map(([k, v]) => ({ term: `Zoho ${k} values`, detail: v.join(", ") || "None found" }))} />
            </Stack>
          )}
        </Panel>
      )}

      <Panel title="How values map" description="This app's ticket status and priority, and the Zoho values they become. Each line: our value = Zoho value.">
        <ActionForm action={saveMappingAction} label="Mapping">
          <TextArea label="Status" name="zoho.status_map" rows={6} defaultValue={s["zoho.status_map"]} />
          <TextArea label="Priority" name="zoho.priority_map" rows={4} defaultValue={s["zoho.priority_map"]} />
          <TextField
            label="Account types that are dealers"
            name="zoho.dealer_account_types"
            defaultValue={s["zoho.dealer_account_types"]}
            help="Zoho Account Type values, comma-separated (for example Reseller, Distributor). Leave blank if every account in Zoho is a dealer."
          />
          <Checkbox
            name="zoho.notes_for_kb"
            label="Use Zoho case notes as Whyte's answers when drafting articles"
            description="Often the only record of what Whyte told the customer. Notes stay internal everywhere else; drafts mark them as staff notes and always wait for review. A case's Solution field is always used."
            defaultChecked={s["zoho.notes_for_kb"] === "true"}
          />
          <div className="ds-inline">
            <Button type="submit" size="small">Save</Button>
          </div>
        </ActionForm>
      </Panel>

      {on && (
        <Panel
          title="History"
          description="Brings every past Zoho case in as a ticket, with its notes and solution, for search, analytics and the knowledge base. Runs in the background; existing tickets aren't duplicated."
        >
          <Stack gap="small">
            <p>
            {!history
              ? "Not imported yet."
              : history.status === "running"
                ? `Importing: ${history.applied.toLocaleString("en-GB")} cases so far (started ${formatAgo(new Date(history.startedAt))}).`
                : `Done ${formatAgo(new Date(history.finishedAt!))}: ${history.applied.toLocaleString("en-GB")} cases checked.`}
              {history && history.feedKb !== false ? " Closed cases are drafted into articles in the background; see Knowledge base → Review." : ""}
            </p>
            {history?.status !== "running" && (
              <ActionForm action={historyAction} label="Import past cases">
                <Checkbox name="feedKb" label="Draft knowledge-base articles from closed cases" description="Uses Claude on each closed case's question and answer. Drafts wait for review before the chatbot uses them." defaultChecked />
                <div className="ds-inline">
                  <Button type="submit" size="small" variant="secondary">{history ? "Import again" : "Import past cases"}</Button>
                </div>
              </ActionForm>
            )}
          </Stack>
        </Panel>
      )}

      <Panel title="Recent activity" description="The last 30 things the sync did. Kept for 30 days.">
        <DataTable label="Sync activity" columns={logColumns} rows={recent} rowKey={(r) => String(r.id)} total={recent.length} noun="entries" />
      </Panel>
    </Stack>
  );
}
