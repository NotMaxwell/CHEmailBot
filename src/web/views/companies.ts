import { esc } from "./layout.ts";
import { hostOf, normalizeWebsite } from "../../url.ts";
import type { CompanyRow } from "../../repo.ts";
import type { Company, EmailCandidate } from "../../types.ts";

const FILTERS = [
  ["all", "All"], ["new", "Unverified"], ["ready", "Ready to email"],
  ["form", "Needs form assist"], ["contacted", "Contacted"],
] as const;

function statusPill(c: CompanyRow): string {
  const via = c.send_channel === "form" ? " via form" : "";
  if (c.send_status === "sent")
    return `<span class="pill ok">sent${via} ${esc((c.sent_at ?? "").slice(0, 10))}</span>`;
  if (c.send_status === "queued") return `<span class="pill warn">queued</span>`;
  if (c.review_status === "rejected") return `<span class="pill bad">rejected</span>`;
  if (c.review_status === "approved") return `<span class="pill ok">verified</span>`;
  return `<span class="pill mut">new</span>`;
}

export interface SendPanel {
  authorized: boolean; dryRun: boolean; cap: number; used: number; queued: number;
  campaign: string;
}

const errBanner = (err: string | null) =>
  err ? `<div class="banner" style="border-left-color:var(--bad)"><b>Blocked:</b> ${esc(err)}</div>` : "";

/** Step 1 controls, the sending panel, and the queue table. */
export function queuePage(
  rows: CompanyRow[], filter: string, running: string | null,
  send: SendPanel, err: string | null,
): string {
  return `
${errBanner(err)}
<div class="card">
  <div class="row">
    <form method="post" action="/scrape/chamber" class="inline">
      <button class="primary" ${running ? "disabled" : ""}>1 · Start Chamber scrape</button>
    </form>
    <form method="post" action="/scrape/emails" class="inline">
      <button ${running ? "disabled" : ""}>Find emails for scraped companies</button>
    </form>
    ${running ? `<span class="warn">${esc(running)} — updating live</span>`
              : `<span class="mut">Scrapes run in the background; this page updates while they do.</span>`}
  </div>
</div>

<div class="card">
  <div class="row">
    <b>Sending</b>
    ${send.authorized
      ? '<span class="pill ok">Gmail connected</span>'
      : '<a href="/oauth/start"><span class="pill warn">connect Gmail →</span></a>'}
    ${send.dryRun
      ? '<span class="pill warn">DRY RUN — nothing transmits</span>'
      : '<span class="pill bad">LIVE — messages will actually send</span>'}
    <span class="mut">today ${send.used}/${send.cap} · ${send.queued} queued</span>
    <form method="post" action="/send/drain" class="inline">
      <button class="primary" ${running || !send.queued ? "disabled" : ""}>Drain queue</button>
    </form>
  </div>
</div>

<div class="row" style="margin:.5rem 0 1rem">
  ${FILTERS.map(([k, label]) =>
    k === filter ? `<b>${label}</b>` : `<a href="/?filter=${k}">${label}</a>`).join(" · ")}
  <span class="mut">${rows.length} companies · campaign
    <b>${esc(send.campaign)}</b></span>
</div>

<div class="scroll"><table><thead><tr>
  <th>Company</th><th>Address on file</th><th>Template</th><th>Status</th><th></th>
</tr></thead><tbody>
${rows.map((c) => `<tr>
  <td><a href="/company/${c.id}"><b>${esc(c.name)}</b></a><br>
      <span class="mut">${esc(c.city ?? "")}${hostOf(c.website) ? " · " + esc(hostOf(c.website)) : ""}</span>
      ${c.categories ? `<br><span class="mut" style="font-size:12px">${esc(c.categories)}</span>` : ""}</td>
  <td>${c.primary_address
        ? `${esc(c.primary_address)} ${c.primary_verified
             ? '<span class="pill ok">verified</span>'
             : '<span class="pill warn">unverified</span>'}`
        : `<span class="mut">${c.email_count ? c.email_count + " candidates" : "none found"}</span>`}</td>
  <td>${c.template_name ? esc(c.template_name) : '<span class="mut">—</span>'}</td>
  <td>${statusPill(c)}</td>
  <td><a href="/company/${c.id}">Review →</a></td>
</tr>`).join("")}
</tbody></table></div>
${rows.length ? "" : `<p class="mut">Nothing here yet. Run the Chamber scrape above.</p>`}`;
}

/** Steps 2–5 for a single company, plus the preview and the send gate. */
export function companyPage(
  c: Company,
  emails: EmailCandidate[],
  templates: { id: number; name: string }[],
  preview: { subject: string; body: string } | null,
  contacted: { status: string; sent_at: string | null } | null,
  blockers: string[],
  err: string | null = null,
  priorWarning: string | null = null,
  suppression: string | null = null,
): string {
  const primary = emails.find((e) => e.is_primary === 1);
  const site = normalizeWebsite(c.website);   // only ever link to http(s)
  return `
${errBanner(err)}
<p class="mut">${esc(c.street ?? "")} ${esc(c.city ?? "")} ${esc(c.state ?? "")} ${esc(c.postal_code ?? "")}
   ${c.phone ? " · " + esc(c.phone) : ""}
   ${site ? ` · <a href="${esc(site)}" target="_blank" rel="noopener noreferrer">${esc(site)}</a>` : ""}</p>

${suppression ? `<div class="banner" style="border-left-color:var(--bad)"><b>Do not contact:</b>
  ${esc(suppression)} <a href="/suppressions">Manage list</a></div>` : ""}

${priorWarning ? `<div class="banner"><b>Re-contact:</b> ${esc(priorWarning)}
  Allowed — dedup is scoped to the current campaign.</div>` : ""}
${contacted ? `<div class="banner"><b>Already ${esc(contacted.status)}</b>
  ${contacted.sent_at ? "on " + esc(contacted.sent_at) : ""} —
  this company is locked against a second send.</div>` : ""}

<div class="card">
  <h2>2 · Verify company</h2>
  <div class="row">
    <span class="pill ${c.review_status === "approved" ? "ok" : c.review_status === "rejected" ? "bad" : "mut"}">
      ${esc(c.review_status)}</span>
    <form method="post" action="/company/${c.id}/review" class="inline">
      <input type="hidden" name="status" value="approved"><button>Verify as a target</button></form>
    <form method="post" action="/company/${c.id}/review" class="inline">
      <input type="hidden" name="status" value="rejected"><button>Reject</button></form>
    ${suppression ? "" : `<form method="post" action="/company/${c.id}/suppress" class="inline"
        onsubmit="return confirm('Block this company from all future outreach?')">
      <input type="hidden" name="reason" value="Do-not-contact set from company page">
      <button title="Records an opt-out against this company's domain">Do not contact</button></form>`}
  </div>
</div>

<div class="card">
  <h2>3 &amp; 5 · Verify and select the address</h2>
  ${emails.length ? `<table><thead><tr><th>Use</th><th>Address</th><th>Source</th><th>Confidence</th><th>Verified</th></tr></thead><tbody>
  ${emails.map((e) => `<tr>
    <td><form method="post" action="/company/${c.id}/primary" class="inline">
      <input type="hidden" name="email_id" value="${e.id}">
      <button ${e.is_primary ? "disabled" : ""}>${e.is_primary ? "✓ in use" : "use this"}</button></form></td>
    <td>${esc(e.address)}</td><td class="mut">${esc(e.source)}</td>
    <td class="${e.confidence >= 1 ? "ok" : "warn"}">${e.confidence.toFixed(2)}</td>
    <td><form method="post" action="/email/${e.id}/verify" class="inline">
      <input type="hidden" name="verified" value="${e.verified ? 0 : 1}">
      <input type="hidden" name="company_id" value="${c.id}">
      <button>${e.verified ? "✓ verified" : "mark verified"}</button></form></td>
  </tr>`).join("")}</tbody></table>`
  : `<p class="mut">No addresses discovered. Add one manually, or use the form assist.</p>`}
  <form method="post" action="/company/${c.id}/email" class="row" style="margin-top:.75rem">
    <input type="email" name="address" placeholder="name@company.com" required>
    <button>Add manually (counts as verified)</button>
  </form>
</div>

<div class="card">
  <h2>4 · Select template</h2>
  <form method="post" action="/company/${c.id}/template" class="row">
    <select name="template_id">
      ${templates.map((t) =>
        `<option value="${t.id}" ${t.id === c.template_id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
    </select>
    <button>Use this template</button>
  </form>
</div>

${preview ? `<div class="card">
  <h2>Preview — exactly what will send</h2>
  <p><b>To:</b> ${esc(primary?.address ?? "")}<br><b>Subject:</b> ${esc(preview.subject)}</p>
  <pre style="white-space:pre-wrap;font:13px/1.5 ui-monospace,monospace">${esc(preview.body)}</pre>
</div>` : ""}

<div class="card">
  <h2>Send</h2>
  ${blockers.length
    ? `<ul class="mut">${blockers.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`
    : ""}
  <div class="row">
    <form method="post" action="/company/${c.id}/queue" class="inline">
      <button class="primary" ${blockers.length ? "disabled" : ""}>Queue this send</button>
    </form>
    ${!contacted ? `<form method="post" action="/company/${c.id}/form-sent" class="inline">
      <button title="For outreach you submitted by hand through their contact form">
        Mark contacted via their form</button></form>` : ""}
  </div>
  ${c.website && !primary ? `<p class="mut" style="margin-top:.6rem">
    No address found. Run <code>bun run form:assist ${c.id}</code> to open their contact
    form with this message pre-filled — it never submits for you.</p>` : ""}
</div>
<p><a href="/">← back to queue</a></p>`;
}
