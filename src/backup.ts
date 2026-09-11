// Point-in-time snapshot of the database.
//
// VACUUM INTO takes a consistent copy even while the server is running and
// mid-write -- unlike `cp`, which can catch the file between a write and its
// WAL checkpoint and produce a torn copy.
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { db, ROOT, DB_FILE } from "./db.ts";

export function backup(): string {
  const dir = join(ROOT, "data/backups");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = join(dir, `chembot-${stamp}.db`);
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  return out;
}

if (import.meta.main) {
  const out = backup();
  console.log(`source : ${DB_FILE}`);
  console.log(`backup : ${out}  (${(statSync(out).size / 1024).toFixed(0)} KB)`);
  const all = readdirSync(join(ROOT, "data/backups")).filter((f) => f.endsWith(".db")).sort();
  console.log(`kept   : ${all.length} snapshot${all.length === 1 ? "" : "s"}`);
}
