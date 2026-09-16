// Creates one demo company that points at your own address, so the whole
// review -> queue -> drain path can be walked end to end (and recorded) without
// touching a real Chamber listing.
//
//   bun run demo:seed                  # recipient from TEST_EMAIL in .env
//   bun run demo:seed me@example.com   # or an explicit one
//
// Idempotent: re-running updates the same row rather than creating a second.
// Remove it with `bun run demo:seed --remove`.

import { db, nameKey } from "./db.ts";
import { addManualEmail, listTemplates, getCompany } from "./repo.ts";
import { blockersFor } from "./mail/queue.ts";

/** Prefixed so it sorts last and is unmistakable next to real companies. */
const SLUG = "zz-demo-self-target";
const NAME = "Demo Target (send to self)";

function remove(): void {
  const row = db.query<{ id: number }, [string]>(
    `SELECT id FROM companies WHERE chamber_slug = ?`).get(SLUG);
  if (!row) return console.log("No demo company to remove.");
  // sends/emails/company_tags all cascade on company delete.
  db.query(`DELETE FROM companies WHERE id = ?`).run(row.id);
  console.log(`Removed demo company #${row.id}.`);
}

function seed(address: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(address)) {
    throw new Error(`"${address}" is not a valid email address.`);
  }
  const template = listTemplates()[0];
  if (!template) throw new Error("No templates exist yet -- create one at /campaigns.");

  const existing = db.query<{ id: number }, [string]>(
    `SELECT id FROM companies WHERE chamber_slug = ?`).get(SLUG);

  // Deliberately carries no street or website: it is a stand-in, and the
  // postal address on the message comes from SENDER_POSTAL_ADDRESS anyway.
  const id = existing?.id ?? Number(db.query(`
    INSERT INTO companies (chamber_slug, name, name_key, city, state, review_status, template_id)
    VALUES (?, ?, ?, 'Huntsville', 'AL', 'approved', ?)`)
    .run(SLUG, NAME, nameKey(NAME), template.id).lastInsertRowid);

  if (existing) {
    db.query(`UPDATE companies SET review_status='approved', template_id=? WHERE id=?`)
      .run(template.id, id);
  }
  addManualEmail(id, address);   // manual source: verified and primary in one step

  const blockers = blockersFor(id);
  console.log(`${existing ? "Updated" : "Created"} demo company #${id} -> ${address}`);
  console.log(`  template : ${template.name}`);
  console.log(`  blockers : ${blockers.length ? blockers.join(" ") : "none -- ready to queue"}`);
  console.log(`  open     : http://127.0.0.1:3000/company/${id}`);
  if (!getCompany(id)) throw new Error("seed failed to persist");
}

const args = process.argv.slice(2);
if (args.includes("--remove")) {
  remove();
} else {
  const address = args.find((a) => !a.startsWith("--")) ?? process.env.TEST_EMAIL ?? "";
  if (!address) {
    console.error("No recipient. Set TEST_EMAIL in .env, or pass one:\n" +
                  "  bun run demo:seed you@example.com");
    process.exit(1);
  }
  seed(address);
}
