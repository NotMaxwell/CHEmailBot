# CHEmailBot — status & handoff

_Last updated: 2026-09-11. Written so work can resume cold, with no network._

## Where this stands

**Everything is implemented and verified end to end except the live Gmail
send**, which needs OAuth credentials you have to create.

Proven by running it (Bun 1.4.0, `bun test` → 19 pass, `bunx tsc --noEmit` clean):

- scraped 4 real listings from `computers-it-web-1439` into the DB
- ran discovery against those companies' own sites → 1 address found
- drove all five review steps over HTTP; the send button ungated correctly
- queued a send, then **failed to double-send it at both layers** — the app
  refused it, and a direct SQL INSERT bypassing all app logic was rejected by
  `UNIQUE constraint failed: sends.company_id`
- dry-run drain reported what it would send and left the row queued

The test DB was deleted afterwards, so your first run starts clean. A working
`.env` is in place (gitignored) with `DRY_RUN=1`.

### The one number that matters

Email discovery found **1 address across 4 companies**. Small sample, but if
that rate holds, website scraping will NOT be your main channel — manual entry
and form-assist will carry most of the volume. Re-measure after a full scrape
before investing more in the discovery heuristics.

## The finding that shaped everything

"The Huntsville ledger" is the Huntsville/Madison County Chamber directory at
`cm.hsvchamber.org` (GrowthZone/ChamberMaster). 125 categories, 4 of them
technology-relevant, **246 unique companies in `technology-r-d` alone** — so
expect roughly 300–400 total after dedup across all four.

**It publishes no email addresses.** The contact slot on a member page is:

```html
<span itemprop="email">Send Email</span>   <!-- href="javascript:void(0)" -->
```

A Chamber-relayed form, not an address. `tests/parse.test.ts` asserts this
explicitly — if that test ever fails, the Chamber changed policy and stage 2
could be skipped for those listings.

What you *do* get per listing: name, street, city, state, zip, phone, fax,
**website URL**, LinkedIn, category.

`robots.txt` permits `/list`, `/list/category/*`, `/list/member/*`.
Only `/list/search` is `Disallow`ed — the scraper must never touch it.

## Decisions already made (and why)

| Decision | Why |
|---|---|
| Bun + Hono + SQLite | Chosen from four options; one runtime covers server, DB, and Playwright |
| **No HTMX from CDN** | A `unpkg.com` script tag breaks the UI on a bad connection. Plain server-rendered forms instead; HTMX can layer on later without route changes |
| **No `node-html-parser`** | Replaced by zero-dep `src/scrape/parse.ts`, which is also offline-testable. Deps are down to `hono`, `googleapis`, `playwright` |
| `DRY_RUN` defaults **on** | You can't unsend. Requires explicit `DRY_RUN=0` |
| `assertSendable()` throws | Missing CAN-SPAM fields are a legal defect in every message — block, don't warn |
| Form assist never submits | Fills the company's own form, hands you the browser. Keeps a human accountable and sidesteps CAPTCHA |
| Chamber relay NOT automated | Messages arrive stamped with the Chamber's name; a few hundred trace back to one member. Local-reputation cost, not just legal |

## Dedup guarantee

Enforced by SQLite, not app logic (`data/schema.sql`):

```sql
CREATE UNIQUE INDEX sends_one_per_company
  ON sends(company_id) WHERE status IN ('queued','sent');
CREATE UNIQUE INDEX sends_one_per_address
  ON sends(email_address) WHERE status IN ('queued','sent');
```

Partial, so `failed`/`bounced` drop out and genuine retries work — but an
accidental second send is rejected by the database. `nameKey()` in `src/db.ts`
normalizes identity so `A-P-T Research, Inc. (APT)` and `APT Research Inc`
collide (`tests/namekey.test.ts`).

## The five-step UI (your requirement), and where each step lives

| Step | UI | Route | Storage |
|---|---|---|---|
| 1 · Start | "Start Chamber scrape" / "Find emails" buttons | `POST /scrape/chamber`, `POST /scrape/emails` | `companies`, `emails` |
| 2 · Verify company | Verify / Reject on `/company/:id` | `POST /company/:id/review` | `companies.review_status` |
| 3 · Verify email | "mark verified" per candidate | `POST /email/:id/verify` | `emails.verified` |
| 4 · Select template | dropdown | `POST /company/:id/template` | `companies.template_id` |
| 5 · Select address | "use this" per candidate | `POST /company/:id/primary` | `emails.is_primary` |

`/company/:id` computes a `blockers[]` list and disables the send button until
every gate clears. `/` shows a pipeline counter strip for all five stages.

## Next steps, in order

1. **Fill in CAN-SPAM fields in `.env`.** `SENDER_POSTAL_ADDRESS` currently holds
   a placeholder; it must be a real mailing address to be lawful.
2. **Create the Gmail OAuth client** at console.cloud.google.com — desktop app,
   scope `gmail.send` (send-only; it cannot read your inbox). Put the id/secret
   in `.env`, then click "connect Gmail" on `/`. Token lands in
   `.gmail-token.json` (gitignored). This is the only unexercised code path.
3. **`bun run dev`, click "Start Chamber scrape."** ~300–400 companies at a 2s
   delay — roughly 20–30 minutes. Watch for `upsertCompany` returning
   `"duplicate"` often, which would mean `nameKey()` over-collapses distinct
   companies.
4. **Re-measure the discovery yield** (see above) once you have the full set.
5. **`bunx playwright install chromium`** before first using form assist —
   ~150MB, deferred until you actually need it.
6. **Send one real message to yourself first.** Set `DRY_RUN=0`, queue a company
   whose address you control, drain, and read what actually lands.

## Before any real send

- dedicated sending domain with SPF, DKIM, DMARC
- warm-up ramp (`SEND_RAMP`, default 5→50/day)
- throttle with jitter (`SEND_INTERVAL_SECONDS`, default 180s)
- CAN-SPAM footer: real physical address + working unsubscribe

Sending a few hundred cold emails from a cold personal Gmail will land you in
spam permanently.

## What can be done with no internet

Everything except step 1–2 above: editing templates, reading the code, and
running the parser logic against `tests/fixtures/`. The fixtures are committed
precisely so the parser stays testable offline.
