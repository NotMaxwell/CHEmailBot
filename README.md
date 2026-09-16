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

Sending needs Gmail credentials on top of that — see [SETUP.md](SETUP.md).

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

Set the campaign and its default template once on **Campaigns & templates**, and
every company inherits that template — so the per-company step 4 is only for the
ones you want to say something different to. Each company can also carry its own
sender name, which signs the message and sets the From display name.

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

Campaigns scope the dedup guarantee, so starting a new one (on **Campaigns &
templates**) is how you deliberately re-contact partners about a new event.

## Accounts

Every page except sign-in requires an account, and **every send is attributed to
the person who made it** — their name signs the email and sets the From display
name, the send row records them, and the company picks up a `Student: <name>`
tag so the history page's tag filter answers "what did Alice send?".

The first account created is an admin; only an admin can add accounts or reset a
password, so there is no self-signup on a tool that reaches real sponsors.
Passwords are argon2id (`Bun.password`), sessions are server-side rows keyed by
a SHA-256 of the cookie token, and changing a password or deactivating an
account ends its sessions immediately.

## Security model

One team, this machine only. The server binds to `127.0.0.1` — don't change
`HOST` to expose it. Form posts are CSRF-protected, pages refuse to be framed,
and OAuth `state` is verified.

The login is **attribution, not a perimeter**: anyone with a shell on this
machine can read `data/chembot.db` and `.env` directly. It stops a student
filing work under someone else's name; it does not make the app safe to put on
a network.

## Data

Everything lives in `data/chembot.db`, resolved from the project root wherever
the server is started. SQLite's WAL survives a hard kill.

```sh
bun run backup              # timestamped snapshot → data/backups/
```

## Running in Docker

```sh
bun run docker:up      # build and start
bun run docker:logs
bun run docker:down
```

- **Stays up.** `restart: unless-stopped` brings it back after a crash or a
  reboot. (Docker deliberately ignores that if *you* stop the container.)
- **Your data stays on the host.** `./data` is mounted, so the database,
  backups, and the Gmail token survive a rebuild.
- **Secrets are not in the image.** `.env` is read at runtime via `env_file`.
- **The published port is `127.0.0.1:3000:3000`.** Do not change it to
  `3000:3000` — this UI has no login. Inside the container the app listens on
  `0.0.0.0`, which is required and safe *because* of that publish line.
- **Form assist is not containerized.** It drives a headed browser you click
  Submit in, so run it on the host: `bun run form:assist <id>`.

## Commands

| Command | Does |
|---|---|
| `bun run dev` | UI with reload on change |
| `bun run start` | UI |
| `bun run scrape:chamber` | Chamber sync from the terminal |
| `bun run scrape:emails` | Email discovery from the terminal — survives a dev-server restart |
| `bun run form:assist <id>` | Open a company's contact form, pre-filled |
| `bun run send:drain` | Drain the send queue (honors `DRY_RUN`) |
| `bun run test:self` | Preview one message to `TEST_EMAIL`; `--send` to really send it |
| `bun run backup` | Snapshot the database |
| `bun test` | Tests (in-memory database only) |

## Before sending real email

1. **Gmail:** create an OAuth *Web application* client at
   console.cloud.google.com, put its ID and secret in `.env`, then click
   **connect Gmail**. The scope is `gmail.send`, which cannot read your inbox.
   Full walkthrough, console side and computer side: [SETUP.md](SETUP.md).
2. **Deliverability:** a few hundred cold emails from a cold personal Gmail will
   land in spam permanently. Use a dedicated domain with SPF, DKIM, and DMARC,
   and keep the warm-up ramp.
3. **Identity:** `SENDER_NAME`, `SENDER_ORG`, and a real `SENDER_POSTAL_ADDRESS`.
   The footer prints the organisation and its address, and is per-template —
   untick **Append the footer** and that template sends the body alone.
4. Preview with `bun run test:self`, then set `DRY_RUN=0` and
   `bun run test:self --send` to put **one** real message in your own inbox.
   Read what arrived, headers included.

The Gmail send has not yet been run against Google — step 4 is its first real test.

## Development

```sh
bun test
bunx tsc --noEmit
```

Tests run against an in-memory database; `tests/setup.ts` is preloaded so no
test can reach `data/chembot.db`.

`bun run dev` reloads on any change under `src/`, which **cancels an in-flight
background scrape**. Start long discovery runs with `bun run scrape:emails` in
their own terminal instead. See [CHANGELOG.md](CHANGELOG.md) for release
notes and known limitations, and [STATUS.md](STATUS.md) for design decisions.
