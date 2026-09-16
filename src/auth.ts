// Accounts and sessions.
//
// This app reaches real sponsors, and every send is attributed to a person --
// on the company's tags and in the send log. That attribution is only worth
// anything if it cannot be casually claimed, hence real passwords rather than a
// "who's at the keyboard" dropdown.
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
  created_at: string;
  last_login_at: string | null;
}

/** Sessions last this long; a school laptop should not stay logged in forever. */
const SESSION_DAYS = 14;

const sha256 = (s: string): string =>
  new Bun.CryptoHasher("sha256").update(s).digest("hex");

// --- accounts ---------------------------------------------------------------

/** True until the first account exists. The UI then offers to create it. */
export const needsBootstrap = (): boolean =>
  (db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM students`).get()?.n ?? 0) === 0;

export const listStudents = (): Student[] =>
  db.query<Student, []>(
    `SELECT id, name, username, role, active, created_at, last_login_at
     FROM students ORDER BY active DESC, name COLLATE NOCASE`).all();

export const getStudent = (id: number): Student | null =>
  db.query<Student, [number]>(
    `SELECT id, name, username, role, active, created_at, last_login_at
     FROM students WHERE id = ?`).get(id) ?? null;

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

export async function createStudent(
  name: string, username: string, password: string,
  role: "student" | "admin" = "student",
): Promise<number> {
  validate(name, username, password);
  const hash = await Bun.password.hash(password);   // argon2id
  try {
    return Number(db.query(
      `INSERT INTO students (name, username, password_hash, role) VALUES (?, ?, ?, ?)`,
    ).run(name.trim(), username.trim().toLowerCase(), hash, role).lastInsertRowid);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new Error(`Username "${username.trim()}" is taken.`);
    throw e;
  }
}

/** The first account, created from the login page, is always an admin -- there
 *  would otherwise be nobody able to create the second. */
export const bootstrapAdmin = (name: string, username: string, password: string) => {
  if (!needsBootstrap()) throw new Error("An account already exists. Ask an admin to create yours.");
  return createStudent(name, username, password, "admin");
};

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
 * Verifies a password and opens a session. Returns the raw token for the
 * cookie; only its hash is stored.
 *
 * An unknown username still runs a hash comparison, so the response time does
 * not reveal which usernames exist.
 */
export async function login(username: string, password: string): Promise<
  { token: string; student: Student } | null
> {
  const row = db.query<{ id: number; password_hash: string; active: number }, [string]>(
    `SELECT id, password_hash, active FROM students WHERE username = ?`,
  ).get(username.trim().toLowerCase());

  const hash = row?.password_hash ?? (await dummyHash());
  let ok = false;
  try { ok = await Bun.password.verify(password, hash); } catch { ok = false; }

  if (!row || !ok || !row.active) return null;

  const token = crypto.randomUUID() + crypto.randomUUID();
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  db.query(`INSERT INTO sessions (token_hash, student_id, expires_at) VALUES (?, ?, ?)`)
    .run(sha256(token), row.id, expires);
  db.query(`UPDATE students SET last_login_at = datetime('now') WHERE id = ?`).run(row.id);

  return { token, student: getStudent(row.id)! };
}

/** The signed-in account for a cookie token, or null. Expired rows are swept. */
export function studentForToken(token: string | undefined): Student | null {
  if (!token) return null;
  db.query(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
  const row = db.query<{ student_id: number }, [string]>(
    `SELECT student_id FROM sessions WHERE token_hash = ? AND expires_at >= datetime('now')`,
  ).get(sha256(token));
  if (!row) return null;
  const student = getStudent(row.student_id);
  return student?.active ? student : null;
}

export function logout(token: string | undefined): void {
  if (token) db.query(`DELETE FROM sessions WHERE token_hash = ?`).run(sha256(token));
}

export const SESSION_COOKIE = "chembot_session";
export const SESSION_MAX_AGE = SESSION_DAYS * 86_400;
