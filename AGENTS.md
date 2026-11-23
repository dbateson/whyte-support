# AGENTS.md — whyte-support

Guidance for AI coding agents and people working in this repository.

## What this is

The Whyte Bikes support platform: a public support form and an embeddable AI chatbot (on the
support site and the Shopify storefront), a knowledge base split into B2C and B2B, a ticketing
back end with role-based permissions, two-way Zoho CRM sync, and an analytics dashboard.

Stack: Next.js (App Router) on Vercel (`lhr1`), Postgres on Supabase (London) via Drizzle,
Claude for the chatbot (`claude-haiku-5-5` by default, a setting, not code).

## Layout

- `src/app/(admin)/admin/*` — staff app. Inter throughout (`themes/app.css`).
- `src/app/(public)/*` — customer-facing pages. Brand typography (Delight headings).
- `src/app/api/*` — route handlers.
- `src/lib/` — server code: `env.ts` (bootstrap config), `crypto.ts`, `secrets.ts`,
  `logger.ts`, `integrations.ts` (registry of secrets and settings), `db/`.
- `drizzle/` — SQL migrations, applied by `npm run db:migrate`.
- `vendor/` — packed copy of `@whyte/design-system`.

## Hard rules

- **No secrets in code or env vars.** The environment holds only `DATABASE_URL` and the
  `APP_ENCRYPTION_KEY*` values. Every integration key is registered in `src/lib/integrations.ts`,
  entered on the admin settings screen, stored encrypted (`setSecret`) and read only on the
  server (`getSecret`). Never return a secret to the browser, put one in a URL, or log one.
- **Log only through `log` from `src/lib/logger.ts`.** It redacts secrets and masks emails.
  Never `console.log` request bodies, headers or upstream API errors directly.
- **Every new table** gets row-level security enabled in its migration (no policies). The app
  reads the database only from the server; Supabase's REST API must see nothing. See
  `drizzle/0002_lockdown.sql`.
- **B2C/B2B** is a first-class field on contacts, tickets, articles and chats. Permission
  checks and bot retrieval always filter by it.
- **Chatbot answers** must come only from published KB article versions, and every answer
  stores the article versions it cited.
- **GDPR:** customer personal data never goes into logs, KB articles or analytics exports.
  Anything that stores personal data needs a retention rule.

## Design system

- All UI uses `@whyte/design-system` components, classes and tokens. Don't hand-roll styles
  that it should own; if something is missing, flag it and add it to
  `dbateson/whyte-design-system` (with its reference-page card) rather than building it here.
- The design system has no base stylesheet: each root layout puts `ds-body` on `<body>`.
- To update it: in the design-system repo run `npm pack`, replace the tarball in `vendor/`,
  update the `file:` path in `package.json`, `npm install`.

## Commands

```bash
npm install
npm run dev            # needs DATABASE_URL and APP_ENCRYPTION_KEY (see .env.example)
npm run db:generate    # SQL migration from changes to src/lib/db/schema.ts
npm run db:migrate     # apply migrations
npm run lint
npm run typecheck
npm test               # set TEST_DATABASE_URL to run the database tests
npm run build
```

## Working conventions

- Branch from `main`, open a pull request; CI (lint, typecheck, tests against Postgres with
  pgvector, build) must pass. Don't skip or disable tests.
- Small, imperative commits ("Add ticket queue filters").
