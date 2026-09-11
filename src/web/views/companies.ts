import { esc } from "./layout.ts";
import type { CompanyRow } from "../../repo.ts";
import type { Company, EmailCandidate } from "../../types.ts";

const FILTERS = [
  ["all", "All"], ["new", "Unverified"], ["ready", "Ready to send"], ["contacted", "Contacted"],
] as const;

function statusPill(c: CompanyRow): string {
  if (c.send_status === "sent")   return `<span class="pill ok">sent ${esc((c.sent_at ?? "").slice(0, 10))}</span>`;
  if (c.send_status === "queued") return `<span class="pill warn">queued</span>`;
  if (c.review_status === "rejected") return `<span class="pill bad">rejected</span>`;
  if (c.review_status === "approved") return `<span class="pill ok">verified</span>`;
  return `<span class="pill mut">new</span>`;
}

/** Step 1 controls + the queue table. */
export function queuePage(rows: CompanyRow[], filter: string, running: string | null): string {
  return `
<div class="card">
  <div class="row">
    <form method="post" action="/scrape/chamber" class="inline">
      <button class="primary" ${running ? "disabled" : ""}>1 · Start Chamber scrape</button>
    </form>
    <form method="post" action="/scrape/emails" class="inline">
      <button ${running ? "disabled" : ""}>Find emails for scraped companies</button>
    </form>
    ${running ? `<span class="warn">${esc(running)} — reload to refresh</span>`
              : `<span class="mut">Scrapes run in the background; reload to see progress.</span>`}
  </div>
</div>

<div class="row" style="margin:.5rem 0 1rem">
  ${FILTERS.map(([k, label]) =>
    k === filter ? `<b>${label}</b>` : `<a href="/?filter=${k}">${label}</a>`).join(" · ")}
  <span class="mut">${rows.length} companies</span>
</div>

<table><thead><tr>
  <th>Company</th><th>Address on file</th><th>Template</th><th>Status</th><th></th>
</tr></thead><tbody>
${rows.map((c) => `<tr>
  <td><a href="/company/${c.id}"><b>${esc(c.name)}</b></a><br>
      <span class="mut">${esc(c.city ?? "")}${c.website ? " · " + esc(new URL(c.website).hostname) : ""}</span></td>
  <td>${c.primary_address
        ? `${esc(c.primary_address)} ${c.primary_verified
             ? '<span class="pill ok">verified</span>'
             : '<span class="pill warn">unverified</span>'}`
        : `<span class="mut">${c.email_count ? c.email_count + " candidates" : "none found"}</span>`}</td>
  <td>${c.template_name ? esc(c.template_name) : '<span class="mut">—</span>'}</td>
  <td>${statusPill(c)}</td>
  <td><a href="/company/${c.id}">Review →</a></td>
</tr>`).join("")}
</tbody></table>
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
): string {
  const primary = emails.find((e) => e.is_primary === 1);
  return `
<p class="mut">${esc(c.street ?? "")} ${esc(c.city ?? "")} ${esc(c.state ?? "")} ${esc(c.postal_code ?? "")}
   ${c.phone ? " · " + esc(c.phone) : ""}
   ${c.website ? ` · <a href="${esc(c.website)}" target="_blank" rel="noopener">${esc(c.website)}</a>` : ""}</p>

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
  <form method="post" action="/company/${c.id}/queue">
    <button class="primary" ${blockers.length ? "disabled" : ""}>Queue this send</button>
  </form>
</div>
<p><a href="/">← back to queue</a></p>`;
}
