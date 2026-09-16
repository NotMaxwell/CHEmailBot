// The setup tab: everything you decide BEFORE a run — which campaign new sends
// file under, and the copy they send. Both used to be scattered (campaigns on
// the history page, which is about the past; templates on their own tab with no
// link between them), so choosing them meant visiting two pages that never
// mentioned each other.
import { esc } from "./layout.ts";
import type { CampaignRow, TemplateRow } from "../../repo.ts";

const FIELDS = "{{company}} {{city}} {{state}} {{website}} {{sender_name}}";

const templateOptions = (list: TemplateRow[], selected: number | null) =>
  list.map((t) => `<option value="${t.id}" ${t.id === selected ? "selected" : ""}>${esc(t.name)}</option>`).join("");

export interface CampaignsView {
  campaigns: CampaignRow[];
  templates: TemplateRow[];
  current: string;
  /** Companies that would send with the campaign default rather than a choice
   *  of their own — the number that makes the default worth setting. */
  inheriting: number;
  withOwn: number;
  err: string | null;
  notice: string | null;
}

export function campaignsPage(v: CampaignsView): string {
  const cur = v.campaigns.find((c) => c.campaign === v.current);
  const defaultName = cur?.default_template_name ?? null;

  return `
${v.err ? `<div class="banner" style="border-left-color:var(--bad)"><b>Not saved:</b> ${esc(v.err)}</div>` : ""}
${v.notice ? `<div class="banner"><b>${esc(v.notice)}</b></div>` : ""}

<div class="card">
  <div class="row" style="justify-content:space-between">
    <div>
      <span class="mut" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Current campaign</span>
      <div style="font-size:1.35rem;font-weight:600">${esc(v.current)}</div>
    </div>
    <div class="row">
      <form method="post" action="/campaigns/switch" class="row" style="gap:.4rem">
        <select name="campaign" aria-label="Switch campaign">
          ${v.campaigns.map((c) => `<option value="${esc(c.campaign)}" ${
            c.campaign === v.current ? "selected" : ""}>${esc(c.campaign)}${
            c.n ? ` — ${c.n} contacted` : " — unused"}</option>`).join("")}
        </select>
        <button>Switch</button>
      </form>
      <form method="post" action="/campaigns/switch" class="row" style="gap:.4rem">
        <input type="text" name="new_campaign" placeholder="new campaign name" maxlength="60">
        <button class="primary">Create &amp; switch</button>
      </form>
    </div>
  </div>

  <hr style="border:0;border-top:1px solid var(--line);margin:1rem 0">

  <div class="row">
    <b>Default template</b>
    <form method="post" action="/campaigns/default-template" class="row" style="gap:.4rem">
      <input type="hidden" name="campaign" value="${esc(v.current)}">
      <select name="template_id" aria-label="Default template for this campaign">
        <option value="">— none: each company picks its own —</option>
        ${templateOptions(v.templates, cur?.default_template_id ?? null)}
      </select>
      <button>Set default</button>
    </form>
  </div>
  <p class="mut" style="margin:.6rem 0 0">
    ${defaultName
      ? `Any company without a template of its own sends with <b>${esc(defaultName)}</b>.
         <b>${v.inheriting}</b> ${v.inheriting === 1 ? "company is" : "companies are"} inheriting it now;
         <b>${v.withOwn}</b> ${v.withOwn === 1 ? "has" : "have"} an explicit choice.`
      : `No default set, so every company must be given a template individually on its own page
         (step 4). Setting one here is what makes a few hundred companies workable.`}
  </p>

  ${v.templates.length ? `<div class="row" style="margin-top:.75rem">
    <form method="post" action="/campaigns/apply-template" class="row" style="gap:.4rem">
      <select name="template_id" aria-label="Template to apply in bulk">
        ${templateOptions(v.templates, cur?.default_template_id ?? null)}
      </select>
      <button name="scope" value="missing">Apply to companies with none</button>
      <button name="scope" value="all"
        onclick="return confirm('Overwrite the template on EVERY company not yet contacted in this campaign?')">
        Apply to all</button>
    </form>
    <form method="post" action="/campaigns/clear-templates" class="inline"
          onsubmit="return confirm('Clear every company\\'s own template choice? They fall back to the campaign default.')">
      <button>Clear choices</button>
    </form>
  </div>
  <p class="mut" style="margin:.4rem 0 0">Bulk actions skip rejected companies and anything
    already queued or sent in this campaign — their copy is already frozen on the send row.</p>` : ""}
</div>

<h2>All campaigns</h2>
<div class="scroll"><table><thead><tr>
  <th>Campaign</th><th>Sent</th><th>Queued</th><th>Default template</th><th>Last activity</th><th></th>
</tr></thead><tbody>
${v.campaigns.map((c) => `<tr>
  <td>${c.campaign === v.current
        ? `<b>${esc(c.campaign)}</b> <span class="pill ok">current</span>`
        : esc(c.campaign)}<br>
      <span class="mut" style="font-size:12px">created ${esc((c.created_at ?? "").slice(0, 10))}</span></td>
  <td>${c.sent || `<span class="mut">—</span>`}</td>
  <td>${c.queued ? `<span class="warn">${c.queued}</span>` : `<span class="mut">—</span>`}</td>
  <td>${c.default_template_name
        ? esc(c.default_template_name)
        : `<span class="mut">none</span>`}</td>
  <td class="mut">${esc((c.last ?? "").slice(0, 16)) || "—"}</td>
  <td>${c.campaign === v.current ? "" : `
    <form method="post" action="/campaigns/switch" class="inline">
      <input type="hidden" name="campaign" value="${esc(c.campaign)}">
      <button>Switch to</button></form>
    ${c.n ? "" : `<form method="post" action="/campaigns/delete" class="inline"
        onsubmit="return confirm('Delete this unused campaign?')">
      <input type="hidden" name="campaign" value="${esc(c.campaign)}">
      <button title="Only campaigns with no sends can be deleted">×</button></form>`}`}</td>
</tr>`).join("")}
</tbody></table></div>
<p class="mut">Dedup is scoped to a campaign, so switching is what lets you deliberately
  re-message a company an earlier campaign already reached.
  <a href="/history">Past companies</a> shows who that was.</p>

<h2>Templates</h2>
<p class="mut">Merge fields: <code>${esc(FIELDS)}</code>. An unknown field is rejected when you
  save. The CAN-SPAM footer is appended to every message automatically — don't add one here.</p>

${v.templates.map((t) => `<div class="card">
  <form method="post" action="/templates/${t.id}">
    <div class="row">
      <input type="text" name="name" value="${esc(t.name)}" required aria-label="Template name" style="font-weight:600">
      <input type="text" name="subject" value="${esc(t.subject)}" required aria-label="Subject" style="flex:1;min-width:12rem">
    </div>
    <textarea name="body" required aria-label="Body">${esc(t.body)}</textarea>
    <div class="row">
      <button class="primary">Save</button>
      ${t.id === cur?.default_template_id
        ? `<span class="pill ok">default for ${esc(v.current)}</span>`
        : `<button form="setdef-${t.id}">Make default for ${esc(v.current)}</button>`}
      <span class="mut">${t.companies} ${t.companies === 1 ? "company" : "companies"} chose it
        · ${t.messages} message${t.messages === 1 ? "" : "s"} logged${
        t.default_for ? ` · default for ${esc(t.default_for)}` : ""}</span>
    </div>
  </form>
  <form method="post" action="/campaigns/default-template" id="setdef-${t.id}" class="inline">
    <input type="hidden" name="campaign" value="${esc(v.current)}">
    <input type="hidden" name="template_id" value="${t.id}">
  </form>
  <form method="post" action="/templates/${t.id}/delete" class="inline"
        onsubmit="return confirm('Delete this template?')" style="margin-top:.5rem">
    <button ${t.messages ? "disabled title='On a logged message — kept for the record'" : ""}>Delete</button>
  </form>
</div>`).join("")}

<div class="card">
  <h2>New template</h2>
  <form method="post" action="/templates">
    <div class="row">
      <input type="text" name="name" placeholder="Template name" required>
      <input type="text" name="subject" placeholder="Subject" required style="flex:1;min-width:12rem">
    </div>
    <textarea name="body" placeholder="Hi {{company}} team," required></textarea>
    <button class="primary">Create template</button>
  </form>
</div>`;
}
