import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import { layout, esc } from "./views/layout.ts";
import { queuePage, companyPage } from "./views/companies.ts";
import { historyPage, tagSection } from "./views/history.ts";
import { campaignsPage } from "./views/campaigns.ts";
import { suppressionsPage } from "./views/suppressions.ts";
import { loginPage, bootstrapPage, signupPage, signupRequestedPage, requestsPage,
         accountsPage } from "./views/accounts.ts";
import * as auth from "../auth.ts";
import type { Student } from "../auth.ts";
import * as repo from "../repo.ts";
import { db, currentCampaign, switchCampaign, companySuppression,
         setCampaignDefaultTemplate } from "../db.ts";
import { config } from "../config.ts";
import { syncAll } from "../scrape/chamber.ts";
import { discoverAll, etaSeconds, type DiscoverProgress } from "../scrape/discover.ts";
import { render, contextFor, footer, senderNameFor, displayNameFor } from "../mail/render.ts";
import { enqueue, drain, recordFormSend, blockersFor, peekBudget,
         priorContactWarning, cancelQueued } from "../mail/queue.ts";
import { authUrl, exchangeCode, isAuthorized } from "../mail/gmail.ts";

export const routes = new Hono<{ Variables: { student: Student } }>();

// Every state-changing action is a form POST. Without an origin check, ANY web
// page you visit could submit those forms -- start scrapes, mark companies
// contacted, or drain the send queue. Browsers attach Origin and Sec-Fetch-Site
// to form posts; csrf() rejects the ones that are not ours.
//
// The origins are compared by HOST rather than in full, because behind a
// TLS-terminating proxy (Render, or a reverse proxy at home) the browser sends
// "Origin: https://host" while the request arriving here is plain http on the
// inside -- and the default whole-origin comparison rejects every form POST on
// the browsers that do not send Sec-Fetch-Site. The host still has to match,
// which is the part that actually distinguishes our pages from someone else's.
routes.use(csrf({
  origin: (origin, c) => {
    try { return new URL(origin).host === new URL(c.req.url).host; }
    catch { return false; }          // not a URL at all
  },
}));
// Refuses cross-origin framing (a framed page could trick a click on "Drain
// queue") and sets nosniff / referrer-policy.
routes.use(secureHeaders());

/** The only paths reachable without an account: the two that hand one out. */
const OPEN_PATHS = new Set(["/login", "/signup"]);

/**
 * Everything except sign-in and sign-up requires an account.
 *
 * This sits AFTER csrf() and secureHeaders() so an unauthenticated request is
 * still origin-checked, and before every route, so adding a route cannot
 * accidentally leave it open.
 */
routes.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (OPEN_PATHS.has(path)) return next();

  const student = auth.studentForToken(getCookie(c, auth.SESSION_COOKIE));
  if (!student) {
    // Preserve where they were headed, but only as a local path -- echoing an
    // arbitrary ?next= back into a redirect is an open redirect.
    const next = path.startsWith("/") && !path.startsWith("//") ? path : "/";
    return c.redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  c.set("student", student);
  await next();
});

/**
 * What the header needs about the signed-in person. The pending count is only
 * looked up for admins -- nobody else can act on it, and it would be a query
 * on every page render for nothing.
 */
const nav = (c: Context<{ Variables: { student: Student } }>) => {
  const student = c.get("student");
  return student.role === "admin"
    ? { ...student, pending: auth.pendingCount() }
    : student;
};

/** Routes that change accounts are admin-only. */
const requireAdmin = (c: { get: (k: "student") => Student }): void => {
  if (c.get("student").role !== "admin") throw new Error("Only an admin can do that.");
};

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

/**
 * How the last background job ended. A job used to report failure ONLY to the
 * server console: the page simply stopped updating, which is indistinguishable
 * from a job still working, and left no way to tell a crash from a finish.
 */
let lastJob: { label: string; ok: boolean; detail: string } | null = null;

function start(label: string, job: () => Promise<unknown>) {
  if (running) return;
  running = label;
  lastJob = null;
  job()
    .then((result) => { lastJob = { label, ok: true, detail: summarize(result) }; })
    .catch((e) => {
      lastJob = { label, ok: false, detail: e instanceof Error ? e.message : String(e) };
      console.error(`${label} failed:`, e);
    })
    .finally(() => { running = null; });
}

/** One line describing whatever a finished job returned. */
function summarize(result: unknown): string {
  const r = result as Partial<DiscoverProgress> | undefined;
  if (r && typeof r.done === "number" && typeof r.total === "number") {
    const failed = r.failures?.length ?? 0;
    return `${r.done} of ${r.total} crawled, ${r.found ?? 0} addresses found` +
           (failed ? `, ${failed} site${failed === 1 ? "" : "s"} failed: ` +
                     r.failures!.slice(0, 5).map((f) => f.name).join(", ") +
                     (failed > 5 ? ` and ${failed - 5} more` : "")
                   : ".");
  }
  return "Finished.";
}

const int = (v: unknown) => Number.parseInt(String(v ?? ""), 10);

/** Surfaces a thrown message back into the UI as a banner. The separator is
 *  chosen, not assumed: some back paths already carry a query of their own. */
const fail = (path: string, e: unknown) =>
  `${path}${path.includes("?") ? "&" : "?"}err=` +
  encodeURIComponent(e instanceof Error ? e.message : String(e));

/** Like act(), but the action names what it did, so the page can say so. */
function actSync(back: string, fn: () => string): string {
  try {
    const ok = fn();
    return `${back}${back.includes("?") ? "&" : "?"}ok=${encodeURIComponent(ok)}`;
  } catch (e) { return fail(back, e); }
}

/** Runs an action and redirects, turning any thrown error into a banner. */
async function act(back: string, fn: () => unknown | Promise<unknown>): Promise<string> {
  try { await fn(); return back; } catch (e) { return fail(back, e); }
}

// --- accounts ---------------------------------------------------------------

/** True when the BROWSER reached us over TLS, even if the proxy in front of us
 *  then spoke plain http to this process. */
const overHttps = (c: Context): boolean =>
  (c.req.header("x-forwarded-proto") ?? "").split(",")[0]!.trim() === "https" ||
  new URL(c.req.url).protocol === "https:";

/** Opens the session cookie for a token. One definition, so a signed-up
 *  session is scoped exactly like a signed-in one. */
const openSession = (c: Context, token: string): void =>
  setCookie(c, auth.SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "Lax", path: "/", maxAge: auth.SESSION_MAX_AGE,
    // Conditional, not always on: a Secure cookie is DROPPED over plain http,
    // so hard-coding it would make sign-in impossible on a LAN address or on
    // localhost -- while leaving it off over TLS would leak the session to a
    // single downgraded request.
    secure: overHttps(c),
  });

/**
 * Refuses the wrong shared code, when one is configured.
 *
 * Guards both doors that hand out an account -- /signup and the bootstrap form
 * -- because on a publicly reachable deploy the bootstrap window (no accounts
 * yet) is exactly when a stranger would get the admin one.
 */
function assertSignupCode(value: string): void {
  if (!config.signupCode) return;                       // open sign-up
  if (value.trim() !== config.signupCode) {
    throw new Error("That sign-up code is not right. Ask whoever runs this for it.");
  }
}

/** Whether the account forms must ask for the shared code. */
const codeRequired = (): boolean => config.signupCode !== "";

routes.get("/login", (c) => {
  if (auth.studentForToken(getCookie(c, auth.SESSION_COOKIE))) return c.redirect("/");
  const err = c.req.query("err") ?? null;
  return c.html(auth.needsBootstrap()
    ? bootstrapPage(err, codeRequired())
    : loginPage(err, c.req.query("next") ?? null));
});

routes.post("/login", async (c) => {
  const b = await c.req.parseBody();
  const username = String(b["username"] ?? "");
  const password = String(b["password"] ?? "");

  try {
    if (b["bootstrap"] === "1") {
      assertSignupCode(String(b["code"] ?? ""));
      await auth.bootstrapAdmin(String(b["name"] ?? ""), username, password);
    }
  } catch (e) { return c.redirect(fail("/login", e)); }

  const session = await auth.login(username, password);
  if (!session.ok) {
    // The message is chosen in auth.ts: vague for a bad credential, specific
    // for a waiting or deactivated account -- which only its owner can reach.
    return c.redirect(fail("/login", new Error(auth.loginMessage(session.reason))));
  }
  openSession(c, session.token);
  const next = String(b["next"] ?? "/");
  return c.redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
});

// --- sign-up ----------------------------------------------------------------

routes.get("/signup", (c) => {
  if (auth.studentForToken(getCookie(c, auth.SESSION_COOKIE))) return c.redirect("/");
  const requested = c.req.query("requested");
  if (requested) return c.html(signupRequestedPage(requested));
  // With an empty table this form would hand out admin without saying so. The
  // bootstrap page on /login is the one that explains that, so defer to it.
  if (auth.needsBootstrap()) return c.redirect("/login");
  return c.html(signupPage(c.req.query("err") ?? null, {
    name: c.req.query("name") ?? "",
    username: c.req.query("username") ?? "",
  }, codeRequired()));
});

/** Files a request. It deliberately does NOT sign them in: there is nothing to
 *  sign in to until an admin accepts it. */
routes.post("/signup", async (c) => {
  const b = await c.req.parseBody();
  const name = String(b["name"] ?? "");
  const username = String(b["username"] ?? "");
  const password = String(b["password"] ?? "");

  try {
    assertSignupCode(String(b["code"] ?? ""));
    await auth.signUp(name, username, password);
  } catch (e) {
    // Hand back what they typed so only the password has to be retyped.
    return c.redirect("/signup?" + new URLSearchParams({
      err: e instanceof Error ? e.message : String(e), name, username,
    }));
  }

  // The very first account is the exception -- it is created outright as the
  // admin, because there is nobody to approve it -- so sign that one in.
  const session = await auth.login(username, password);
  if (session.ok) {
    openSession(c, session.token);
    return c.redirect("/");
  }
  return c.redirect(`/signup?requested=${encodeURIComponent(name)}`);
});

routes.post("/logout", (c) => {
  auth.logout(getCookie(c, auth.SESSION_COOKIE));
  deleteCookie(c, auth.SESSION_COOKIE, { path: "/" });
  return c.redirect("/login");
});

routes.get("/accounts", (c) =>
  c.html(layout("Accounts",
    accountsPage(auth.listStudents(), c.get("student"),
                 c.req.query("err") ?? null, c.req.query("ok") ?? null,
                 auth.pendingCount()),
    repo.stats(), { student: nav(c) })));

routes.post("/accounts", async (c) => {
  const b = await c.req.parseBody();
  return c.redirect(await act("/accounts", async () => {
    requireAdmin(c);
    await auth.createStudent(String(b["name"] ?? ""), String(b["username"] ?? ""),
                             String(b["password"] ?? ""),
                             b["role"] === "admin" ? "admin" : "student",
                             c.get("student").id);
  }));
});

// --- sign-up requests -------------------------------------------------------

/** The admin's approval page. Everything it shows is the decision itself: who
 *  asked, and what a sponsor will see on the mail they send. */
routes.get("/requests", (c) => {
  // A redirect rather than requireAdmin's throw: a student following a stale
  // link has done nothing wrong, and a 500 page in the error log is not the
  // way to say "not for you".
  if (c.get("student").role !== "admin") {
    return c.redirect(fail("/accounts", new Error("Only an admin can review sign-ups.")));
  }
  const rows = auth.pendingRequests().map((student) => ({
    student,
    // Rendered the same way a real send renders it, so "Approve" is not a
    // guess about what the From line will say.
    signature: displayNameFor({ sender_name: null }, student.name),
  }));
  return c.html(layout("Sign-ups waiting",
    requestsPage(rows, c.req.query("err") ?? null, c.req.query("ok") ?? null),
    repo.stats(), { student: nav(c) }));
});

routes.post("/requests/:id/approve", (c) => {
  const id = int(c.req.param("id"));
  return c.redirect(actSync("/requests", () => {
    requireAdmin(c);
    const who = auth.getStudent(id);
    auth.approveStudent(id, c.get("student").id);
    return `${who?.name ?? "That account"} can sign in now.`;
  }));
});

routes.post("/requests/:id/decline", (c) => {
  const id = int(c.req.param("id"));
  return c.redirect(actSync("/requests", () => {
    requireAdmin(c);
    const who = auth.getStudent(id);
    auth.declineStudent(id);
    return `Declined ${who?.name ?? "that request"}. The username is free again.`;
  }));
});

/** Changing your own password needs no admin right; changing anyone else's does. */
routes.post("/accounts/password", async (c) => {
  const b = await c.req.parseBody();
  const me = c.get("student");
  const path = await act("/accounts", () => auth.setPassword(me.id, String(b["password"] ?? "")));
  if (path === "/accounts") {
    deleteCookie(c, auth.SESSION_COOKIE, { path: "/" });   // own sessions were dropped
    return c.redirect("/login?err=" + encodeURIComponent("Password changed. Sign in again."));
  }
  return c.redirect(path);
});

routes.post("/accounts/:id/password", async (c) => {
  const b = await c.req.parseBody();
  return c.redirect(await act("/accounts", async () => {
    requireAdmin(c);
    await auth.setPassword(int(c.req.param("id")), String(b["password"] ?? ""));
  }));
});

routes.post("/accounts/:id/active", async (c) => {
  const b = await c.req.parseBody();
  return c.redirect(await act("/accounts", () => {
    requireAdmin(c);
    auth.setActive(int(c.req.param("id")), b["active"] === "1");
  }));
});

routes.post("/accounts/:id/role", async (c) => {
  const b = await c.req.parseBody();
  return c.redirect(await act("/accounts", () => {
    requireAdmin(c);
    auth.setRole(int(c.req.param("id")), b["role"] === "admin" ? "admin" : "student");
  }));
});

// --- step 1: scrape ---------------------------------------------------------

routes.post("/scrape/chamber", (c) => {
  start("Scraping Chamber directory", () =>
    syncAll((p) => { running = `Scraping ${p.category}: ${p.done}/${p.total}`; }));
  return c.redirect("/");
});

routes.post("/scrape/emails", (c) => {
  start("Discovering email addresses", () =>
    discoverAll((p) => {
      const eta = etaSeconds(p);
      running = `Finding emails: ${p.done}/${p.total} (${p.found} found` +
        `${p.failures.length ? `, ${p.failures.length} failed` : ""})` +
        `${eta !== null ? ` — about ${Math.ceil(eta / 60)} min left` : ""}`;
    }));
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
    }, err, lastJob),
    stats, { refresh: running !== null && !err, student: nav(c) }));
});

routes.get("/company/:id", (c) => {
  const id = int(c.req.param("id"));
  const company = repo.getCompany(id);
  if (!company) return c.notFound();

  const emails = repo.emailsFor(id);
  // The company's own choice if it made one, otherwise the campaign default --
  // the preview must show what would ACTUALLY send, not just an explicit pick.
  const me = c.get("student");
  const resolved = repo.resolveTemplateFor(company);

  let preview: { subject: string; body: string } | null = null;
  if (resolved) {
    const ctx = contextFor(company, me.name);
    try {
      preview = {
        subject: render(resolved.template.subject, ctx),
        body: render(resolved.template.body, ctx) + footer(),
      };
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
  if (!config.canSpam.senderName || !config.canSpam.postalAddress)
    blockers.push("Sender identity is missing from .env (sender name, postal address).");

  return c.html(layout(company.name,
    companyPage(company, emails, repo.listTemplates(), preview, sent ?? null, blockers,
                c.req.query("err") ?? null, priorContactWarning(id), companySuppression(id),
                { defaultSenderName: senderNameFor(company, me.name),
                  defaultSenderSource: me.name.trim() ? "account" : "env",
                  campaign: currentCampaign(),
                  resolvedTemplate: resolved && {
                    name: resolved.template.name, source: resolved.source } }) +
    tagSection(id, repo.tagsFor(id), repo.listTags()),
    repo.stats(), { student: nav(c) }));
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

routes.post("/company/:id/sender", async (c) => {
  const id = int(c.req.param("id"));
  const b = await c.req.parseBody();
  return c.redirect(await act(`/company/${id}`, () =>
    repo.setSenderName(id, String(b["sender_name"] ?? ""))));
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
  const me = c.get("student");
  return c.redirect(await act(`/company/${id}`, () => enqueue(id, { id: me.id, name: me.name })));
});

/** Undoes the above while the message is still waiting to go out. */
routes.post("/company/:id/cancel", async (c) => {
  const id = int(c.req.param("id"));
  return c.redirect(await act(`/company/${id}`, () => cancelQueued(id)));
});

/** Removes the company from the review queue for good. The filter comes back
 *  with it so the list does not jump to "All" under the person deleting. */
routes.post("/company/:id/delete", async (c) => {
  const id = int(c.req.param("id"));
  const filter = String((await c.req.parseBody())["filter"] ?? "all");
  return c.redirect(await act(`/?filter=${encodeURIComponent(filter)}`,
    () => repo.deleteCompany(id)));
});

/** Records a contact made by hand through the company's own form, so form
 *  outreach falls under the same dedup guarantee as email. */
routes.post("/company/:id/form-sent", async (c) => {
  const id = int(c.req.param("id"));
  const me = c.get("student");
  return c.redirect(await act(`/company/${id}`, () => recordFormSend(id, { id: me.id, name: me.name })));
});

routes.post("/company/:id/suppress", async (c) => {
  const id = int(c.req.param("id"));
  const reason = String((await c.req.parseBody())["reason"] ?? "");
  return c.redirect(await act(`/company/${id}`, () => repo.suppressCompany(id, reason)));
});

// --- sending ----------------------------------------------------------------

routes.post("/send/drain", async (c) => {
  return c.redirect(await act("/", () =>
    start("Sending", () =>
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
    repo.stats(), { student: nav(c) }));
});

// Superseded by /campaigns/switch. Kept so a stale open tab's form still works.
routes.post("/history/campaign", async (c) => {
  const b = await c.req.parseBody();
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

// --- campaigns & templates --------------------------------------------------

routes.get("/campaigns", (c) => {
  const current = currentCampaign();
  const defaultId = repo.campaignDefaultTemplate(current);
  const counts = repo.templateAssignmentCounts();
  return c.html(layout("Campaigns & templates", campaignsPage({
    campaigns: repo.listCampaigns(),
    templates: repo.listTemplatesWithUsage(),
    current,
    // Only meaningful when a default exists: with none, nobody inherits.
    inheriting: defaultId ? counts.without : 0,
    withOwn: counts.with,
    footerPreview: footer().replace(/^\n+---\n/, ""),
    err: c.req.query("err") ?? null,
    notice: c.req.query("ok") ?? null,
  }), repo.stats(), { student: nav(c) }));
});

routes.post("/campaigns/switch", async (c) => {
  const b = await c.req.parseBody();
  // Two submit paths land here: the picker, and the create-new field.
  const name = String(b["new_campaign"] ?? "").trim() || String(b["campaign"] ?? "");
  return c.redirect(await act("/campaigns", () => switchCampaign(name)));
});

routes.post("/campaigns/default-template", async (c) => {
  const b = await c.req.parseBody();
  const raw = String(b["template_id"] ?? "").trim();
  return c.redirect(await act("/campaigns", () =>
    setCampaignDefaultTemplate(String(b["campaign"] ?? currentCampaign()),
                               raw === "" ? null : int(raw))));
});

routes.post("/campaigns/apply-template", async (c) => {
  const b = await c.req.parseBody();
  const scope = b["scope"] === "all" ? "all" : "missing";
  try {
    const n = repo.applyTemplateToCompanies(int(b["template_id"]), scope);
    return c.redirect(`/campaigns?ok=${encodeURIComponent(
      `Template applied to ${n} ${n === 1 ? "company" : "companies"}.`)}`);
  } catch (e) { return c.redirect(fail("/campaigns", e)); }
});

routes.post("/campaigns/clear-templates", async (c) => {
  try {
    const n = repo.clearCompanyTemplates();
    return c.redirect(`/campaigns?ok=${encodeURIComponent(
      `Cleared ${n} ${n === 1 ? "choice" : "choices"}; they now follow the campaign default.`)}`);
  } catch (e) { return c.redirect(fail("/campaigns", e)); }
});

routes.post("/campaigns/delete", async (c) => {
  const b = await c.req.parseBody();
  return c.redirect(await act("/campaigns", () => repo.deleteCampaign(String(b["campaign"] ?? ""))));
});

// --- templates --------------------------------------------------------------

// Templates moved into the campaign tab -- they are two halves of one setup
// decision. Kept as a redirect so old bookmarks still land somewhere useful.
routes.get("/templates", (c) => c.redirect("/campaigns"));

routes.post("/templates", async (c) => {
  const b = await c.req.parseBody();
  return c.redirect(await act("/campaigns", () =>
    repo.createTemplate(String(b["name"] ?? ""), String(b["subject"] ?? ""),
                        String(b["body"] ?? ""))));
});

routes.post("/templates/:id", async (c) => {
  const b = await c.req.parseBody();
  return c.redirect(await act("/campaigns", () =>
    repo.updateTemplate(int(c.req.param("id")),
      String(b["name"] ?? ""), String(b["subject"] ?? ""), String(b["body"] ?? ""))));
});

routes.post("/templates/:id/delete", async (c) =>
  c.redirect(await act("/campaigns", () => repo.deleteTemplate(int(c.req.param("id"))))));

// --- do not contact ---------------------------------------------------------

routes.get("/suppressions", (c) =>
  c.html(layout("Do not contact",
    suppressionsPage(repo.listSuppressions(), c.req.query("err") ?? null), repo.stats(), { student: nav(c) })));

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
</tbody></table></div>` : `<p class="mut">Nothing sent yet.</p>`, repo.stats(), { student: nav(c) }));
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
