import { Hono } from "hono";
import { layout, esc } from "./views/layout.ts";
import { queuePage, companyPage } from "./views/companies.ts";
import * as repo from "../repo.ts";
import { db } from "../db.ts";
import { config } from "../config.ts";
import { syncAll } from "../scrape/chamber.ts";
import { discoverAll } from "../scrape/discover.ts";
import { render, contextFor, footer } from "../mail/render.ts";
import { enqueue, drain, recordFormSend, blockersFor, todayBudget } from "../mail/queue.ts";
import { authUrl, exchangeCode, isAuthorized } from "../mail/gmail.ts";

export const routes = new Hono();

/** One background job at a time. Keeps the Chamber from being hammered by
 *  two concurrent scrapes if the button is double-clicked. */
let running: string | null = null;
function start(label: string, job: () => Promise<unknown>) {
  if (running) return;
  running = label;
  job().catch((e) => console.error(`${label} failed:`, e))
       .finally(() => { running = null; });
}

const int = (v: unknown) => Number.parseInt(String(v ?? ""), 10);

/** Surfaces a thrown message back into the UI as a banner. */
const fail = (path: string, e: unknown) =>
  `${path}?err=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`;

// --- step 1: scrape ---------------------------------------------------------

routes.post("/scrape/chamber", (c) => {
  start("Scraping Chamber directory", () =>
    syncAll((p) => { running = `Scraping ${p.category}: ${p.done}/${p.total}`; }));
  return c.redirect("/");
});

routes.post("/scrape/emails", (c) => {
  start("Discovering email addresses", () =>
    discoverAll((p) => { running = `Finding emails: ${p.done}/${p.total} (${p.found} found)`; }));
  return c.redirect("/");
});

// --- review queue -----------------------------------------------------------

routes.get("/", (c) => {
  const filter = c.req.query("filter") ?? "all";
  const budget = todayBudget();
  return c.html(layout("Review queue",
    queuePage(repo.listCompanies(filter), filter, running, {
      authorized: isAuthorized(),
      dryRun: config.send.dryRun,
      cap: budget.cap,
      used: budget.used,
      queued: repo.stats().queued,
    }, c.req.query("err") ?? null),
    repo.stats()));
});

routes.get("/company/:id", (c) => {
  const id = int(c.req.param("id"));
  const company = repo.getCompany(id);
  if (!company) return c.notFound();

  const emails = repo.emailsFor(id);
  const template = company.template_id ? repo.getTemplate(company.template_id) : null;

  let preview: { subject: string; body: string } | null = null;
  if (template) {
    const ctx = contextFor(company);
    try {
      preview = {
        subject: render(template.subject, ctx),
        body: render(template.body, ctx) + footer(),
      };
    } catch (e) {
      preview = { subject: "(template error)", body: String(e) };
    }
  }

  const sent = db.query<{ status: string; sent_at: string | null }, [number]>(
    `SELECT status, sent_at FROM sends WHERE company_id=? AND status IN ('queued','sent')`,
  ).get(id);

  // One source of truth for the gates: the same function the queue enforces.
  const blockers = blockersFor(id);
  if (!config.canSpam.senderName || !config.canSpam.postalAddress || !config.canSpam.unsubscribeMailto)
    blockers.push("CAN-SPAM fields are missing from .env (sender name, postal address, unsubscribe).");

  return c.html(layout(company.name,
    companyPage(company, emails, repo.listTemplates(), preview, sent ?? null,
                blockers, c.req.query("err") ?? null),
    repo.stats()));
});

// --- steps 2-5: the per-company actions -------------------------------------

routes.post("/company/:id/review", async (c) => {
  const id = int(c.req.param("id"));
  const status = (await c.req.parseBody())["status"];
  if (status === "approved" || status === "rejected" || status === "new") repo.setReview(id, status);
  return c.redirect(`/company/${id}`);
});

routes.post("/company/:id/primary", async (c) => {
  const id = int(c.req.param("id"));
  repo.setPrimary(id, int((await c.req.parseBody())["email_id"]));
  return c.redirect(`/company/${id}`);
});

routes.post("/email/:id/verify", async (c) => {
  const body = await c.req.parseBody();
  repo.setVerified(int(c.req.param("id")), body["verified"] === "1");
  return c.redirect(`/company/${int(body["company_id"])}`);
});

routes.post("/company/:id/template", async (c) => {
  const id = int(c.req.param("id"));
  repo.setTemplate(id, int((await c.req.parseBody())["template_id"]));
  return c.redirect(`/company/${id}`);
});

routes.post("/company/:id/email", async (c) => {
  const id = int(c.req.param("id"));
  const address = String((await c.req.parseBody())["address"] ?? "");
  if (address.includes("@")) repo.addManualEmail(id, address);
  return c.redirect(`/company/${id}`);
});

routes.post("/company/:id/queue", (c) => {
  const id = int(c.req.param("id"));
  try { enqueue(id); } catch (e) { return c.redirect(fail(`/company/${id}`, e)); }
  return c.redirect(`/company/${id}`);
});

/** Records a contact made by hand through the company's own form, so form
 *  outreach falls under the same dedup guarantee as email. */
routes.post("/company/:id/form-sent", (c) => {
  const id = int(c.req.param("id"));
  try { recordFormSend(id); } catch (e) { return c.redirect(fail(`/company/${id}`, e)); }
  return c.redirect(`/company/${id}`);
});

// --- sending ----------------------------------------------------------------

routes.post("/send/drain", (c) => {
  try {
    start("Draining send queue", () =>
      drain((r) => {
        running = `Sending: ${r.sent}/${r.cap} today` +
                  (r.failed ? `, ${r.failed} failed` : "") +
                  (r.dryRun ? " (DRY RUN)" : "");
      }));
  } catch (e) { return c.redirect(fail("/", e)); }
  return c.redirect("/");
});

// --- templates --------------------------------------------------------------

routes.get("/templates", (c) => {
  const list = repo.listTemplates();
  return c.html(layout("Templates", `
${list.map((t) => `<div class="card">
  <form method="post" action="/templates/${t.id}">
    <div class="row"><b>${esc(t.name)}</b>
      <input type="text" name="subject" value="${esc(t.subject)}" style="flex:1;min-width:20rem"></div>
    <textarea name="body">${esc(t.body)}</textarea>
    <button class="primary">Save</button>
    <span class="mut">Fields: {{company}} {{city}} {{state}} {{website}} {{sender_name}} {{unsubscribe}}</span>
  </form></div>`).join("")}`, repo.stats()));
});

routes.post("/templates/:id", async (c) => {
  const b = await c.req.parseBody();
  db.query(`UPDATE templates SET subject=?, body=? WHERE id=?`)
    .run(String(b["subject"] ?? ""), String(b["body"] ?? ""), int(c.req.param("id")));
  return c.redirect("/templates");
});

// --- send log ---------------------------------------------------------------

routes.get("/log", (c) => {
  const rows = db.query<{ name: string; email_address: string; status: string;
    subject: string; queued_at: string; sent_at: string | null; error: string | null }, []>(`
    SELECT c.name, s.email_address, s.status, s.subject, s.queued_at, s.sent_at, s.error
    FROM sends s JOIN companies c ON c.id = s.company_id
    ORDER BY s.queued_at DESC`).all();
  return c.html(layout("Send log", rows.length ? `
<table><thead><tr><th>Company</th><th>To</th><th>Subject</th><th>Status</th><th>When</th></tr></thead><tbody>
${rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.email_address)}</td>
  <td>${esc(r.subject)}</td>
  <td class="${r.status === "sent" ? "ok" : r.status === "queued" ? "warn" : "bad"}">${esc(r.status)}
      ${r.error ? `<br><span class="mut">${esc(r.error)}</span>` : ""}</td>
  <td class="mut">${esc(r.sent_at ?? r.queued_at)}</td></tr>`).join("")}
</tbody></table>` : `<p class="mut">Nothing sent yet.</p>`, repo.stats()));
});

// --- Gmail OAuth bootstrap --------------------------------------------------

routes.get("/oauth/start", (c) => {
  try { return c.redirect(authUrl()); }
  catch (e) { return c.redirect(fail("/", e)); }
});

routes.get("/oauth/callback", async (c) => {
  const code = c.req.query("code");
  const denied = c.req.query("error");
  if (denied) return c.redirect(fail("/", new Error(`Google returned: ${denied}`)));
  if (!code) return c.redirect(fail("/", new Error("Google returned no authorization code.")));
  try { await exchangeCode(code); }
  catch (e) { return c.redirect(fail("/", e)); }
  return c.redirect("/");
});
