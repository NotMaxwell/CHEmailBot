// Accounts and sessions.
//
// This app reaches real sponsors, and every send is attributed to a person --
// on the company's tags and in the send log. Accounts are self-service, so the
// name on a send is whatever its owner typed at /signup; what the password buys
// is that nobody else can then send under it, which a "who's at the keyboard"
// dropdown would not give.
//
// Sign-up is a REQUEST, not an account: an admin approves it at /requests
// before it can sign in. That is what lets the app sit somewhere more than one
// person can reach without the name on a message becoming a free-text field.
//
// It is NOT a substitute for the loopback bind. Anyone with a shell on this
// machine can read data/chembot.db and .env directly; the login stops a student
// filing work under someone else's name, not an attacker with the disk.

import { db } from "./db.ts";

export interface Student {
  id: number;
  name: string;
  username: string;
  role: "student" | "admin";
  active: 0 | 1;
  /** Null while the account is still a request nobody has accepted. */
  approved_at: string | null;
  approved_by: number | null;
  created_at: string;
  last_login_at: string | null;
}

/** The columns every read of a student wants. One list, so adding a field
 *  cannot leave one query behind returning a half-built Student. */
const COLUMNS =
  `id, name, username, role, active, approved_at, approved_by, created_at, last_login_at`;

/** Sessions last this long; a school laptop should not stay logged in forever. */
const SESSION_DAYS = 14;

const sha256 = (s: string): string =>
  new Bun.CryptoHasher("sha256").update(s).digest("hex");

// --- accounts ---------------------------------------------------------------

/** True until the first account exists. The UI then offers to create it. */
export const needsBootstrap = (): boolean =>
  (db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM students`).get()?.n ?? 0) === 0;

/** Real accounts. Requests waiting on an admin are NOT accounts yet and are
 *  listed by pendingRequests() instead, so the two never blur together. */
export const listStudents = (): Student[] =>
  db.query<Student, []>(
    `SELECT ${COLUMNS} FROM students
     WHERE approved_at IS NOT NULL
     ORDER BY active DESC, name COLLATE NOCASE`).all();

/** Any row, approved or not -- approving one has to be able to read it first. */
export const getStudent = (id: number): Student | null =>
  db.query<Student, [number]>(
    `SELECT ${COLUMNS} FROM students WHERE id = ?`).get(id) ?? null;

// --- approval ---------------------------------------------------------------

/** Sign-ups waiting on an admin, oldest first -- the order to work through. */
export const pendingRequests = (): Student[] =>
  db.query<Student, []>(
    `SELECT ${COLUMNS} FROM students
     WHERE approved_at IS NULL ORDER BY created_at`).all();

/** For the nav badge: an admin should not have to go looking. */
export const pendingCount = (): number =>
  db.query<{ n: number }, []>(
    `SELECT COUNT(*) n FROM students WHERE approved_at IS NULL`).get()?.n ?? 0;

/** Lets a request in, recording who opened the door. */
export function approveStudent(id: number, approvedBy: number): void {
  const target = getStudent(id);
  if (!target) throw new Error("No such account.");
  if (target.approved_at) throw new Error(`${target.name} is already approved.`);
  db.query(`UPDATE students SET approved_at = datetime('now'), approved_by = ?
            WHERE id = ? AND approved_at IS NULL`).run(approvedBy, id);
}

/**
 * Turns a request away. The row is deleted rather than flagged, so the username
 * frees up and an honest mistake can simply sign up again.
 *
 * The `approved_at IS NULL` in the WHERE clause is the safety: whatever id is
 * passed, this statement cannot touch an account that someone already accepted.
 */
export function declineStudent(id: number): void {
  const target = getStudent(id);
  if (!target) throw new Error("No such account.");
  if (target.approved_at) {
    throw new Error(`${target.name} is an approved account. Deactivate it instead.`);
  }
  db.query(`DELETE FROM students WHERE id = ? AND approved_at IS NULL`).run(id);
}

function validate(name: string, username: string, password: string): void {
  if (!name.trim()) throw new Error("Name cannot be empty.");
  if (name.trim().length > 80) throw new Error("Name is too long (80 characters max).");
  if (!/^[a-z0-9._-]{3,32}$/i.test(username.trim())) {
    throw new Error("Username must be 3-32 characters: letters, digits, dot, dash, underscore.");
  }
  // Long enough to not be guessed over a shared-machine shoulder; no character
  // classes, because those push people toward "Password1!" and a sticky note.
  if (password.length < 10) throw new Error("Password must be at least 10 characters.");
  if (password.length > 200) throw new Error("Password is too long (200 characters max).");
}

/**
 * Writes the row. `approvedBy` decides what kind of row it is:
 *
 *   a number  an admin made this account, and that act IS the approval
 *   null      the system made it -- the bootstrap admin, approved by nobody
 *   "pending" a request from /signup, which cannot sign in until accepted
 */
async function insertStudent(
  name: string, username: string, password: string,
  role: "student" | "admin", approvedBy: number | null | "pending",
): Promise<number> {
  validate(name, username, password);
  const hash = await Bun.password.hash(password);   // argon2id
  const pending = approvedBy === "pending";
  try {
    return Number(db.query(
      `INSERT INTO students (name, username, password_hash, role, approved_at, approved_by)
       VALUES (?, ?, ?, ?, ${pending ? "NULL" : "datetime('now')"}, ?)`,
    ).run(name.trim(), username.trim().toLowerCase(), hash, role,
          pending ? null : approvedBy).lastInsertRowid);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new Error(`Username "${username.trim()}" is taken.`);
    throw e;
  }
}

/** An admin creating someone directly, from /accounts. Approved on the spot:
 *  an admin typing the account into existence is the approval. */
export const createStudent = (
  name: string, username: string, password: string,
  role: "student" | "admin" = "student", approvedBy: number | null = null,
): Promise<number> => insertStudent(name, username, password, role, approvedBy);

/** The first account, created from the login page, is always an admin -- there
 *  would otherwise be nobody able to create the second. */
export const bootstrapAdmin = (name: string, username: string, password: string) => {
  if (!needsBootstrap()) throw new Error("An account already exists. Sign up or sign in.");
  return insertStudent(name, username, password, "admin", null);
};

/**
 * Self-service sign-up, from /signup. This does NOT hand out an account -- it
 * files a request an admin has to accept at /requests.
 *
 * Two things cannot be claimed by typing them. Admin is one: a request is
 * always a student, and the role is granted afterwards or not at all. Access is
 * the other: until someone who already has an account says yes, the row exists
 * but cannot sign in. Together they are what make the name on a sponsor email
 * mean something even when more than one person can reach the app.
 *
 * The first account is the exception, and has to be: with an empty table there
 * is nobody to approve anything, so it is created outright as the admin.
 */
export const signUp = (name: string, username: string, password: string) =>
  needsBootstrap()
    ? insertStudent(name, username, password, "admin", null)
    : insertStudent(name, username, password, "student", "pending");

export async function setPassword(id: number, password: string): Promise<void> {
  if (password.length < 10) throw new Error("Password must be at least 10 characters.");
  if (password.length > 200) throw new Error("Password is too long (200 characters max).");
  const hash = await Bun.password.hash(password);
  db.query(`UPDATE students SET password_hash = ? WHERE id = ?`).run(hash, id);
  // A password change ends every other session for that account.
  db.query(`DELETE FROM sessions WHERE student_id = ?`).run(id);
}

export function setActive(id: number, active: boolean): void {
  const admins = db.query<{ n: number }, []>(
    `SELECT COUNT(*) n FROM students WHERE role='admin' AND active=1`).get()?.n ?? 0;
  const target = getStudent(id);
  if (!target) throw new Error("No such account.");
  if (!active && target.role === "admin" && admins <= 1) {
    throw new Error("That is the only active admin. Promote someone else first.");
  }
  db.query(`UPDATE students SET active = ? WHERE id = ?`).run(active ? 1 : 0, id);
  if (!active) db.query(`DELETE FROM sessions WHERE student_id = ?`).run(id);
}

export function setRole(id: number, role: "student" | "admin"): void {
  const target = getStudent(id);
  if (!target) throw new Error("No such account.");
  const admins = db.query<{ n: number }, []>(
    `SELECT COUNT(*) n FROM students WHERE role='admin' AND active=1`).get()?.n ?? 0;
  if (role === "student" && target.role === "admin" && admins <= 1) {
    throw new Error("That is the only active admin. Promote someone else first.");
  }
  db.query(`UPDATE students SET role = ? WHERE id = ?`).run(role, id);
}

/** Accounts with sends against them are kept, so the log stays readable. */
export function deleteStudent(id: number): void {
  const used = db.query<{ n: number }, [number]>(
    `SELECT COUNT(*) n FROM sends WHERE student_id = ?`).get(id)?.n ?? 0;
  if (used) {
    throw new Error(
      `This account is on ${used} logged message(s) and is kept for the record. Deactivate it instead.`);
  }
  setActive(id, false);            // reuses the last-admin guard
  db.query(`DELETE FROM students WHERE id = ?`).run(id);
}

// --- sessions ---------------------------------------------------------------

/**
 * A real argon2id hash of a value nobody knows, computed once on first use.
 *
 * A hand-written constant here would not parse, so verify() would throw
 * immediately instead of doing the work -- making an unknown username visibly
 * faster than a wrong password, which is the leak this exists to close.
 */
let dummyHashPromise: Promise<string> | null = null;
const dummyHash = (): Promise<string> =>
  (dummyHashPromise ??= Bun.password.hash(crypto.randomUUID()));

/**
 * Why a sign-in did not open a session.
 *
 * "credentials" is deliberately vague -- naming which of the username and the
 * password was wrong tells an outsider which usernames are real. The other two
 * are specific, and safely so: they are only ever reached by someone who has
 * just proved they know the password, which is to say by the account's owner,
 * who needs to be told what to do next rather than left retyping.
 */
export type LoginFailure = "credentials" | "pending" | "deactivated";

export type LoginResult =
  | { ok: true; token: string; student: Student }
  | { ok: false; reason: LoginFailure };

/**
 * Verifies a password and opens a session. Returns the raw token for the
 * cookie; only its hash is stored.
 *
 * An unknown username still runs a hash comparison, so the response time does
 * not reveal which usernames exist.
 */
export async function login(username: string, password: string): Promise<LoginResult> {
  const row = db.query<
    { id: number; password_hash: string; active: number; approved_at: string | null }, [string]
  >(
    `SELECT id, password_hash, active, approved_at FROM students WHERE username = ?`,
  ).get(username.trim().toLowerCase());

  const hash = row?.password_hash ?? (await dummyHash());
  let ok = false;
  try { ok = await Bun.password.verify(password, hash); } catch { ok = false; }

  if (!row || !ok) return { ok: false, reason: "credentials" };
  // Checked only AFTER the password, so these answers leak nothing: reaching
  // them means you are the owner of the account you are asking about.
  if (!row.approved_at) return { ok: false, reason: "pending" };
  if (!row.active) return { ok: false, reason: "deactivated" };

  const token = crypto.randomUUID() + crypto.randomUUID();
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  db.query(`INSERT INTO sessions (token_hash, student_id, expires_at) VALUES (?, ?, ?)`)
    .run(sha256(token), row.id, expires);
  db.query(`UPDATE students SET last_login_at = datetime('now') WHERE id = ?`).run(row.id);

  return { ok: true, token, student: getStudent(row.id)! };
}

/** What the sign-in page says for each failure. */
export const loginMessage = (reason: LoginFailure): string => ({
  credentials: "That username and password do not match.",
  pending: "Your sign-up is waiting for an admin to approve it. You will be able to sign in once they have.",
  deactivated: "That account has been deactivated. Ask an admin to turn it back on.",
}[reason]);

/** The signed-in account for a cookie token, or null. Expired rows are swept. */
export function studentForToken(token: string | undefined): Student | null {
  if (!token) return null;
  db.query(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
  const row = db.query<{ student_id: number }, [string]>(
    `SELECT student_id FROM sessions WHERE token_hash = ? AND expires_at >= datetime('now')`,
  ).get(sha256(token));
  if (!row) return null;
  const student = getStudent(row.student_id);
  if (!student || !student.active || !student.approved_at) return null;
  return student;
}

export function logout(token: string | undefined): void {
  if (token) db.query(`DELETE FROM sessions WHERE token_hash = ?`).run(sha256(token));
}

export const SESSION_COOKIE = "chembot_session";
export const SESSION_MAX_AGE = SESSION_DAYS * 86_400;
