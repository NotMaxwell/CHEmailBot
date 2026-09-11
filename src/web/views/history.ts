import { esc } from "./layout.ts";
import { unpackTags, type HistoryRow, type Tag, type CompanyTag } from "../../repo.ts";

const tagChip = (t: CompanyTag) => {
  const cls = t.kind === "reminder" ? (t.done ? "ok" : "warn") : "mut";
  return `<span class="pill ${cls}" title="${esc(t.note ?? "")}">${
    t.kind === "reminder" ? (t.done ? "✓ " : "! ") : ""}${esc(t.name)}</span>`;
};

/** Companies already contacted, with their tags and open reminders. */
export function historyPage(
  rows: HistoryRow[],
  tags: (Tag & { uses: number })[],
  campaigns: { campaign: string; n: number; last: string | null }[],
  current: string,
  activeTag: number | null,
  activeCampaign: string | null,
  err: string | null,
): string {
  const openReminders = rows.reduce((n, r) => n + r.open_reminders, 0);

  return `
${err ? `<div class="banner" style="border-left-color:var(--bad)"><b>${esc(err)}</b></div>` : ""}

<div class="card">
  <div class="row">
    <b>Current campaign</b>
    <form method="post" action="/history/campaign" class="row" style="gap:.4rem">
      <select name="campaign">
        ${campaigns.map((c) => `<option value="${esc(c.campaign)}" ${
          c.campaign === current ? "selected" : ""}>${esc(c.campaign)}${
          c.n ? ` (${c.n} sent)` : " (unused)"}</option>`).join("")}
      </select>
      <button>Switch</button>
    </form>
    <form method="post" action="/history/campaign" class="row" style="gap:.4rem">
      <input type="text" name="new_campaign" placeholder="new campaign name" maxlength="60">
      <button>Create &amp; switch</button>
    </form>
  </div>
  <p class="mut" style="margin:.6rem 0 0">New sends file under the current campaign.
    Dedup is scoped to it, so switching is what lets you deliberately re-message a
    company a previous campaign already reached.</p>
</div>

${openReminders ? `<div class="banner"><b>${openReminders} open reminder${
  openReminders === 1 ? "" : "s"}</b> across these companies.</div>` : ""}

<div class="row" style="margin:.5rem 0 1rem">
  ${activeTag || activeCampaign ? `<a href="/history">All</a>` : `<b>All</b>`}
  ${campaigns.filter((c) => c.n).map((c) =>
    c.campaign === activeCampaign
      ? `<b>${esc(c.campaign)} (${c.n})</b>`
      : `<a href="/history?campaign=${encodeURIComponent(c.campaign)}">${esc(c.campaign)} (${c.n})</a>`,
  ).join(" · ")}
  <span class="mut">${rows.length} contacted</span>
</div>

<div class="row" style="margin-bottom:1rem">
  <span class="mut">Filter by tag:</span>
  ${tags.filter((t) => t.uses).map((t) =>
    t.id === activeTag
      ? `<b>${esc(t.name)}</b>`
      : `<a href="/history?tag=${t.id}">${esc(t.name)} <span class="mut">${t.uses}</span></a>`,
  ).join(" · ") || `<span class="mut">none in use yet</span>`}
</div>

${rows.length ? `<table><thead><tr>
  <th>Company</th><th>Last contact</th><th>Campaign</th><th>Tags</th><th>Add tag</th>
</tr></thead><tbody>
${rows.map((r) => {
  const rowTags = unpackTags(r.tags);
  return `<tr>
  <td><a href="/company/${r.id}"><b>${esc(r.name)}</b></a><br>
      <span class="mut">${esc(r.city ?? "")}${
        r.send_count > 1 ? ` · ${r.send_count} messages` : ""} · ${esc(r.channels)}</span></td>
  <td class="mut">${esc((r.last_contact ?? "").slice(0, 16))}</td>
  <td class="mut">${esc(r.campaigns)}</td>
  <td>${rowTags.length ? rowTags.map(tagChip).join(" ")
                       : `<span class="mut">—</span>`}</td>
  <td><form method="post" action="/company/${r.id}/tag" class="row" style="gap:.3rem">
      <input type="hidden" name="back" value="history">
      <input type="text" name="name" list="tag-names" placeholder="tag" required style="width:9rem">
      <select name="kind"><option value="label">label</option>
                          <option value="reminder">reminder</option></select>
      <button>+</button></form></td>
</tr>`;
}).join("")}
</tbody></table>
<datalist id="tag-names">${tags.map((t) => `<option value="${esc(t.name)}">`).join("")}</datalist>`
: `<p class="mut">No companies contacted yet. Once a send goes out it is tagged
   automatically and will appear here.</p>`}`;
}

/** The tag block shown on a single company's page. */
export function tagSection(companyId: number, tags: CompanyTag[], all: Tag[]): string {
  return `<div class="card">
  <h2>Tags &amp; reminders</h2>
  ${tags.length ? `<table><tbody>${tags.map((t) => `<tr>
    <td>${tagChip(t)}</td>
    <td class="mut">${esc(t.note ?? "")}</td>
    <td class="mut">${esc(t.added_at.slice(0, 10))}</td>
    <td>${t.kind === "reminder" ? `<form method="post" action="/company/${companyId}/tag/${t.id}/done" class="inline">
        <input type="hidden" name="done" value="${t.done ? 0 : 1}">
        <button>${t.done ? "reopen" : "mark done"}</button></form>` : ""}
      <form method="post" action="/company/${companyId}/tag/${t.id}/remove" class="inline">
        <button title="Remove this tag">×</button></form></td>
  </tr>`).join("")}</tbody></table>` : `<p class="mut">No tags yet.</p>`}
  <form method="post" action="/company/${companyId}/tag" class="row" style="margin-top:.75rem">
    <input type="text" name="name" list="all-tags" placeholder="Partner, Send TY letter…" required>
    <select name="kind"><option value="label">label</option>
                        <option value="reminder">reminder</option></select>
    <input type="text" name="note" placeholder="note (optional)" style="flex:1;min-width:10rem">
    <button>Add tag</button>
  </form>
  <datalist id="all-tags">${all.map((t) => `<option value="${esc(t.name)}">`).join("")}</datalist>
</div>`;
}
