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
| 3 | Knowledge base and ingestion (emails, Zoho, whytebikes.com) (done) |
| 4 | Chatbot and Shopify embed (done) |
| 5 | Zoho CRM two-way sync (done) |
| 6 | Analytics dashboard (done) |
| 7 | GDPR tooling and hardening (done) |

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

## Chatbot

- Answers only from published knowledge-base articles: each question is searched, the top six
  passages go to Claude (Settings → General → Chatbot → Model, Haiku by default), and the reply must
  cite at least one of them. A reply without a valid citation is replaced with "I can't find that"
  and an offer to pass the question on. Every reply is stored with every passage it was given
  (article version, rank, score, cited or not): Chatbot → a conversation shows them.
- Switched on once the Anthropic key is saved (Integrations). A daily answer limit (General,
  default 1,500) caps cost; past it, people are offered a ticket. Per-chat and per-connection rate
  limits and Turnstile (when set up) apply too.
- "Send this to the team" makes a ticket (source *chat*) with the transcript, the articles used and
  any bike, frame or order number the customer mentioned. The rider or dealer phone number
  (General) is offered as a second way to reach someone.
- Answers link to `/help/<article>` for rider articles; dealer-only articles are never public.
- Conversations are deleted 12 months after the last message (the nightly job); a ticket made
  from one keeps its own copy.

**On whytebikes.com**, one line in the theme (e.g. before `</body>` in `theme.liquid`):

```html
<script src="https://<support site>/embed/support-chat.js" defer></script>
```

The loader is under 1 KB and fetches the chat once the page is idle. To recognise signed-in
dealers, add an element with the App Proxy identity path (needs the App Proxy and Admin API token
from the form setup):

```html
<whyte-support-chat identity-url="/apps/support/identity" contact-url="/apps/support"></whyte-support-chat>
```

The store's origin must be in Settings → General → Allowed sites.

## Zoho CRM

**Connecting:** in Zoho's API console (api-console.zoho.eu for EU accounts), add a
*Server-based Application* with the redirect address `https://<support site>/api/zoho/callback`.
Save its client ID and secret in Settings → Integrations → Zoho CRM. Then go to
Settings → Zoho CRM → Connect Zoho, and approve. The refresh token is stored encrypted.
Check the setup, then switch sync on.

**What goes where:**

| This app | Zoho | Who owns it |
| --- | --- | --- |
| Ticket | Case (subject, status, priority, origin, contact, account; description on creation) | This app |
| Message | Note on the case (internal notes too, titled as such) | This app |
| Contact | Contact (found by email, created if missing, never overwritten) | Zoho |
| Dealer | Account (mirrored; used to recognise dealers by account number or email domain) | Zoho |

- A change to a field this app owns, made in Zoho (a case closed there), is noted on the ticket and
  put back. Notes added in Zoho arrive as internal notes. Cases created in Zoho become tickets.
- Contact details edited in Zoho update contacts this app already has. Zoho contacts with no tickets
  here are not copied in. Erased contacts are never refilled.
- **Sending:** a database trigger queues each ticket change in the same transaction (`sync_outbox`),
  so nothing is missed. It's sent straight after the request; failures are retried with backoff and
  listed on the Zoho page.
- **Receiving:** Zoho notifications (renewed automatically, up to a week at a time) plus a check
  every 15 minutes (`/api/cron/zoho`) for anything modified since the last run.
- **History:** "Import past cases" brings every past case in as a ticket, in the background: its
  description, its **Solution** (as Whyte's answer) and its notes (as internal notes).
- **Knowledge base:** closed cases (from the history import, and new ones) are queued for drafting,
  like tickets resolved here. Whyte's answer comes from the case's Solution and, unless switched
  off on the Zoho page, its notes, which the drafting step treats as staff notes (only what any
  customer could be told). Drafts wait for review under Knowledge base → Review. The 15-minute
  sync uses its spare time to work through the queue.
- Status and priority mappings are editable on the Zoho page and checked against Zoho's picklists.
- Records deleted in Zoho are not deleted here; the sync log shows a warning.

## Analytics

Analytics (permission *View analytics*) covers any date range and either segment, including
tickets imported from Zoho:

- **Headline figures** with change against the previous period: tickets, median first reply,
  share replied to within 24 hours, median time to resolve, share of chats the assistant answered
  without a hand-off, and questions it couldn't answer.
- **Trends:** tickets (riders and dealers) and chats per day, week or month; by category, bike
  model and source; median time to resolve by category.
- **Automation candidates:** each published article as a topic, with the tickets about it
  (all words of its title appear in the ticket) and the chats answered from it, and what that
  suggests (point customers at it, add detail, review it).
- **Gaps:** the questions the assistant couldn't answer, most asked first, and tickets no article
  covers, by category.
- **Experience:** customers who wrote more than once, tickets reopened by a reply, tickets open over
  a week, and tickets waiting over a day for a first reply.

## Privacy (UK GDPR)

- **Requests:** Admin → Settings → Privacy requests (permission *Export and erase customer data*).
  Find a person by email, then:
  - **Export** downloads everything held about them as JSON: details, every ticket and message
    (internal notes flagged, to review before sending), file names, and chats that became tickets.
  - **Erase** removes their name and contact details, every message on their tickets, their files
    and those chats. Ticket dates, categories and statuses stay, without anything personal, for
    statistics. With Zoho connected, a task is created in Zoho to erase its copy (Zoho owns it).
  Both are recorded in the audit log with a fingerprint of the email, not the address.
- **Retention** (nightly): closed tickets are erased the same way after the years set in
  Settings → General (default 6); people with nothing else left are blanked. Chats are deleted after
  12 months, sync logs after 30 days, unused imported text after 90 days, sign-in records after 30.
- Erased people are never refilled from Zoho.

## Security notes

- Secrets live only in the encrypted store (Settings → Integrations); the environment holds only
  `DATABASE_URL` (or `POSTGRES_URL`, as Vercel's Supabase integration sets it), `APP_ENCRYPTION_KEY` (+ `_VERSION`, `_PREVIOUS` while rotating) and `CRON_SECRET`.
  Never set `WHYTE_LOCAL_STORAGE` in production (it enables a development-only file store).
- Set **Settings → General → Support site address** before go-live: links in emails use it.
- Dealer-only articles reach only dealers Shopify confirms (signed in, tagged as trade). An
  unapproved draft can't change who sees a published article.
- Staff can only give out (invite, roles, role edits) permissions they hold themselves.
- Headers: Content-Security-Policy, HSTS, `frame-ancestors 'none'`, nosniff, a strict referrer and
  permissions policy on every page except the embed scripts.
- Imported emails and tickets are untrusted text: drafts written from them always wait for review,
  so check links and instructions in drafts before publishing.

## Scheduled jobs

`vercel.json` runs `/api/cron/zoho` every 15 minutes (Zoho sync) and `/api/cron/cleanup` nightly (abandoned uploads, expired sessions and links,
old rate-limit rows, chats older than 12 months; it also advances imports and embeds new
articles). Set a `CRON_SECRET` environment variable in Vercel; the route refuses
requests without it.

## Knowledge base

- **Articles** are for riders (B2C), dealers (B2B) or both. Every edit is a new version; the chatbot
  reads only the published one. Editors send drafts for review; approvers publish or send them back.
- **Import** (Knowledge base → Import) turns history into draft articles:
  - *Past support emails*: an `.mbox` export (or `.eml` files). Give Whyte's email domains so
    replies are told apart from customers.
  - *Zoho CRM cases*: Cases → Export as CSV.
  - *whytebikes.com*: reads the sitemap (pages, products, blog posts).
  Personal details are removed before anything is stored or sent to Claude, uploaded files are
  deleted once read, and unused imported text is deleted after 90 days. A topic answered at least
  twice becomes one draft. Drafts list anything the sources didn't settle; delete that section
  before publishing.
- **Resolved tickets** are queued automatically; "Draft an article from this ticket" does one now.
- **Search** is full text, plus meaning when a Voyage AI key is set (Integrations). Knowledge base →
  Test search shows which passages the chatbot would be given for a question.
- Uploads over 50 MB need Supabase's project upload limit raised (Storage → Settings), or the
  export split into smaller files.
