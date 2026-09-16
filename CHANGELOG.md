# Changelog

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
