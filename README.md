# CHEmailBot

Outreach to Huntsville-area technology companies from the Huntsville/Madison
County Chamber directory — with a review step before anything goes out, and a
database-enforced guarantee that no company is contacted twice in a campaign.

Runs locally: **Bun + Hono + SQLite**, Playwright for contact-form assist,
Gmail API for sending.

## Quick start

```sh
bun install
cp .env.example .env        # fill in CAN-SPAM fields at minimum
bun run dev                 # http://127.0.0.1:3000
```

Form assist also needs a browser (~150 MB, once): `bunx playwright install chromium`.

## How it works

The Chamber directory publishes **no email addresses** — its contact slot is a
Chamber-relayed form. So outreach takes two stages:

```
Chamber directory   →  companies + websites     Start Chamber scrape
each company's site →  email addresses, scored  Find emails
no address          →  its own contact form     bun run form:assist <id>
```

Then, per company: **verify it** as a target → **verify the address** →
**choose which address** → **choose a template** → **queue it** (or record a
form contact). The preview shows exactly what will be sent, and the send button
lists whatever is still missing.

| Channel | Measured hit rate |
|---|---|
| Email address found on the company's site | 8 of 10 |
| Fillable contact form found | 7 of 8 |

We deliberately do not automate the Chamber's own "Send Email" relay: every
message would carry the Chamber's name, and hundreds would trace back to one
member.

## Guarantees

- **No duplicates within a campaign.** Enforced by partial unique indexes on
  `(campaign, company_id)` and `(campaign, email_address)` — SQLite rejects a
  second live send even if application logic is bypassed. Failed sends fall out
  of the index, so retries still work.
- **No re-send after a crash.** A row is claimed before Gmail is called; if the
  process dies mid-send, the row is failed with instructions to check your Sent
  folder — never retried automatically.
- **Opt-outs are honored everywhere.** The Do-not-contact list blocks email
  sends, recorded form contacts, and the ready lists.
- **Nothing sends by accident.** `DRY_RUN` is on by default, and sending refuses
  to start without the CAN-SPAM fields.

Campaigns scope the dedup guarantee, so starting a new one (on **Past
companies**) is how you deliberately re-contact partners about a new event.

## Security model

Single user, this machine only. The server binds to `127.0.0.1` and has **no
login** — don't change `HOST` to expose it. Form posts are CSRF-protected,
pages refuse to be framed, and OAuth `state` is verified.

## Data

Everything lives in `data/chembot.db`, resolved from the project root wherever
the server is started. SQLite's WAL survives a hard kill.

```sh
bun run backup              # timestamped snapshot → data/backups/
```

## Commands

| Command | Does |
|---|---|
| `bun run dev` | UI with reload on change |
| `bun run start` | UI |
| `bun run scrape:chamber` | Chamber sync from the terminal |
| `bun run scrape:emails` | Email discovery from the terminal |
| `bun run form:assist <id>` | Open a company's contact form, pre-filled |
| `bun run send:drain` | Drain the send queue (honors `DRY_RUN`) |
| `bun run backup` | Snapshot the database |
| `bun test` | Tests (in-memory database only) |

## Before sending real email

1. **Gmail:** create an OAuth *Desktop app* client at
   console.cloud.google.com, put its ID and secret in `.env`, then click
   **connect Gmail**. The scope is `gmail.send`, which cannot read your inbox.
2. **Deliverability:** a few hundred cold emails from a cold personal Gmail will
   land in spam permanently. Use a dedicated domain with SPF, DKIM, and DMARC,
   and keep the warm-up ramp.
3. **CAN-SPAM:** a real postal address and a working unsubscribe address.
   Record opt-outs within 10 business days.
4. Set `DRY_RUN=0`, send **one** message to yourself, and read what arrived.

The Gmail send has not yet been run against Google — step 4 is its first real test.

## Development

```sh
bun test
bunx tsc --noEmit
```

Tests run against an in-memory database; `tests/setup.ts` is preloaded so no
test can reach `data/chembot.db`. See [CHANGELOG.md](CHANGELOG.md) for release
notes and known limitations, and [STATUS.md](STATUS.md) for design decisions.
