import { esc } from "./layout.ts";

type Template = { id: number; name: string; subject: string; body: string };

const FIELDS = "{{company}} {{city}} {{state}} {{website}} {{sender_name}} {{unsubscribe}}";

export function templatesPage(list: Template[], err: string | null): string {
  return `
${err ? `<div class="banner" style="border-left-color:var(--bad)"><b>Not saved:</b> ${esc(err)}</div>` : ""}
<p class="mut">Merge fields: <code>${FIELDS}</code>. An unknown field is rejected when you
  save. The CAN-SPAM footer is appended to every message automatically — don't add one here.</p>

${list.map((t) => `<div class="card">
  <form method="post" action="/templates/${t.id}">
    <div class="row">
      <input type="text" name="name" value="${esc(t.name)}" required aria-label="Template name" style="font-weight:600">
      <input type="text" name="subject" value="${esc(t.subject)}" required aria-label="Subject" style="flex:1;min-width:12rem">
    </div>
    <textarea name="body" required aria-label="Body">${esc(t.body)}</textarea>
    <button class="primary">Save</button>
  </form>
  <form method="post" action="/templates/${t.id}/delete" class="inline"
        onsubmit="return confirm('Delete this template?')" style="margin-top:.5rem">
    <button>Delete</button>
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
