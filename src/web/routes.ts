import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import { layout, esc } from "./views/layout.ts";
import { queuePage, companyPage } from "./views/companies.ts";
import { historyPage, tagSection } from "./views/history.ts";
import { templatesPage } from "./views/templates.ts";
import { suppressionsPage } from "./views/suppressions.ts";
import * as repo from "../repo.ts";
import { db, currentCampaign, switchCampaign, companySuppression } from "../db.ts";
import { config } from "../config.ts";
import { syncAll } from "../scrape/chamber.ts";
import { discoverAll } from "../scrape/discover.ts";
import { render, contextFor, footer } from "../mail/render.ts";
import { enqueue, drain, recordFormSend, blockersFor, peekBudget,
         priorContactWarning } from "../mail/queue.ts";
import { authUrl, exchangeCode, isAuthorized } from "../mail/gmail.ts";

export const routes = new Hono();

// Every state-changing action is a form POST to localhost. Without an origin
// check, ANY web page you visit could submit those forms -- start scrapes, mark
// companies contacted, or drain the send queue. Browsers attach Origin and
// Sec-Fetch-Site to form posts; csrf() rejects the ones that are not ours.
routes.use(csrf());
// Refuses cross-origin framing (a framed page could trick a click on "Drain
// queue") and sets nosniff / referrer-policy.
routes.use(secureHeaders());

routes.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.html(layout("Something went wrong",
    `<div class="banner" style="border-left-color:var(--bad)">${esc(err.message)}</div>
     <p><a href="/">Back to the review queue</a></p>`), 500);
});

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

/** Runs an action and redirects, turning any thrown error into a banner. */
async function act(back: string, fn: () => unknown | Promise<unknown>): Promise<string> {
  try { await fn(); return back; } catch (e) { return fail(back, e); }
}

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
  const err = c.req.query("err") ?? null;
  const budget = peekBudget();                    // read-only: viewing never spends the ramp
  const stats = repo.stats();
  return c.html(layout("Review queue",
    queuePage(repo.listCompanies(filter), filter, running, {
      authorized: isAuthorized(),
      dryRun: config.send.dryRun,
      cap: budget.cap,
      used: budget.used,
      queued: stats.queued,
      campaign: currentCampaign(),
    }, err),
    stats, { refresh: running !== null && !err }));
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
      preview = { subject: render(template.subject, ctx), body: render(template.body, ctx) + footer() };
    } catch (e) {
      preview = { subject: "(template error)", body: String(e) };
    }
  }

  // Scoped to the current campaign. Unscoped, a company reached in a PAST
  // campaign showed "locked against a second send" -- contradicting the
  // blockers below -- and hid the form-contact button.
  const sent = db.query<{ status: string; sent_at: string | null }, [number, string]>(
    `SELECT status, sent_at FROM sends
     WHERE company_id = ? AND campaign = ? AND status IN ('queued','sent')`,
  ).get(id, currentCampaign());

  // One source of truth for the gates: the same function the queue enforces.
  const blockers = blockersFor(id);
  if (!config.canSpam.senderName || !config.canSpam.postalAddress || !config.canSpam.unsubscribeMailto)
    blockers.push("CAN-SPAM fields are missing from .env (sender name, postal address, unsubscribe).");

  return c.html(layout(company.name,
    companyPage(company, emails, repo.listTemplates(), preview, sent ?? null, blockers,
                c.req.query("err") ?? null, priorContactWarning(id), companySuppression(id)) +
    tagSection(id, repo.tagsFor(id), repo.listTags()),
    repo.stats()));
});

// --- steps 2-5: the per-company actions -------------------------------------

routes.post("/company/:id/review", async (c) => {
  const id = int(c.req.param("id"));
  const status = (await c.req.parseBody())["status"];
  return c.redirect(await act(`/company/${id}`, () => {
    if (status !== "approved" && status !== "rejected" && status !== "new")
      throw new Error("Unknown review status.");
    repo.setReview(id, status);
  }));
});

routes.post("/company/:id/primary", async (c) => {
  const id = int(c.req.param("id"));
  const emailId = int((await c.req.parseBody())["email_id"]);
  return c.redirect(await act(`/company/${id}`, () => repo.setPrimary(id, emailId)));
});

routes.post("/email/:id/verify", async (c) => {
  const emailId = int(c.req.param("id"));
  // The owning company comes from the database, not from the form.
  const owner = db.query<{ company_id: number }, [number]>(
    `SELECT company_id FROM emails WHERE id = ?`).get(emailId);
  if (!owner) return c.notFound();
  repo.setVerified(emailId, (await c.req.parseBody())["verified"] === "1");
  return c.redirect(`/company/${owner.company_id}`);
});

routes.post("/company/:id/template", async (c) => {
  const id = int(c.req.param("id"));
  const templateId = int((await c.req.parseBody())["template_id"]);
  return c.redirect(await act(`/company/${id}`, () => {
    if (!repo.getTemplate(templateId)) throw new Error("That template no longer exists.");
    repo.setTemplate(id, templateId);
  }));
});

routes.post("/company/:id/email", async (c) => {
  const id = int(c.req.param("id"));
  const address = String((await c.req.parseBody())["address"] ?? "");
  return c.redirect(await act(`/company/${id}`, () => repo.addManualEmail(id, address)));
});

routes.post("/company/:id/queue", async (c) => {
  const id = int(c.req.param("id"));
  return c.redirect(await act(`/company/${id}`, () => enqueue(id)));
});

/** Records a contact made by hand through the company's own form, so form
 *  outreach falls under the same dedup guarantee as email. */
routes.post("/company/:id/form-sent", async (c) => {
  const id = int(c.req.param("id"));
  return c.redirect(await act(`/company/${id}`, () => recordFormSend(id)));
});

routes.post("/company/:id/suppress", async (c) => {
  const id = int(c.req.param("id"));
  const reason = String((await c.req.parseBody())["reason"] ?? "");
  return c.redirect(await act(`/company/${id}`, () => repo.suppressCompany(id, reason)));
});

// --- sending ----------------------------------------------------------------

routes.post("/send/drain", async (c) => {
  return c.redirect(await act("/", () =>
    start("Draining send queue", () =>
      drain((r) => {
        running = `Sending: ${r.sent}/${r.cap} today` +
                  (r.failed ? `, ${r.failed} failed` : "") +
                  (r.dryRun ? " (DRY RUN)" : "");
      }))));
});

// --- history & tags ---------------------------------------------------------

routes.get("/history", (c) => {
  const tag = c.req.query("tag") ? int(c.req.query("tag")) : null;
  const campaign = c.req.query("campaign") ?? null;
  return c.html(layout("Past companies",
    historyPage(
      repo.listHistory(tag || undefined, campaign ?? undefined),
      repo.listTags(), repo.listCampaigns(), currentCampaign(),
      tag, campaign, c.req.query("err") ?? null),
    repo.stats()));
});

routes.post("/history/campaign", async (c) => {
  const b = await c.req.parseBody();
  // Two submit paths land here: the picker, and the create-new field.
  const name = String(b["new_campaign"] ?? "").trim() || String(b["campaign"] ?? "");
  return c.redirect(await act("/history", () => switchCampaign(name)));
});

routes.post("/company/:id/tag", async (c) => {
  const id = int(c.req.param("id"));
  const b = await c.req.parseBody();
  const back = b["back"] === "history" ? "/history" : `/company/${id}`;
  return c.redirect(await act(back, () =>
    repo.addTag(id, String(b["name"] ?? ""),
                b["kind"] === "reminder" ? "reminder" : "label",
                String(b["note"] ?? ""))));
});

routes.post("/company/:id/tag/:tagId/remove", (c) => {
  const id = int(c.req.param("id"));
  repo.removeTag(id, int(c.req.param("tagId")));
  return c.redirect(`/company/${id}`);
});

routes.post("/company/:id/tag/:tagId/done", async (c) => {
  const id = int(c.req.param("id"));
  repo.setTagDone(id, int(c.req.param("tagId")), (await c.req.parseBody())["done"] === "1");
  return c.redirect(`/company/${id}`);
});

// --- templates --------------------------------------------------------------

routes.get("/templates", (c) =>
  c.html(layout("Templates", templatesPage(repo.listTemplates(), c.req.query("err") ?? null),
    repo.stats())));

routes.post("/templates", async (c) => {
  const b = await c.req.parseBody();
  return c.redirect(await act("/templates", () =>
    repo.createTemplate(String(b["name"] ?? ""), String(b["subject"] ?? ""), String(b["body"] ?? ""))));
});

routes.post("/templates/:id", async (c) => {
  const b = await c.req.parseBody();
  return c.redirect(await act("/templates", () =>
    repo.updateTemplate(int(c.req.param("id")),
      String(b["name"] ?? ""), String(b["subject"] ?? ""), String(b["body"] ?? ""))));
});

routes.post("/templates/:id/delete", async (c) =>
  c.redirect(await act("/templates", () => repo.deleteTemplate(int(c.req.param("id"))))));

// --- do not contact ---------------------------------------------------------

routes.get("/suppressions", (c) =>
  c.html(layout("Do not contact",
    suppressionsPage(repo.listSuppressions(), c.req.query("err") ?? null), repo.stats())));

routes.post("/suppressions", async (c) => {
  const b = await c.req.parseBody();
  return c.redirect(await act("/suppressions", () =>
    repo.addSuppression(String(b["value"] ?? ""), String(b["reason"] ?? ""))));
});

routes.post("/suppressions/:id/delete", (c) => {
  repo.removeSuppression(int(c.req.param("id")));
  return c.redirect("/suppressions");
});

// --- send log ---------------------------------------------------------------

routes.get("/log", (c) => {
  const rows = db.query<{ name: string; email_address: string; status: string; campaign: string;
    subject: string; queued_at: string; sent_at: string | null; error: string | null }, []>(`
    SELECT c.name, s.email_address, s.status, s.campaign, s.subject, s.queued_at, s.sent_at, s.error
    FROM sends s JOIN companies c ON c.id = s.company_id
    ORDER BY s.queued_at DESC`).all();
  return c.html(layout("Send log", rows.length ? `
<div class="scroll"><table><thead><tr>
  <th>Company</th><th>To</th><th>Subject</th><th>Campaign</th><th>Status</th><th>When</th>
</tr></thead><tbody>
${rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.email_address)}</td>
  <td>${esc(r.subject)}</td><td class="mut">${esc(r.campaign)}</td>
  <td class="${r.status === "sent" ? "ok" : r.status === "queued" ? "warn" : "bad"}">${esc(r.status)}
      ${r.error ? `<br><span class="mut">${esc(r.error)}</span>` : ""}</td>
  <td class="mut">${esc(r.sent_at ?? r.queued_at)}</td></tr>`).join("")}
</tbody></table></div>` : `<p class="mut">Nothing sent yet.</p>`, repo.stats()));
});

// --- Gmail OAuth bootstrap --------------------------------------------------

/** Single-use value echoed back by Google. Without it, a crafted callback link
 *  could connect SOMEONE ELSE's Gmail account, and your outreach would leave
 *  from their mailbox. */
let oauthState: string | null = null;

routes.get("/oauth/start", (c) => {
  oauthState = crypto.randomUUID();
  try { return c.redirect(authUrl(oauthState)); }
  catch (e) { return c.redirect(fail("/", e)); }
});

routes.get("/oauth/callback", async (c) => {
  const expected = oauthState;
  oauthState = null;
  if (!expected || c.req.query("state") !== expected) {
    return c.redirect(fail("/", new Error("Gmail connection could not be verified. Start again from “connect Gmail”.")));
  }
  const denied = c.req.query("error");
  if (denied) return c.redirect(fail("/", new Error(`Google returned: ${denied}`)));
  const code = c.req.query("code");
  if (!code) return c.redirect(fail("/", new Error("Google returned no authorization code.")));
  return c.redirect(await act("/", () => exchangeCode(code)));
});
