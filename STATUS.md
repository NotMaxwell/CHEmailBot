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

Measured on real scraped companies:

| channel | hit rate |
|---|---|
| email address found by crawling their site | **1 of 4** |
| fillable contact form found on their site  | **7 of 8** |

**Form assist is the primary channel, not email.** Plan the workflow around it.
Both samples are small; re-measure across the full set.

Form detection tries `/contact`, `/contact-us`, `/contact.html`, `/about`,
`/about-us`, then the homepage LAST — the reverse of discover.ts, because a bare
`<textarea>` on a homepage is usually a newsletter or search box. Matches that
rely on the bare-`textarea` fallback are flagged `confident: false` and warn you
to check before submitting (`isConfident`, tested in `tests/forms.test.ts`).

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

## Dedup guarantee — scoped to a campaign

Enforced by SQLite, not app logic. Defined in `src/db.ts` (not schema.sql,
because the indexes depend on the `campaign` column existing first):

```sql
CREATE UNIQUE INDEX sends_one_per_company_campaign
  ON sends(campaign, company_id) WHERE status IN ('queued','sent');
CREATE UNIQUE INDEX sends_one_per_address_campaign
  ON sends(campaign, email_address) WHERE status IN ('queued','sent');
```

**Why campaign-scoped.** The original indexes keyed on `company_id` alone, which
blocked a company from ever being contacted again — that made re-messaging past
partners about a new event impossible. Scoping to campaign keeps the property
that matters (no accidental duplicate inside one outreach) while allowing a
deliberate second contact under a new campaign name. Cross-campaign contact is
surfaced in the review UI as a visible "Re-contact" banner, never silently.

Partial, so `failed`/`bounced` drop out and genuine retries work. `nameKey()` in
`src/db.ts` normalizes identity so `A-P-T Research, Inc. (APT)` and
`APT Research Inc` collide (`tests/namekey.test.ts`).

## Persistence

State lives in `data/chembot.db` (SQLite, WAL). Verified by making real changes
through the UI, `kill -9`-ing the server, and restarting: review status,
template choice, manual addresses, tags, and the current campaign all came back
intact. WAL is crash-safe on its own — a hard kill loses nothing.

**The real risk was never crash safety, it was the path.** `DB_PATH` defaulted
to the relative `data/chembot.db`, resolved against `process.cwd()`. Starting
the server from anywhere but the repo root silently created a *second, empty*
database and served it as your data. Paths now resolve against the project root
derived from `import.meta.dir`, so the same database opens from any directory
(`resolveDbPath`, guarded by `tests/persistence.test.ts`).

A related hazard: `bun test` shares one module registry, so the first file to
import `src/db.ts` fixes the path for the whole run — which briefly pointed the
suite at the real database. `bunfig.toml` now preloads `tests/setup.ts`, which
forces `:memory:` before any test module loads.

### Backups

`bun run backup` writes a timestamped snapshot to `data/backups/` using
`VACUUM INTO`, which is consistent even while the server is mid-write (unlike
`cp`, which can catch the file between a write and its WAL checkpoint).
Snapshots are gitignored. There is no automatic schedule — run it before
anything destructive.

## Tags and history

`/history` lists every company ever contacted, newest first, filterable by tag
or campaign. Tags are free-form with two kinds:

- `label` — standing facts: `Partner`, `Repeat donor`
- `reminder` — things owed: `Send TY letter`. These get checked off rather than
  deleted, and open ones are counted in a banner at the top of the page.

**Auto-tagging.** A successful send (email or recorded form contact) tags the
company `Messaged: <campaign>` with the *rendered subject line stored in the
tag's note*. The subject deliberately does NOT go in the tag name — subjects
carry `{{company}}`, so that would mint a new single-use tag per company.

Switch campaigns from the top of `/history`; it is stored in the `settings`
table, so no `.env` edit is needed to start a new outreach.

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
