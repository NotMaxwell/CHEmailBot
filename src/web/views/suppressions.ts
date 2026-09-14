import { esc } from "./layout.ts";
import type { Suppression } from "../../repo.ts";

export function suppressionsPage(list: Suppression[], err: string | null): string {
  return `
${err ? `<div class="banner" style="border-left-color:var(--bad)"><b>Not added:</b> ${esc(err)}</div>` : ""}
<p class="mut">Anything on this list is excluded from email sends, from recorded form contacts,
  and from the ready lists. A domain covers every address at it and the company's contact
  form. CAN-SPAM requires honoring an opt-out within 10 business days — record one here
  the moment it arrives.</p>

<div class="card">
  <form method="post" action="/suppressions" class="row">
    <input type="text" name="value" placeholder="person@company.com or company.com" required
           style="flex:1;min-width:12rem">
    <input type="text" name="reason" placeholder="reason (optional)">
    <button class="primary">Add to list</button>
  </form>
</div>

${list.length ? `<div class="scroll"><table><thead><tr>
  <th>Blocked</th><th>Type</th><th>Reason</th><th>Added</th><th></th>
</tr></thead><tbody>
${list.map((s) => `<tr>
  <td>${esc(s.value)}</td>
  <td class="mut">${esc(s.kind)}</td>
  <td class="mut">${esc(s.reason ?? "")}</td>
  <td class="mut">${esc(s.created_at.slice(0, 10))}</td>
  <td><form method="post" action="/suppressions/${s.id}/delete" class="inline"
            onsubmit="return confirm('Remove from the do-not-contact list?')">
      <button>Remove</button></form></td>
</tr>`).join("")}
</tbody></table></div>` : `<p class="mut">Nobody is on the list.</p>`}`;
}
