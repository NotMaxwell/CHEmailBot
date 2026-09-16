# Changelog

## [1.4.0] — 2026-09-16

### Changed
- **The footer now names the organisation, not the person**, and is opt-in per
  template. It prints `SENDER_ORG` (falling back to `SENDER_NAME`) and the
  postal address. Whoever wrote the message already signs it in the body, so
  repeating them below the rule said nothing new; what a cold recipient cannot
  get from the body is who the team is and where to find them.
- Templates carry an **Append the footer** checkbox, set when you create or edit
  one. Unticked, that template sends the body alone. Existing templates default
  to on, so nothing changes until you say so. The campaigns tab shows the
  footer exactly as it will appear, so the toggle is not abstract.
- `SENDER_POSTAL_ADDRESS` is now required only when a message actually carries
  the footer, checked as the message is built rather than globally at startup.
  `SENDER_NAME` is still required unconditionally — it is the From display name
  and the signature.

## [1.3.1] — 2026-09-16

### Added
- `SENDER_ORG`. Whoever signs a message is now presented as `<name>, <org>` —
  on the From display name, the footer signature, and `{{sender_name}}` — so a
  sponsor sees the team, not just a student they have never heard of. Blank
  keeps the previous behaviour of the name alone.

### Changed
- The send button reads **Send** rather than "Drain queue", and the background
  job reports itself as "Sending". `bun run send:drain` keeps its name.

### Fixed
- Tests pinned `SENDER_ORG` in `tests/setup.ts`. `config.ts` loads the project
  `.env` for any key not already set, so a real value would otherwise leak into
  the suite and make assertions depend on the developer's machine.

## [1.3.0] — 2026-09-15

### Added
- **Accounts.** Every page except `/login` is behind an auth gate. Passwords are
  argon2id via `Bun.password`; sessions are server-side rows storing only a
  SHA-256 of the cookie token, so a copied database file hands over no live
  sessions. The first account created becomes an admin — there is no self-signup.
  Admins add accounts, reset passwords, promote, and deactivate; the last active
  admin cannot be demoted or deactivated. Changing a password or deactivating an
  account ends its sessions at once.
- **Send attribution.** `sends.student_id` records who queued a message, and the
  company gains a `Student: <name>` tag when it actually sends (or immediately
  for a recorded form contact), so the existing tag filter on *Past companies*
  answers "what did this student work on?". Accounts with sends against them can
  be deactivated but not deleted.
- **The sender name now autofills from the signed-in account.** Resolution is
  per-company override → signed-in student → `SENDER_NAME`. A sponsor's reply
  reaches the person who wrote to them; the mailbox is unchanged.

### Removed
- The unsubscribe footer line and the `List-Unsubscribe` header, along with the
  `{{unsubscribe}}` merge field and the `UNSUBSCRIBE_MAILTO` requirement. This
  outreach is a sponsorship solicitation rather than commercial advertising.
  Opt-outs are handled by the do-not-contact list, which still blocks at send
  time and is now the only opt-out path — nothing reaches it automatically.

### Verified
- **The Gmail send ran against Google for the first time** and was delivered to
  an external provider, closing the one gap 1.0.0 shipped with. OAuth, refresh,
  rendering, and DKIM-signed delivery all confirmed end to end.

## [1.2.0] — 2026-09-15

### Added
- **Campaigns & templates tab.** One place for the two decisions you make
  before a run. Campaign switching moved off *Past companies* (a page about the
  past) and templates moved off their own tab; `/templates` redirects. The tab
  lists every campaign with its sent/queued counts and lets you delete an
  unused one.
- **A default template per campaign.** A company with no template of its own
  inherits it, so step 4 is one dropdown instead of one per company. The
  company page says whether the template was chosen there or inherited, and the
  preview always shows what would actually send.
- **Bulk template actions**: apply to companies with none, apply to all, or
  clear every choice so they fall back to the default. All three skip rejected
  companies and anything already queued or sent in the campaign.
- **Per-company sender name.** A box on the company page sets who signs the
  message; it drives `{{sender_name}}`, the footer signature, and the From
  display name, and is frozen onto the send row at queue time. Blank falls back
  to `SENDER_NAME`. The postal address and unsubscribe route are unaffected.
- `bun run test:self` — renders a message to `TEST_EMAIL` through the real send
  path and prints the headers and body; `--send` transmits it (refused while
  `DRY_RUN=1`). Writes nothing: no send row, no budget, no dedup slot.
- [SETUP.md](SETUP.md): the full Gmail/Workspace walkthrough, console side and
  computer side, with a troubleshooting table keyed by Google's error strings.

### Fixed
- **Email discovery no longer dies silently.** One company's crawl throwing
  ended the entire pass, reporting the failure only to the server console — the
  page just stopped updating, which looks identical to a job still working.
  Failures are now isolated per company, the run continues, and the outcome
  (crawled, found, and which sites failed) is shown on the review queue.
- Discovery progress shows a time estimate, so a legitimately long run is
  distinguishable from a hung one.

### Changed
- `README.md` corrected: the Gmail OAuth client is a **Web application**, not a
  Desktop app — a Desktop client does not match the `/oauth/callback` redirect
  URI that `.env.example` has always specified.

### Note
- `bun run dev` restarts on any change under `src/`, which cancels an in-flight
  background scrape. Long discovery runs are better started with
  `bun run scrape:emails` in their own terminal.

## [1.1.0] — 2026-09-15

### Added
- Docker: `Dockerfile` and `docker-compose.yml`. Published to `127.0.0.1` only,
  health-checked, `restart: unless-stopped`, with `./data` mounted so the
  database and backups stay on the host. Playwright browsers are kept out of
  the image — form assist stays on the host, where it can show you a browser.

### Changed
- The Gmail token is stored in `data/` so a container rebuild does not lose it
  (override with `GMAIL_TOKEN_PATH`).
- The startup warning about binding `0.0.0.0` now distinguishes a container
  (normal; the published port decides reachability) from the host (a real
  exposure).

## [1.0.0] — 2026-09-14

First release. Scrape, review, discovery, form assist, campaigns, tags, and the
do-not-contact list are verified end to end against live data. **The Gmail send
itself has never run against Google** — it needs OAuth credentials; everything
up to the API call is tested. See *Known limitations*.

### Added
- Chamber directory sync across four technology categories (314 companies).
- Email discovery from each company's own site, scored: `mailto:` 1.0 ·
  visible text 0.8 · embedded script data 0.6 · halved for unrelated domains.
- Five-step review: verify company → verify address → choose address →
  choose template → queue. The send button names every unmet gate.
- Contact-form assist (headed Playwright; fills the form, never submits) and a
  **Needs form assist** filter.
- Campaigns. Dedup is scoped per campaign, so a new campaign can deliberately
  re-contact; a banner warns when it does.
- **Past companies** page with label and reminder tags; contacts auto-tag
  `Messaged: <campaign>` with the rendered subject.
- Templates: create, edit, delete. Unknown merge fields are rejected on save.
- **Do not contact** list (addresses or whole domains), with a button on every
  company page. Blocks email sends, recorded form contacts, and the ready lists.
- Gmail sending (send-only scope): warm-up ramp, jittered interval, `DRY_RUN`
  on by default, CAN-SPAM footer, `List-Unsubscribe` header.
- `bun run backup` — consistent `VACUUM INTO` snapshots.
- Pages refresh themselves while a scrape runs.

### Security
- The server binds to `127.0.0.1`. It previously listened on every interface
  and answered from the LAN — with no login.
- CSRF protection on every form post; a page on another site could previously
  start scrapes or drain the send queue.
- Anti-framing and `nosniff` headers; OAuth `state` is verified.
- Website links render only for `http(s)` — escaping does not stop `javascript:`.

### Fixed
- **A crash mid-send could re-send the message.** Rows are now claimed before
  Gmail is called; a claimed row whose drain died is failed with instructions,
  never sent again.
- Viewing the dashboard advanced the warm-up ramp with nothing sent.
- A manually added address was stored but never became the one used, leaving
  the company blocked.
- Choosing an address that belonged to another company wiped the primary.
- `.env` and the Gmail token were ignored when started outside the project
  folder; the database opened relative to the working directory and could
  silently present a new, empty one.
- The company page showed "locked" for companies reached only in a *past*
  campaign; the review queue ignored campaigns entirely.
- Every **Find emails** run re-crawled every company that had no address.
- A hung Chamber connection froze the scrape and held the single job lock.
- Discovery missed script-embedded, single-quoted, and percent-encoded
  addresses; ranked a company's accountant equal to its own `info@`; demoted
  short domains like `biz-bob.com` as third parties; harvested Sentry keys and
  `user@domain.com` placeholders.
- Companies listed under several categories kept only the last.
- The test suite could reach the real database.

### Known limitations
- **Gmail send is unexercised** against the real API. Send one message to an
  address you control before any volume.
- **No authentication.** Single user, this machine only, by design.
- Existing companies carry one category each until the next Chamber sync.
- Discovery (8/10) and form-detection (7/8) rates come from small samples.
- Form assist is launched from the terminal (`bun run form:assist <id>`).
