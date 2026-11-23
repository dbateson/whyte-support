# Whyte Support

Customer support platform for Whyte Bikes: support form, AI chatbot (on the support site and
embedded in the Shopify storefront), B2C/B2B knowledge base, ticketing, Zoho CRM sync and
analytics.

See [AGENTS.md](AGENTS.md) for architecture, rules and commands.

## Local setup

1. Postgres 16 with the `vector` extension (or a Supabase project).
2. `cp .env.example .env` and fill in `DATABASE_URL` and a generated `APP_ENCRYPTION_KEY`.
3. `npm install && npm run db:migrate && npm run dev`.
4. Create the first admin and open the link it prints:
   `npm run admin:create -- you@whytebikes.com "Your Name" http://localhost:3000`.
   You'll set a password, then an authenticator app.

Integration keys (Anthropic, Voyage, Zoho, email, Shopify, Turnstile) are entered in
Settings → Integrations. They are never put in `.env`.

## Email (Postmark)

1. In Postmark, verify the sending domain, then put the server API token in Settings →
   Integrations → Email, and the sender address in Settings → General.
2. For replies: copy the server's inbound address into Settings → General, save a random
   inbound webhook secret in Integrations, and set Postmark's inbound webhook URL to
   `https://postmark:<that secret>@<your site>/api/email/inbound`.

## Delivery phases

| Phase | Scope |
| --- | --- |
| 0 | Foundations: scaffold, design system, database, encrypted secrets store, CI (done) |
| 1 | Ticketing core, staff auth and roles, settings screen, email (done) |
| 2 | Public support form (web component and Shopify App Proxy) (done) |
| 3 | Knowledge base and ingestion (emails, Zoho, whytebikes.com) |
| 4 | Chatbot and Shopify embed |
| 5 | Zoho CRM two-way sync |
| 6 | Analytics dashboard |
| 7 | GDPR tooling and hardening |

## File storage (attachments)

Attachments go to the private Supabase Storage bucket `ticket-attachments` (25 MB per file;
photos, PDFs and short videos). Put the project URL (`https://gqkadulwfglghhkcxsvi.supabase.co`) in
Settings → General → Storage, and a Supabase **secret** key (Project Settings → API keys) in
Settings → Integrations → File storage. Without them, attaching files is switched off in
production; in development files go to local disk instead.

## Putting the form on whytebikes.com

Two ways, both using the same form and API:

- **Shopify App Proxy (recommended).** In the Shopify custom app, set an App Proxy with prefix
  `apps`, subpath `support`, and URL `https://<support site>/api/shopify/proxy`. The page
  `whytebikes.com/apps/support` then shows the form inside the store's theme. Save the app's API
  secret (Integrations → Shopify) so requests can be verified, and the shop's `.myshopify.com`
  domain in General. With an Admin API token too, signed-in customers tagged with the dealer tag
  (default `trade`) are treated as B2B.
- **Web component** on any page:
  ```html
  <script src="https://<support site>/embed/support-form.js" defer></script>
  <whyte-support-form></whyte-support-form>
  ```
  The page's origin must be in Settings → General → Allowed sites.

## Scheduled jobs

`vercel.json` runs `/api/cron/cleanup` nightly (abandoned uploads, expired sessions and links,
old rate-limit rows). Set a `CRON_SECRET` environment variable in Vercel; the route refuses
requests without it.
