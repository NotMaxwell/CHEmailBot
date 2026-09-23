# Gmail setup

Everything needed to take CHEmailBot from a fresh clone to one real message
delivered. Console work and computer work are separated because the console
half may need an admin who isn't you.

Budget ~30 minutes if you own the domain, plus DNS propagation. Add a day or
two if you need an admin to act.

---

## Step 0 — decide which Google account sends

This decision drives every step after it. The scope is `gmail.send`, which
Google classes as **sensitive** (not *restricted*) — so there is no third-party
security assessment in any path below.

| | Account | Refresh token | Verification | Cost |
|---|---|---|---|---|
| **A** | Personal `@gmail.com`, app in *Testing* | **dies every 7 days** | none | $0 |
| **B** | Workspace domain, audience *Internal* | indefinite | none | org's, or ~$7/user/mo |
| **C** | Personal `@gmail.com`, app *Published* | indefinite | consent-screen review, weeks | $0 |

**Use A to get to your first test send today. Use B for real outreach.**

Path A's 7-day expiry is survivable — reconnecting is one click — but sending
a few hundred cold emails from a cold personal Gmail lands them in spam
permanently, whatever the token does. That's the reason to move to B, not the
token.

### If you already have an organization account

Check it's actually Google before planning around it:

```sh
dig +short MX yourorg.com
```

- `aspmx.l.google.com` and friends → Google Workspace. Path B is open.
- `*.mail.protection.outlook.com` → Microsoft 365. `src/mail/gmail.ts` does not
  apply; sending would need a rewrite against Microsoft Graph `sendMail`.

Then confirm the two things an admin can block, **before** building anything:

1. **Project creation.** Sign into console.cloud.google.com with the org
   account and click **New Project**. *"You do not have permission to create
   projects"* means org policy restricts it — ask an admin for
   `resourcemanager.projects.create`, or for one project with you as Owner.
   The project must be owned by the org or **Internal** will not be selectable.
2. **Third-party API access.** Admin console → Security → Access and data
   control → **API controls**. Many orgs block unconfigured third-party apps by
   default. You will not find out until consent fails with
   `Error 403: admin_policy_enforced`.

And one non-technical gate: cold commercial mail spends the **org's** domain
reputation, and `SENDER_POSTAL_ADDRESS` in the footer of every message is a
claim to represent them. Fine when the org is who you're emailing on behalf of.
Get sign-off otherwise.

---

## Part A — console.cloud.google.com

Sign in as the account chosen in Step 0. If you switch accounts partway through
you will build the client in the wrong org and **Internal** will be missing.

### A1. Create the project

**New Project** → name it (e.g. `chemailbot`). For Path B, confirm the
**Location** field shows your organization, not *No organization*.

### A2. Enable the Gmail API

**APIs & Services → Library** → search *Gmail API* → **Enable**.

Easy to skip, and it fails late: the OAuth consent works fine and the first
send returns a 403 telling you the API is disabled for the project.

### A3. Branding

**Google Auth Platform → Branding** → **Get Started**.

- **App name** — appears on the consent screen you'll see. `CHEmailBot` is fine.
- **User support email** — yourself.
- **Audience** — see A4; the wizard asks here too.
- **Contact information** — your email.
- Accept the User Data Policy → **Create**.

### A4. Audience

**Google Auth Platform → Audience**.

- **Path B:** set to **Internal**. This is the switch that removes both the
  verification requirement and the 7-day token expiry. It only appears when the
  project is owned by a Workspace org — if it's greyed out, go back to Step 0.
- **Path A:** leave **External**, publishing status **Testing**, then under
  **Test users** → **Add users** → add the Gmail address that will send. An
  address not on this list cannot authorize at all.

### A5. Data access (scopes)

**Google Auth Platform → Data Access** → **Add or remove scopes** → filter for
and select:

```
https://www.googleapis.com/auth/gmail.send
```

**Update** → **Save**. Do not add a read scope. `gmail.send` cannot read your
inbox, and that is the whole point of choosing it.

### A6. Create the OAuth client

**Google Auth Platform → Clients** → **Create client**.

- **Application type: Web application.** Not *Desktop app* — the app serves its
  own callback route, and Web application is what matches the redirect URI
  below.
- **Name** — anything; console-only.
- **Authorized redirect URIs** → **Add URI**, exactly:

  ```
  http://localhost:3000/oauth/callback
  ```

  Exact string match, including scheme, port, and path. `localhost` is the one
  host Google exempts from its HTTPS requirement, which is why no tunnel is
  needed. If you changed `PORT`, change it here too.

- **Create.**

### A7. Copy the credentials

The dialog shows **Client ID** (`…apps.googleusercontent.com`) and **Client
secret** (`GOCSPX-…`). Keep the tab open, or reopen the client later — the
secret stays retrievable from the client's page.

### A8. Path B only — domain authentication (SPF, DKIM, DMARC)

This is the step that makes paying for a domain worth anything. Without DKIM,
cold mail from your domain is filtered about as hard as cold mail from a
personal Gmail, and you've bought nothing.

Two of the three changes are made at your **domain registrar** (DNS), not in
Google. Only DKIM starts in the Admin console.

#### A8.1 — Check what already exists

No admin rights needed. Run these first; on an established org domain all three
are often already done, and you can skip to A8.5.

```sh
DOMAIN=yourorg.com

dig +short TXT $DOMAIN | grep spf1                  # SPF
dig +short TXT google._domainkey.$DOMAIN            # DKIM (default selector)
dig +short TXT _dmarc.$DOMAIN                       # DMARC
```

| Command | Healthy output | Empty means |
|---|---|---|
| SPF | `"v=spf1 include:_spf.google.com ~all"` | Do A8.3 |
| DKIM | `"v=DKIM1; k=rsa; p=MIIBIj…"` | Do A8.2 — or a custom selector is in use; check the Admin console |
| DMARC | `"v=DMARC1; p=none; rua=mailto:…"` | Do A8.4 |

An empty DKIM result isn't proof it's off — a non-default prefix selector puts
it elsewhere. A8.2 shows you the selector actually in use.

#### A8.2 — DKIM (Admin console + registrar)

Needs Workspace super admin. **Menu → Apps → Google Workspace → Gmail →
Authenticate email.**

1. Pick the domain in **Selected domain**.
2. If it already says *Authenticating email with DKIM*, you're done — note the
   prefix selector shown and re-run the `dig` from A8.1 against it.
3. Otherwise **Generate new record**:
   - **Key length: 2048-bit.** Use 1024 only if your registrar rejects the
     longer value (see the gotcha below).
   - **Prefix selector:** leave `google`.
   - **Generate.**
4. Copy both values shown: the **DNS Host name** (`google._domainkey`) and the
   **TXT record value** (starts `v=DKIM1;`).
5. At your registrar, create a **TXT** record with those values.
6. Back in the Admin console, click **Start authentication**. Status should
   become *Authenticating email with DKIM*.

Allow up to 48 hours, though it's usually minutes. Two things that bite here:

- **Host field doubling.** Most registrars append the domain automatically, so
  the Host field takes `google._domainkey`, not
  `google._domainkey.yourorg.com` — the latter produces
  `google._domainkey.yourorg.com.yourorg.com`, which resolves to nothing.
  Check with the `dig` from A8.1 rather than trusting the UI.
- **The 2048-bit value is longer than 255 characters**, which is the per-string
  TXT limit. Most registrars split it for you. If yours rejects the paste,
  either split it into quoted chunks or regenerate at 1024-bit.

#### A8.3 — SPF (registrar only)

A **TXT** record on the root of the domain (Host field: `@`, or blank):

```
v=spf1 include:_spf.google.com ~all
```

- **Exactly one SPF record per domain.** If `dig` already returned one, *edit*
  it to add `include:_spf.google.com` — do not publish a second. Two SPF
  records is a permerror, and SPF then fails completely rather than falling
  back to either one. This is the single most common way to break a working
  domain.
- Multiple senders go in the same record:
  `v=spf1 include:_spf.google.com include:sendgrid.net ~all`
- Use `~all` (softfail), not `-all` — this is Google's own recommendation.
- SPF allows 10 DNS lookups total; each `include:` spends at least one.

#### A8.4 — DMARC (registrar only)

Do this **after** SPF and DKIM verify, not before — a policy published over
failing authentication tells receivers to distrust your own mail.

TXT record, Host `_dmarc`:

```
v=DMARC1; p=none; rua=mailto:dmarc@yourorg.com
```

Start at `p=none`, which changes nothing about delivery and only turns on
reporting. Read the `rua` reports for a couple of weeks, then tighten to
`p=quarantine` and eventually `p=reject`.

DMARC passes if **either** SPF or DKIM passes *and* aligns with the From
domain. Sending as `you@yourorg.com` through Gmail, DKIM signs with
`d=yourorg.com`, so it aligns — which is why A8.2 matters more than A8.3.

#### A8.5 — Verify end to end

`dig` proves the records exist. Only a real message proves they work.

Send one to a Gmail address you own — a plain message from the Workspace
account is enough, no need to involve the bot yet. Open it in Gmail, then
**⋮ → Show original**. The header block should read:

```
SPF:    PASS with IP …
DKIM:   'PASS' with domain yourorg.com
DMARC:  'PASS'
```

All three PASS, and the DKIM domain matching your From domain, is the green
light. Anything else, fix it before you queue a campaign — the warm-up ramp in
`SEND_RAMP` cannot rescue an unauthenticated domain.

---

## Part B — your computer

Nothing here needs a public server. Every call the app makes is outbound HTTPS
to `accounts.google.com`, `oauth2.googleapis.com`, and `gmail.googleapis.com`.
Google redirects *your browser* to localhost; it never connects to your machine.

### B1. Install

```sh
bun install
cp .env.example .env
```

Form assist additionally needs a browser, once: `bunx playwright install chromium`.

### B2. Fill in `.env`

```sh
GMAIL_CLIENT_ID=<from A7>
GMAIL_CLIENT_SECRET=<from A7>
GMAIL_REDIRECT_URI=http://localhost:3000/oauth/callback
GMAIL_SENDER=you@yourdomain.com
TEST_EMAIL=you@gmail.com        # different provider -- see B5

SENDER_NAME=Your Name
SENDER_ORG=Your Org
SENDER_POSTAL_ADDRESS=123 Real Street, Huntsville, AL 35801

DRY_RUN=1
```

- `GMAIL_SENDER` **must be the account that authorizes in B4.** Gmail sends as
  the token's owner; a mismatched `From` is silently rewritten, so a typo here
  shows up as mail from the wrong address rather than as an error.
- `GMAIL_REDIRECT_URI` must byte-match A6.
- `SENDER_NAME` and `SENDER_POSTAL_ADDRESS` are enforced, not advisory —
  `assertSendable()` in `src/config.ts` refuses to send while either is blank,
  and `footer()` in `src/mail/render.ts` appends both, plus opt-out
  instructions, to every body. There is no per-template way to turn this off.
- The opt-out mechanism is a reply, not a separate mailbox: recipients are told
  to reply to stop hearing from you, and the reply lands in `GMAIL_SENDER`
  itself (mail always sends from, and threads to, that inbox). Whoever reads it
  records the opt-out with the **Do not contact** button on the company page,
  or at `/suppressions` — there is no automated inbox scanning (the OAuth scope
  is send-only, see B1), so this is a manual step someone must do promptly.
- `.env` is gitignored. Keep it that way; the client secret is in it.

### B3. Write the template

Templates live in the database, edited from **Campaigns & templates** in the
web UI once the server is running (B4) — there is no template file to hand-edit.
Merge fields are `{{company}} {{city}} {{state}} {{website}} {{sender_name}}`;
an unknown field throws at render time rather than mailing a literal
`{{company}}` to a stranger. The CAN-SPAM footer (organisation, address,
opt-out) is appended automatically and is not itself a merge field.

### B4. Authorize

```sh
bun run dev          # http://127.0.0.1:3000
```

Click **connect Gmail** → consent as the `GMAIL_SENDER` account.

Path B shows no "unverified app" warning. Path A does — **Advanced → Go to
CHEmailBot (unsafe)** is expected for your own unpublished app.

Confirm the token landed:

```sh
ls -l data/.gmail-token.json     # mode 600, gitignored
```

### B5. Dry run

```sh
bun run test:self
```

Renders one message to `TEST_EMAIL` through the exact path a real send uses —
`contextFor` → `render` → `footer` → `buildRaw` — and prints the headers and
body it would transmit. Merge fields resolve against a built-in sample company,
so no company row is needed.

It writes nothing: no `sends` row, no budget consumed, no dedup slot burned.
Run it as often as you like. Useful flags:

```sh
bun run test:self someone@else.com     # override the recipient
bun run test:self --template 2         # a template other than the first
```

What to look at:

- The **footer** carries your name, a real postal address, and the unsubscribe
  line. `assertSendable()` runs first, so a blank CAN-SPAM field fails here.
- **`List-Unsubscribe`** is in the headers.
- **`Subject:`** and the body read like something a stranger would answer, with
  every `{{field}}` resolved. If you see a literal `{{…}}`, the template is
  wrong — though an *unknown* field throws rather than mailing the token.

**Set `TEST_EMAIL` to an address on a different provider than `GMAIL_SENDER`.**
Mail to your own domain routes internally inside Workspace: it never leaves
Google, so it exercises neither SPF/DKIM/DMARC nor spam filtering, and it will
pass no matter how broken your DNS is.

### B6. First real send

```sh
# .env
DRY_RUN=0
```

Restart anything running — `bun --watch` watches `src/`, but `.env` is read
with `readFileSync` at import, so a live reload will not pick this up. Then:

```sh
bun run test:self --send
```

`--send` refuses while `DRY_RUN=1`, so the guardrail still means something.

Open what arrived and use **Show original** (Gmail) or **View source**
(Outlook). Check, in order:

1. It's in the **Inbox**, not Spam — look in Spam before concluding anything.
2. `SPF: PASS`, `DKIM: PASS` with `d=` matching your From domain, `DMARC: PASS`.
3. The From line reads `Your Name <you@yourdomain.com>`. Rewritten means
   `GMAIL_SENDER` is not the account that authorized in B4.
4. The client shows its own unsubscribe affordance next to the sender.

Then put `DRY_RUN` back to `1` until you're ready to run the campaign. Nothing
else re-arms it.

Note the send consumes 1 of today's cap and marks today a sending day, so
tomorrow becomes ramp day 2. That is correct warm-up behavior, not something to
undo.

---

## Running under Docker

`docker-compose.yml` publishes `127.0.0.1:3000:3000`, so `localhost:3000`
resolves the same in your browser and the OAuth flow works unchanged. `./data`
is mounted, so `.gmail-token.json` and the database survive a rebuild. `.env`
is read at runtime via `env_file` — the secret is never baked into the image.

Form assist stays on the host: it drives a headed browser you click Submit in.

## Running on a remote machine

The UI has a login and sign-up is admin-approved, so reaching port 3000 is not
the same as getting in — but the database and `.env` are still readable by
anyone with a shell on the box. Do not publish it. Reach it over Tailscale or an
SSH tunnel and leave the compose port line alone:

```sh
ssh -L 3000:127.0.0.1:3000 user@host
```

With the tunnel up, `localhost:3000` on your laptop is the app on the server,
and the OAuth flow works with no change to the redirect URI. Alternatively,
authorize locally and copy the token up — `gmail.ts` only ever reads that file:

```sh
scp data/.gmail-token.json user@host:/path/to/CHEmailBot/data/
```

Sending from a cloud host is fine: Gmail API is HTTPS on 443, not SMTP on 25,
so provider port blocks don't apply.

---

## Troubleshooting

| What you see | Cause | Fix |
|---|---|---|
| `Error 400: redirect_uri_mismatch` | A6 and `GMAIL_REDIRECT_URI` differ | Byte-match them, including port and path |
| `Error 403: access_denied` on Path A | Sending address isn't a test user | A4 → Test users → Add users |
| `Error 403: admin_policy_enforced` | Workspace admin blocks third-party apps | Admin console → Security → API controls → allowlist the client ID as Trusted |
| `Error 403: org_internal` | Audience is Internal, you signed in with a non-org account | Sign in as the org account |
| `Gmail API has not been used in project …` | A2 skipped | Enable the Gmail API |
| `Google returned no refresh_token` | Prior grant still active | Revoke at myaccount.google.com → Data & privacy → Third-party apps, then reconnect |
| `invalid_grant: Token has been expired or revoked` after ~a week | Path A, app in Testing | Reconnect Gmail, or move to Path B |
| `Refusing to send: missing sender identity` / `missing SENDER_POSTAL_ADDRESS` | Blank field in `.env` | Fill `SENDER_NAME` and `SENDER_POSTAL_ADDRESS` |
| Mail arrives from the wrong address | `GMAIL_SENDER` ≠ authorized account | Correct it and reconnect |

## Token lifetime

- **Path B:** no fixed expiry, but Google drops a refresh token after **6
  months with no refresh call**. Any regular drain keeps it alive; a campaign
  once a semester does not. Reconnecting is one click.
- **Path A:** 7 days, always. Reconnect via **connect Gmail**.
- Revoking the app's access at myaccount.google.com invalidates the stored
  token immediately. Delete `data/.gmail-token.json` and reconnect.
