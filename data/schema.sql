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
  review_status TEXT NOT NULL DEFAULT 'new'
                CHECK (review_status IN ('new','approved','rejected')),
  scraped_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
  is_primary    INTEGER NOT NULL DEFAULT 0,
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
  status            TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','sent','failed','bounced','skipped')),
  gmail_message_id  TEXT,
  gmail_thread_id   TEXT,
  error             TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  queued_at         TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at           TEXT
);

-- THE GUARANTEE YOU ASKED FOR ------------------------------------------------
-- Partial unique indexes: a company/address can hold at most one send that is
-- live (queued) or successful (sent). Rows that failed or bounced fall OUT of
-- the index, so a genuine retry is still permitted -- but an accidental
-- second send is rejected by SQLite itself, not by app logic you might later
-- refactor around.
CREATE UNIQUE INDEX IF NOT EXISTS sends_one_per_company
  ON sends(company_id) WHERE status IN ('queued','sent');
CREATE UNIQUE INDEX IF NOT EXISTS sends_one_per_address
  ON sends(email_address) WHERE status IN ('queued','sent');
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
