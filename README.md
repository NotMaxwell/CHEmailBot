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
lists whatever is still missing. A queued message can be taken back with
**Cancel queued send**, and a company you should never have scraped can be
deleted outright with the `×` on its queue row — though the next Chamber sync
will find it again, so **Reject** is what keeps one out for good.

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
- **Opt-outs are honored everywhere.** Every message's footer tells the
  recipient to reply to stop hearing from us; the reply lands in the real
  Gmail inbox for a person to action with the "Do not contact" button (or
  `/suppressions`), which then blocks email sends, recorded form contacts, and
  the ready lists.
- **Nothing sends by accident.** `DRY_RUN` is on by default, and sending refuses
  to start without the CAN-SPAM fields.
- **The send log outlives everything else.** A company that has been contacted
  cannot be deleted, the same way a campaign or template on a logged message
  cannot — what was transmitted stays on the record.

Campaigns scope the dedup guarantee, so starting a new one (on **Campaigns &
templates**) is how you deliberately re-contact partners about a new event.

## Accounts

Every page except sign-in and sign-up requires an account, and **every send is
attributed to the person who made it** — their name signs the email and sets the
From display name, the send row records them, and the company picks up a
`Student: <name>` tag so the history page's tag filter answers "what did Alice
send?".

New students **ask for an account at `/signup`**, and that files a request
rather than creating one: until an admin accepts it on **`/requests`**, the row
exists but cannot sign in. The approval page shows the one thing the decision
is about — the signature a sponsor will read on that person's emails, rendered
exactly as a real send renders it — and offers Approve or Decline. Declining
deletes the request and frees the username, so an honest mistake can just ask
again. A count of waiting requests sits in the nav for admins, because a request
nobody notices is a student who cannot work.

An admin can also create an account outright on `/accounts`; making it *is* the
approval. That page is likewise the only way to hand out **admin** — a request
is always a student, so the role cannot be self-assigned. The first account,
however it is created, is an admin and is approved on the spot, because there is
nobody else to approve it.

Two things therefore cannot be claimed by typing them: the admin role, and
access itself. That is what lets the app sit somewhere more than one person can
reach while the name on a sponsor email still means something. Passwords are
argon2id (`Bun.password`), sessions are server-side rows keyed by a SHA-256 of
the cookie token, and changing a password, deactivating an account, or
un-approving one ends its sessions immediately.

## Security model

One team, this machine only. The server binds to `127.0.0.1` — don't change
`HOST` to expose it. Form posts are CSRF-protected, pages refuse to be framed,
and OAuth `state` is verified.

The login is **attribution, not a perimeter**: anyone with a shell on this
machine can read `data/chembot.db` and `.env` directly. It stops a student
filing work under someone else's name; it does not make the app safe to hand to
the internet.

Sign-up being admin-approved is what makes reaching the port different from
getting in. A stranger who finds the app can file a request and wait; they
cannot read the sponsor list or send anything. Put it on a network and that is
the gate doing the work, so:

- **On a LAN** (the [Pi deployment](deploy/pi/README.md)), the router is still
  the outer perimeter. Never forward a port to it.
- **On a public URL** (the [Render deployment](deploy/render/README.md)), also
  set `SIGNUP_CODE`. Approval already stops a stranger getting in; the code
  stops them filling the requests page with noise, and — the part approval
  cannot cover — stops someone claiming the **first** admin account in the
  window before you claim it yourself.

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

## Deploying it somewhere the team can reach

Running it on your laptop means it is up only while your laptop is. Two
recipes, both Docker, both with the setup written down rather than clicked:

| | |
|---|---|
| **[Raspberry Pi](deploy/pi/README.md)** — recommended | A Pi on the house LAN, reachable by every laptop in it and by nothing on the internet. `deploy/pi/setup.sh` does the whole install. Free to run, and the sponsor list stays on hardware you own. Covers the router, remote access, and backups. |
| **[Render](deploy/render/README.md)** | `render.yaml` describes the service; Render asks for the secrets and builds it. Public URL, about $8/month, no hardware. Set `SIGNUP_CODE` — it is on the open internet. |

Either way `DRY_RUN` stays at `1` until you have sent one real message to
yourself and read what arrived.

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
   The footer — organisation, postal address, and opt-out instructions — is
   appended to every message with no per-template way to turn it off; sending
   refuses to start while `SENDER_POSTAL_ADDRESS` is blank.
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
