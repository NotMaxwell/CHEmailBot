// Sign-in and account management.
import { esc } from "./layout.ts";
import type { Student } from "../../auth.ts";

/** Standalone page: no nav, because nobody is signed in to navigate as. */
export const loginShell = (title: string, body: string) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · CHEmailBot</title>
<style>
  :root{color-scheme:light dark;--fg:#16181d;--bg:#fff;--mut:#6b7280;--line:#e5e7eb;
        --accent:#2563eb;--bad:#b91c1c;--card:#f9fafb;}
  @media(prefers-color-scheme:dark){:root{--fg:#e8eaed;--bg:#0f1115;--mut:#9aa1ac;
        --line:#2a2f39;--accent:#60a5fa;--bad:#f87171;--card:#171a21;}}
  *{box-sizing:border-box}
  body{font:15px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif;color:var(--fg);
       background:var(--bg);margin:0 auto;max-width:26rem;padding:4rem 1rem}
  h1{font-size:1.35rem;margin:0 0 .3rem} p{margin:.3rem 0 1rem}
  label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.04em;
        color:var(--mut);margin:.8rem 0 .25rem}
  input{font:inherit;width:100%;padding:.5rem .6rem;border:1px solid var(--line);
        border-radius:6px;background:var(--bg);color:var(--fg)}
  button{font:inherit;margin-top:1.1rem;width:100%;padding:.55rem;border:1px solid transparent;
         border-radius:6px;background:var(--accent);color:#fff;cursor:pointer}
  .mut{color:var(--mut)} .card{background:var(--card);border:1px solid var(--line);
       border-radius:8px;padding:1.25rem}
  .banner{border-left:3px solid var(--bad);background:var(--card);padding:.6rem .8rem;
          margin-bottom:1rem}
</style></head><body>${body}</body></html>`;

export function loginPage(err: string | null, next: string | null): string {
  return loginShell("Sign in", `
${err ? `<div class="banner"><b>${esc(err)}</b></div>` : ""}
<div class="card">
  <h1>Sign in</h1>
  <p class="mut">Sends are recorded against your name, on the company and in the log.</p>
  <form method="post" action="/login">
    ${next ? `<input type="hidden" name="next" value="${esc(next)}">` : ""}
    <label for="u">Username</label>
    <input id="u" name="username" autocomplete="username" autofocus required>
    <label for="p">Password</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required>
    <button>Sign in</button>
  </form>
</div>`);
}

/** Shown only while no account exists at all. The first one is an admin. */
export function bootstrapPage(err: string | null): string {
  return loginShell("Create the first account", `
${err ? `<div class="banner"><b>${esc(err)}</b></div>` : ""}
<div class="card">
  <h1>Create the first account</h1>
  <p class="mut">There are no accounts yet, so this one becomes the <b>admin</b> — the only
    role that can add students or reset a password. Nobody can sign themselves up afterwards.</p>
  <form method="post" action="/login">
    <input type="hidden" name="bootstrap" value="1">
    <label for="n">Your name</label>
    <input id="n" name="name" placeholder="How a sponsor should see it" autofocus required>
    <label for="u">Username</label>
    <input id="u" name="username" autocomplete="username" required>
    <label for="p">Password</label>
    <input id="p" name="password" type="password" autocomplete="new-password"
           minlength="10" required>
    <button>Create admin account</button>
  </form>
</div>`);
}

const rolePill = (s: Student) =>
  s.role === "admin" ? `<span class="pill ok">admin</span>` : `<span class="pill mut">student</span>`;

export function accountsPage(
  list: Student[], me: Student, err: string | null, notice: string | null,
): string {
  const isAdmin = me.role === "admin";
  return `
${err ? `<div class="banner" style="border-left-color:var(--bad)"><b>Not saved:</b> ${esc(err)}</div>` : ""}
${notice ? `<div class="banner"><b>${esc(notice)}</b></div>` : ""}

<div class="card">
  <h2>Your password</h2>
  <form method="post" action="/accounts/password" class="row">
    <input type="password" name="password" placeholder="new password" minlength="10"
           autocomplete="new-password" required style="min-width:14rem">
    <button class="primary">Change my password</button>
    <span class="mut">At least 10 characters. Signs you out everywhere else.</span>
  </form>
</div>

${isAdmin ? `<h2>Accounts</h2>
<div class="scroll"><table><thead><tr>
  <th>Name</th><th>Username</th><th>Role</th><th>Last signed in</th><th>Actions</th>
</tr></thead><tbody>
${list.map((s) => `<tr${s.active ? "" : ' class="mut"'}>
  <td><b>${esc(s.name)}</b>${s.id === me.id ? ` <span class="mut">(you)</span>` : ""}
      ${s.active ? "" : ` <span class="pill bad">deactivated</span>`}</td>
  <td class="mut">${esc(s.username)}</td>
  <td>${rolePill(s)}</td>
  <td class="mut">${esc((s.last_login_at ?? "").slice(0, 16)) || "never"}</td>
  <td>
    <form method="post" action="/accounts/${s.id}/active" class="inline">
      <input type="hidden" name="active" value="${s.active ? 0 : 1}">
      <button>${s.active ? "Deactivate" : "Reactivate"}</button></form>
    <form method="post" action="/accounts/${s.id}/role" class="inline">
      <input type="hidden" name="role" value="${s.role === "admin" ? "student" : "admin"}">
      <button>${s.role === "admin" ? "Make student" : "Make admin"}</button></form>
    <form method="post" action="/accounts/${s.id}/password" class="inline">
      <input type="password" name="password" placeholder="reset to…" minlength="10"
             required style="width:9rem">
      <button>Reset</button></form>
  </td>
</tr>`).join("")}
</tbody></table></div>

<div class="card">
  <h2>Add a student</h2>
  <form method="post" action="/accounts">
    <div class="row">
      <input type="text" name="name" placeholder="Name (signs their emails)" required>
      <input type="text" name="username" placeholder="username" required>
      <input type="password" name="password" placeholder="password (10+ chars)"
             minlength="10" autocomplete="new-password" required>
      <select name="role"><option value="student">student</option>
                          <option value="admin">admin</option></select>
      <button class="primary">Create account</button>
    </div>
  </form>
  <p class="mut" style="margin:.6rem 0 0">Their <b>name</b> signs the emails they send and
    becomes the <code>Student: …</code> tag on every company they contact, so enter it the way
    a sponsor should read it. Accounts with sends against them can be deactivated but not
    deleted — the log has to stay readable.</p>
</div>`
: `<p class="mut">Only an admin can add accounts or reset someone else's password.</p>`}`;
}
