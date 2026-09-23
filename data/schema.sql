-- CHEmailBot schema. Applied idempotently on boot by src/db.ts.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- companies: harvested from the Huntsville/Madison County Chamber directory.
-- The Chamber exposes NO email addresses, so this table holds identity +
-- website only; addresses are resolved separately into `emails`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id            INTEGER PRIMARY KEY,
  chamber_slug  TEXT NOT NULL UNIQUE,   -- e.g. 'a-p-t-research-inc-apt-164'
  name          TEXT NOT NULL,          -- as displayed: 'A-P-T Research, Inc. (APT)'
  name_key      TEXT NOT NULL UNIQUE,   -- normalized: 'apt research'
  website       TEXT,
  phone         TEXT,
  street        TEXT,
  city          TEXT,
  state         TEXT,
  postal_code   TEXT,
  linkedin      TEXT,
  category      TEXT,                   -- chamber category slug it was found under
  template_id   INTEGER REFERENCES templates(id),  -- chosen in the review UI
  emails_checked_at TEXT,               -- last discovery crawl that reached the site
  review_status TEXT NOT NULL DEFAULT 'new'
                CHECK (review_status IN ('new','approved','rejected')),
  scraped_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A company can be listed under several Chamber categories. `companies.category`
-- only ever held the LAST one seen during a sync; this holds all of them.
CREATE TABLE IF NOT EXISTS company_categories (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category   TEXT NOT NULL,
  PRIMARY KEY (company_id, category)
);

-- ---------------------------------------------------------------------------
-- emails: candidate addresses discovered by crawling each company's own site.
-- A company may yield several (info@, sales@, a named contact); exactly one
-- may be flagged primary, which is the one the send queue will use.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS emails (
  id            INTEGER PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  address       TEXT NOT NULL,
  source        TEXT NOT NULL
                CHECK (source IN ('mailto','contact_page','manual','pattern')),
  confidence    REAL NOT NULL DEFAULT 0.5,
  is_primary    INTEGER NOT NULL DEFAULT 0,   -- the address the send will use
  verified      INTEGER NOT NULL DEFAULT 0,   -- a human confirmed it is correct
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, address)
);
CREATE INDEX IF NOT EXISTS emails_address ON emails(address);
-- at most one primary address per company
CREATE UNIQUE INDEX IF NOT EXISTS emails_one_primary
  ON emails(company_id) WHERE is_primary = 1;

-- ---------------------------------------------------------------------------
-- templates: your fill-in-the-blank outreach copy. Body is Markdown with
-- {{company}} / {{city}} style merge fields resolved by src/mail/render.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS templates (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- sends: the dedup ledger. One row per attempt, storing the FULLY RENDERED
-- copy actually transmitted, so the log stays truthful even if you later
-- edit the template.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sends (
  id                INTEGER PRIMARY KEY,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email_address     TEXT NOT NULL,
  template_id       INTEGER REFERENCES templates(id),
  subject           TEXT NOT NULL,
  body              TEXT NOT NULL,
  channel           TEXT NOT NULL DEFAULT 'gmail'
                    CHECK (channel IN ('gmail','form')),
  -- Which outreach this belongs to. Dedup is scoped to this, so a new
  -- campaign may deliberately re-contact a company a previous one reached.
  campaign          TEXT NOT NULL DEFAULT 'initial-outreach',
  status            TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','sent','failed','bounced','skipped')),
  gmail_message_id  TEXT,
  gmail_thread_id   TEXT,
  error             TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  queued_at         TEXT NOT NULL DEFAULT (datetime('now')),
  -- Set when a drain CLAIMS the row, before calling Gmail. A row still queued
  -- with this set was interrupted mid-send: it may or may not have gone out.
  attempted_at      TEXT,
  sent_at           TEXT
);

-- THE GUARANTEE YOU ASKED FOR is enforced by partial unique indexes created in
-- src/db.ts -- they depend on the `campaign` column existing, which for an
-- older database only happens after ensureColumn() runs. See db.ts.
CREATE INDEX IF NOT EXISTS sends_status ON sends(status);

-- ---------------------------------------------------------------------------
-- suppressions: unsubscribes, bounces, and manual do-not-contact. Checked
-- before anything is queued. Matches a bare address or a whole domain.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppressions (
  id         INTEGER PRIMARY KEY,
  value      TEXT NOT NULL UNIQUE,   -- 'foo@bar.com' or 'bar.com'
  kind       TEXT NOT NULL CHECK (kind IN ('address','domain')),
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- send_budget: one row per calendar day, enforcing the warm-up ramp so a cold
-- domain is not torched by volume on day one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS send_budget (
  day        TEXT PRIMARY KEY,        -- 'YYYY-MM-DD'
  cap        INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);

-- A default template so the UI has something selectable on first boot.
INSERT OR IGNORE INTO templates (id, name, subject, body) VALUES (
  1, 'Default outreach', 'Quick question about {{company}}',
  'Hi {{company}} team,'||char(10)||char(10)||
  'I came across {{company}} in the Huntsville/Madison County Chamber directory and wanted to reach out.'
  ||char(10)||char(10)||'Best,'||char(10)||'{{sender_name}}'
);

-- ---------------------------------------------------------------------------
-- tags: free-form marks on a company, surviving across campaigns. Two kinds:
--   'label'    standing facts   -- 'Partner', 'Repeat donor'
--   'reminder' things owed them -- 'Send TY letter'
-- Reminders are what the history page surfaces as an action list.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL DEFAULT 'label' CHECK (kind IN ('label','reminder')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS company_tags (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  note       TEXT,                                   -- optional per-company detail
  done       INTEGER NOT NULL DEFAULT 0,             -- reminders only: cleared when handled
  added_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (company_id, tag_id)
);
CREATE INDEX IF NOT EXISTS company_tags_tag ON company_tags(tag_id);

-- Starter tags matching the cases you named.
INSERT OR IGNORE INTO tags (name, kind) VALUES
  ('Partner', 'label'),
  ('Repeat donor', 'label'),
  ('Send TY letter', 'reminder');

-- ---------------------------------------------------------------------------
-- campaigns: a named outreach. First-class rather than an implied string on
-- sends, so a campaign you have created but not yet sent under still exists
-- and still appears in the picker.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO campaigns (name) VALUES ('initial-outreach');

-- ---------------------------------------------------------------------------
-- settings: small key/value store. Holds the current campaign name, so a new
-- outreach can be started from the UI without touching .env.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('current_campaign', 'initial-outreach');

-- ---------------------------------------------------------------------------
-- students: who is doing the outreach. Real accounts, because a send is
-- attributed to a person and that attribution ends up on the company record and
-- in the log -- the password is what stops someone else sending under it later.
--
-- Sign-up is open: anyone who can reach /signup creates a working student
-- account, so the loopback bind is what limits who gets one. `role` is the
-- exception -- the sign-up form always writes 'student', and only an existing
-- admin can grant admin. The FIRST account is an admin however it was created
-- (see auth.needsBootstrap), because there is nobody to promote it otherwise.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS students (
  id            INTEGER PRIMARY KEY,
  -- Display name. This SIGNS the email and appears on the company's tag, so it
  -- should read the way a sponsor should see it.
  name          TEXT NOT NULL,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,              -- argon2id, via Bun.password
  role          TEXT NOT NULL DEFAULT 'student'
                CHECK (role IN ('student','admin')),
  -- Deactivating keeps the person's history and tags intact while ending their
  -- access. Deleting an account that has sends against it is refused.
  active        INTEGER NOT NULL DEFAULT 1,
  -- NULL means the account is a REQUEST, not an account: it was created at
  -- /signup and cannot sign in until an admin approves it. An admin creating
  -- someone directly, and the very first account, are approved on the spot.
  approved_at   TEXT,
  approved_by   INTEGER REFERENCES students(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- ---------------------------------------------------------------------------
-- sessions: server-side, so revoking access is a DELETE rather than a wait.
-- Only the SHA-256 of the cookie token is stored: a stolen database file does
-- not hand over live sessions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_student ON sessions(student_id);
