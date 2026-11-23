import type { Metadata } from "next";
import { Button, PageHeader, Panel, Select, Stack, TextField } from "@whyte/design-system";
import { ActionForm } from "@/components/ActionForm";
import { requireStaff } from "@/lib/auth/session";
import { SETTINGS, type SettingKey } from "@/lib/integrations";
import { getSettings } from "@/lib/settings";
import { saveGeneralAction } from "../actions";

export const metadata: Metadata = { title: "General settings" };
export const dynamic = "force-dynamic";

const MODELS = [
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5: fastest, lowest cost" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5: more capable, about 20× the cost of Haiku" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5: most capable, about 40× the cost of Haiku" },
];

export default async function GeneralSettingsPage() {
  await requireStaff("settings.manage");
  const s = await getSettings(Object.keys(SETTINGS) as SettingKey[]);
  return (
    <Stack>
      <PageHeader title="General" description="Settings that aren't secret. Changes are recorded in the audit log." />
      <div className="ds-width-8">
        <ActionForm action={saveGeneralAction} label="General settings" gap="standard">
          <Panel title="Site">
            <TextField label="Support site address" name="app.public_url" type="url" defaultValue={s["app.public_url"]} placeholder="https://support.whytebikes.com" help="Used for links in emails, such as staff invitations." />
          </Panel>
          <Panel title="Email" description="Ticket replies are sent from this address; its domain must be verified in Postmark.">
            <Stack gap="small">
              <TextField label="Send from (address)" name="email.from_address" type="email" defaultValue={s["email.from_address"]} placeholder="support@whytebikes.com" />
              <TextField label="Send from (name)" name="email.from_name" defaultValue={s["email.from_name"]} />
              <TextField label="Inbound address" name="email.inbound_address" type="email" defaultValue={s["email.inbound_address"]} help="Postmark's inbound address for this server (…@inbound.postmarkapp.com). Customer replies come back through it." />
            </Stack>
          </Panel>
          <Panel title="Chatbot">
            <Stack gap="small">
              <Select label="Model" name="chatbot.model" defaultValue={s["chatbot.model"]} help="Applies to new conversations straight away.">
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </Select>
              <Select label="Model for drafting articles" name="ingestion.model" defaultValue={s["ingestion.model"]} help="Used when turning past emails and tickets into draft articles.">
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </Select>
              <TextField
                label="Answers per day (cost limit)"
                name="chatbot.daily_limit"
                type="number"
                min={0}
                step={1}
                defaultValue={s["chatbot.daily_limit"]}
                help="Across all chats in 24 hours. Past it, people are offered a ticket instead. 0 for no limit."
              />
              <TextField label="Phone number for riders (B2C)" name="support.phone.b2c" type="tel" defaultValue={s["support.phone.b2c"]} help="Offered when the chatbot can't help. Leave blank to offer only a ticket." />
              <TextField label="Phone number for dealers (B2B)" name="support.phone.b2b" type="tel" defaultValue={s["support.phone.b2b"]} />
            </Stack>
          </Panel>
          <Panel title="Data retention" description="UK GDPR: keep customer data only as long as needed. Customers can also ask to be erased sooner (Privacy requests).">
            <TextField
              label="Years to keep closed tickets"
              name="retention.ticket_years"
              type="number"
              min={1}
              max={20}
              defaultValue={s["retention.ticket_years"]}
              help="After this long untouched, a closed ticket's messages, files and personal details are erased; its dates and category stay for statistics. Chats are kept 12 months."
            />
          </Panel>
          <Panel title="Zoho CRM" description="Zoho's data centre. UK accounts are usually on zoho.eu.">
            <Stack gap="small">
              <Select label="Accounts server" name="zoho.accounts_domain" defaultValue={s["zoho.accounts_domain"]}>
                <option value="https://accounts.zoho.eu">accounts.zoho.eu (EU)</option>
                <option value="https://accounts.zoho.com">accounts.zoho.com (US)</option>
              </Select>
              <Select label="API server" name="zoho.api_domain" defaultValue={s["zoho.api_domain"]}>
                <option value="https://www.zohoapis.eu">www.zohoapis.eu (EU)</option>
                <option value="https://www.zohoapis.com">www.zohoapis.com (US)</option>
              </Select>
            </Stack>
          </Panel>
          <Panel title="Storage" description="Where customers' photos and documents are kept: a private Supabase Storage bucket.">
            <TextField label="Supabase project URL" name="storage.supabase_url" type="url" defaultValue={s["storage.supabase_url"]} placeholder="https://abcd.supabase.co" help="Its secret key goes in Integrations → File storage." />
          </Panel>
          <Panel title="Support form on other sites">
            <Stack gap="small">
              <TextField label="Allowed sites" name="embed.allowed_origins" defaultValue={s["embed.allowed_origins"]} help="Sites that can show the form and chat, comma-separated, e.g. https://www.whytebikes.com" />
              <TextField label="Privacy policy link" name="support.privacy_url" type="url" defaultValue={s["support.privacy_url"]} />
            </Stack>
          </Panel>
          <Panel title="Shopify" description="For the App Proxy page (whytebikes.com/apps/support) and recognising dealers.">
            <Stack gap="small">
              <TextField label="Shop domain" name="shopify.shop_domain" defaultValue={s["shopify.shop_domain"]} placeholder="whyte-bikes.myshopify.com" />
              <TextField label="Dealer customer tag" name="shopify.b2b_tag" defaultValue={s["shopify.b2b_tag"]} help="Signed-in customers with this tag are treated as B2B." />
            </Stack>
          </Panel>
          <Panel title="Spam protection">
            <TextField label="Turnstile site key" name="turnstile.site_key" defaultValue={s["turnstile.site_key"]} help="The public key from Cloudflare. Its secret key goes in Integrations." />
          </Panel>
          <div className="ds-inline">
            <Button type="submit">Save settings</Button>
          </div>
        </ActionForm>
      </div>
    </Stack>
  );
}
