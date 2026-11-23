/**
 * Every secret and setting the admin settings screen manages. Code reads
 * integration keys only through `getSecret(name)` with a name from here.
 */

export const SECRETS = {
  "anthropic.api_key": { integration: "Anthropic", label: "API key" },
  "voyage.api_key": { integration: "Voyage AI", label: "API key" },
  "zoho.client_id": { integration: "Zoho CRM", label: "Client ID" },
  "zoho.client_secret": { integration: "Zoho CRM", label: "Client secret" },
  "zoho.refresh_token": { integration: "Zoho CRM", label: "Refresh token" },
  "zoho.webhook_token": { integration: "Zoho CRM", label: "Notification token" },
  "email.server_token": { integration: "Email", label: "Server API token" },
  "email.inbound_secret": { integration: "Email", label: "Inbound webhook secret" },
  "shopify.api_secret": { integration: "Shopify", label: "App API secret (verifies App Proxy requests)" },
  "shopify.admin_token": { integration: "Shopify", label: "Admin API access token" },
  "turnstile.secret_key": { integration: "Cloudflare Turnstile", label: "Secret key" },
  "storage.service_key": { integration: "File storage", label: "Supabase secret key (server only)" },
} as const;

export type SecretName = keyof typeof SECRETS;

export function isSecretName(name: string): name is SecretName {
  return Object.hasOwn(SECRETS, name);
}

/** Non-secret settings and their defaults. */
export const SETTINGS = {
  /** The chatbot's model. Haiku keeps per-conversation cost low; change here, no deploy. */
  "chatbot.model": "claude-haiku-5-5",
  /** A cost guard: answers per 24 hours across all chats. Past it, people are offered a ticket instead. */
  "chatbot.daily_limit": "1500",
  /** The model used for one-off ingestion work (drafting KB articles from history). */
  "ingestion.model": "claude-haiku-5-5",
  /** Voyage AI embedding model for knowledge-base search (1024 dimensions). */
  "voyage.model": "voyage-4-lite",
  "zoho.accounts_domain": "https://accounts.zoho.eu",
  "zoho.api_domain": "https://www.zohoapis.eu",
  /** "true" once Zoho is connected and sync is switched on (Settings → Zoho). Read by the outbox trigger. */
  "zoho.sync_enabled": "false",
  /** Our ticket status → Zoho Case Status, one per line "status=Zoho value". Checked against Zoho's picklist. */
  "zoho.status_map": "new=New\nopen=New\npending_customer=On Hold\npending_internal=Escalated\nresolved=Closed\nclosed=Closed",
  /** Our priority → Zoho Case Priority. */
  "zoho.priority_map": "low=Low\nnormal=Medium\nhigh=High\nurgent=High",
  /** Years a closed ticket's content is kept before it's erased (statistics stay). UK practice for warranty records: 6. */
  "retention.ticket_years": "6",
  /** Zoho Account types that count as dealers, comma-separated. Blank: every account is a dealer. */
  "zoho.dealer_account_types": "",
  "turnstile.site_key": "",
  "support.phone.b2c": "",
  "support.phone.b2b": "",
  /** Where links in emails point: the support site's address, e.g. https://support.whytebikes.com. */
  "app.public_url": "",
  /** Sender for ticket emails; the domain must be verified with the email provider. */
  "email.from_address": "",
  "email.from_name": "Whyte Bikes Support",
  /**
   * The provider's inbound address (Postmark: <hash>@inbound.postmarkapp.com). Replies go to
   * <hash>+<ticket key>@..., so they land on the right ticket.
   */
  "email.inbound_address": "",
  /** Supabase project URL for file storage (attachments), e.g. https://abcd.supabase.co */
  "storage.supabase_url": "",
  /** Sites allowed to embed the form and chat, comma-separated origins. */
  "embed.allowed_origins": "https://www.whytebikes.com,https://whytebikes.com",
  /** The shop's myshopify.com domain, which signs App Proxy requests. */
  "shopify.shop_domain": "",
  /** Shopify customer tag that marks a dealer (B2B) account. */
  "shopify.b2b_tag": "trade",
  /** Linked from the form's privacy line. */
  "support.privacy_url": "https://whytebikes.com/policies/privacy-policy",
} as const satisfies Record<string, string>;

export type SettingKey = keyof typeof SETTINGS;
