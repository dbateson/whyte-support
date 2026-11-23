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
| 2 | Public support form (web component and Shopify App Proxy) |
| 3 | Knowledge base and ingestion (emails, Zoho, whytebikes.com) |
| 4 | Chatbot and Shopify embed |
| 5 | Zoho CRM two-way sync |
| 6 | Analytics dashboard |
| 7 | GDPR tooling and hardening |
