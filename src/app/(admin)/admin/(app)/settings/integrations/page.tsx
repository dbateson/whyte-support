import type { Metadata } from "next";
import { Button, PageHeader, Panel, Stack, Status, TextField } from "@whyte/design-system";
import { ActionForm } from "@/components/ActionForm";
import { requireStaff } from "@/lib/auth/session";
import { listSecretStatus, type SecretStatus } from "@/lib/secrets";
import { formatDateTime } from "@/lib/tickets/format";
import { clearSecretAction, saveSecretAction, testConnectionAction } from "../actions";

export const metadata: Metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

const ABOUT: Record<string, { description: string; test?: string }> = {
  Anthropic: { description: "Claude, which powers the chatbot and drafts knowledge-base articles from imports.", test: "anthropic" },
  "File storage": { description: "Supabase Storage for customers' attachments and knowledge-base imports. Its URL is in General." },
  "Voyage AI": { description: "Embeddings, so knowledge-base search matches on meaning as well as words. Optional.", test: "voyage" },
  "Zoho CRM": { description: "Two-way sync of contacts, dealer accounts and cases. Save the API client here, then connect in Settings → Zoho CRM. The refresh and notification tokens are filled in by connecting." },
  Email: { description: "Postmark: ticket replies out, customer replies in.", test: "email" },
  Shopify: { description: "The support form and chatbot on whytebikes.com (Phases 2 and 4)." },
  "Cloudflare Turnstile": { description: "Spam protection on the public form and chat (Phase 2)." },
};

function SecretRow({ s }: { s: SecretStatus }) {
  return (
    <Stack gap="small">
      <Status tone={s.configured ? "success" : "neutral"}>
        {s.label}: {s.configured ? `set${s.hint ? `, ends ${s.hint}` : ""}${s.updatedAt ? `, ${formatDateTime(s.updatedAt)}` : ""}` : "not set"}
      </Status>
      <ActionForm action={saveSecretAction} resetOnSuccess label={`${s.integration} ${s.label}`}>
        <input type="hidden" name="name" value={s.name} />
        <TextField
          label={s.configured ? `New ${s.label}` : s.label}
          name="value"
          type="password"
          size="small"
          autoComplete="off"
          spellCheck={false}
          required
        />
        <div className="ds-inline">
          <Button type="submit" size="small">Save</Button>
        </div>
      </ActionForm>
      {s.configured && (
        <ActionForm action={clearSecretAction} label={`Clear ${s.integration} ${s.label}`}>
          <input type="hidden" name="name" value={s.name} />
          <div className="ds-inline">
            <Button type="submit" size="small" variant="secondary">Clear {s.label}</Button>
          </div>
        </ActionForm>
      )}
    </Stack>
  );
}

export default async function IntegrationsPage() {
  await requireStaff("settings.manage");
  const secrets = await listSecretStatus();
  const groups = [...new Set(secrets.map((s) => s.integration))];
  return (
    <Stack>
      <PageHeader
        title="Integrations"
        description="Keys are encrypted before they're stored and are only ever used on the server. Once saved, a key can't be shown again: replace it if you need to change it."
      />
      {groups.map((g) => (
        <Panel key={g} title={g} description={ABOUT[g]?.description}>
          <Stack>
            {secrets
              .filter((s) => s.integration === g)
              .map((s) => (
                <SecretRow key={s.name} s={s} />
              ))}
            {ABOUT[g]?.test && (
              <ActionForm action={testConnectionAction} label={`Test ${g}`}>
                <input type="hidden" name="integration" value={ABOUT[g]!.test} />
                <div className="ds-inline">
                  <Button type="submit" size="small" variant="secondary">Test connection</Button>
                </div>
              </ActionForm>
            )}
          </Stack>
        </Panel>
      ))}
    </Stack>
  );
}
