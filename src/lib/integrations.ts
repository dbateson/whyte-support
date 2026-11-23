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
} as const;

export type SecretName = keyof typeof SECRETS;

export function isSecretName(name: string): name is SecretName {
  return Object.hasOwn(SECRETS, name);
}

/** Non-secret settings and their defaults. */
export const SETTINGS = {
  /** The chatbot's model. Haiku keeps per-conversation cost low; change here, no deploy. */
  "chatbot.model": "claude-haiku-5-5",
  /** The model used for one-off ingestion work (drafting KB articles from history). */
  "ingestion.model": "claude-haiku-5-5",
  "zoho.accounts_domain": "https://accounts.zoho.eu",
  "zoho.api_domain": "https://www.zohoapis.eu",
  "turnstile.site_key": "",
  "support.phone.b2c": "",
  "support.phone.b2b": "",
} as const satisfies Record<string, string>;

export type SettingKey = keyof typeof SETTINGS;
