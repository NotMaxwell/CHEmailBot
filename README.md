# CHEmailBot

Templated cold outreach to Huntsville-area technology companies, with a web UI
for review and a hard guarantee that no company is contacted twice.

Stack: **Bun + Hono + HTMX + SQLite**, Gmail API for sending, Playwright for
semi-automatic contact-form assist.

## The finding that shapes this project

The source everyone calls "the Huntsville ledger" is the Huntsville/Madison
County Chamber directory at `cm.hsvchamber.org` (GrowthZone/ChamberMaster).
It has 125 categories, 4 of them technology-relevant.

**It publishes no email addresses.** A member page renders the contact slot as:

```html
<span itemprop="email">Send Email</span>   <!-- href="javascript:void(0)" -->
```

That's a Chamber-relayed form, not an address. What you *do* get per listing:
name, street address, phone, fax, **website URL**, LinkedIn, category.

So the pipeline is necessarily two-stage:

```
Chamber directory  ->  companies + websites   (src/scrape/chamber.ts)
company's own site ->  real email address     (src/scrape/discover.ts)
no address found   ->  semi-auto form assist  (src/forms/assist.ts)
```

`robots.txt` permits `/list`, `/list/category/*`, and `/list/member/*`.
Only `/list/search` is disallowed — the scraper must never touch it.

### Why we don't automate the Chamber's "Send Email" relay

Every message sent through it arrives stamped with the Chamber's name, so a few
hundred of them trace back to one member the moment anyone complains. That's a
local-reputation cost, not just a legal one. `forms/assist.ts` targets each
*company's own* contact form instead, and never clicks submit — it fills the
message and hands the browser to you.

## The dedup guarantee

Enforced by SQLite, not by application logic:

```sql
CREATE UNIQUE INDEX sends_one_per_company
  ON sends(company_id) WHERE status IN ('queued','sent');
CREATE UNIQUE INDEX sends_one_per_address
  ON sends(email_address) WHERE status IN ('queued','sent');
```

Partial indexes, so `failed`/`bounced` rows drop out and a genuine retry still
works — but an accidental second send is rejected by the database itself.
Company identity is normalized by `nameKey()` so `A-P-T Research, Inc. (APT)`
and `APT Research Inc` collide correctly (see `tests/namekey.test.ts`).

## Setup

```sh
curl -fsSL https://bun.sh/install | bash   # bun is not yet installed on this machine
bun install
cp .env.example .env                       # fill in Gmail + CAN-SPAM fields
bun run dev
```

`DRY_RUN` defaults to **on**. Sending requires setting `DRY_RUN=0` explicitly.

### Deliverability, before you send anything real

Sending a few hundred cold emails from a cold personal Gmail will land you in
spam permanently. Non-negotiables:

- a dedicated sending domain with SPF, DKIM, and DMARC
- the warm-up ramp (`SEND_RAMP`, default 5→50/day)
- throttling with jitter (`SEND_INTERVAL_SECONDS`, default 180s)
- a CAN-SPAM footer: real physical address + working unsubscribe.
  `assertSendable()` refuses to send if these are blank.

## Build order

1. `scrape/chamber.ts` — `syncAll()` upsert; verify company counts
2. `web/routes.ts` — the review queue table (you need to *see* the scrape)
3. `scrape/discover.ts` — email resolution from company sites
4. `mail/render.ts` + template editor with per-company preview
5. `mail/gmail.ts` — OAuth bootstrap, send-only scope
6. `mail/queue.ts` — `drain()` with the five gates
7. `forms/assist.ts` — semi-auto fallback

Each stage is reviewable in the UI before the next one runs. The human
approval step between scrape and send is what stops a bad scrape from becoming
500 embarrassing emails.
