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
  h1{font-size:1.35rem;margin:0 0 .3rem} p{margin:.3rem 0 1rem} a{color:var(--accent)}
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

/** The shared-code field, on the two forms that hand out an account. Rendered
 *  only when SIGNUP_CODE is set -- on a loopback or LAN deploy there is none. */
const codeField = (required: boolean) => required ? `
    <label for="c">Sign-up code</label>
    <input id="c" name="code" autocomplete="off" required
           placeholder="from whoever runs this">` : "";

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
  <p class="mut" style="margin:1rem 0 0">No account yet? <a href="/signup">Create one</a>.</p>
</div>`);
}

/**
 * Sign-up. Anyone who can reach the app can fill this in, and filling it in
 * gets them nothing on its own: an admin accepts the request at /requests
 * before the account can sign in.
 *
 * The name field is the one that matters: it signs the emails this person
 * sends, so the placeholder asks for it the way a sponsor should read it rather
 * than as a handle -- and it is the thing the admin is really approving.
 */
export function signupPage(
  err: string | null, values: { name: string; username: string },
  needsCode = false,
): string {
  return loginShell("Create your account", `
${err ? `<div class="banner"><b>${esc(err)}</b></div>` : ""}
<div class="card">
  <h1>Ask for an account</h1>
  <p class="mut">An admin checks new sign-ups before they can be used, so you will not be
    signed in straight away. Your <b>name</b> signs every email you send and tags every
    company you contact, so enter it the way a sponsor should read it — that is the part
    they are approving.</p>
  <form method="post" action="/signup">
    <label for="n">Your name</label>
    <input id="n" name="name" value="${esc(values.name)}" maxlength="80"
           placeholder="How a sponsor should see it" autocomplete="name" autofocus required>
    <label for="u">Username</label>
    <input id="u" name="username" value="${esc(values.username)}"
           placeholder="3-32 letters, digits, . - _" autocomplete="username" required>
    <label for="p">Password</label>
    <input id="p" name="password" type="password" autocomplete="new-password"
           placeholder="at least 10 characters" minlength="10" required>${codeField(needsCode)}
    <button>Send request</button>
  </form>
  <p class="mut" style="margin:1rem 0 0">Already have one? <a href="/login">Sign in</a>.</p>
</div>`);
}

/** Shown after a request goes in, instead of signing them straight in --
 *  which is the whole point, so it says plainly what happens next. */
export const signupRequestedPage = (name: string): string =>
  loginShell("Request sent", `
<div class="card">
  <h1>Request sent</h1>
  <p class="mut">Thanks, ${esc(name)}. An admin has to accept your sign-up before you can
    sign in — tell whoever runs this that you are waiting, and it takes them one click.</p>
  <p class="mut">Nothing else is needed from you. When it is approved, sign in with the
    username and password you just chose.</p>
  <p class="mut" style="margin:1rem 0 0"><a href="/login">Back to sign in</a></p>
</div>`);

/** Shown only while no account exists at all. The first one is an admin. */
export function bootstrapPage(err: string | null, needsCode = false): string {
  return loginShell("Create the first account", `
${err ? `<div class="banner"><b>${esc(err)}</b></div>` : ""}
<div class="card">
  <h1>Create the first account</h1>
  <p class="mut">There are no accounts yet, so this one becomes the <b>admin</b> — the only
    role that can reset someone else's password or deactivate an account. Everyone after you
    signs themselves up at <code>/signup</code>, as a student.</p>
  <form method="post" action="/login">
    <input type="hidden" name="bootstrap" value="1">
    <label for="n">Your name</label>
    <input id="n" name="name" placeholder="How a sponsor should see it" autofocus required>
    <label for="u">Username</label>
    <input id="u" name="username" autocomplete="username" required>
    <label for="p">Password</label>
    <input id="p" name="password" type="password" autocomplete="new-password"
           minlength="10" required>${codeField(needsCode)}
    <button>Create admin account</button>
  </form>
</div>`);
}

/** One waiting sign-up, and the thing the admin is actually deciding about:
 *  the name a sponsor will see on the emails this person sends. */
export interface AccountRequest {
  student: Student;
  /** Exactly what the From line and signature will read, org included. */
  signature: string;
}

/**
 * The approval page. Small on purpose -- it is a list of people and two
 * buttons each, because anything more would be a reason to put it off, and a
 * request sitting unread is a student who cannot work.
 */
export function requestsPage(
  rows: AccountRequest[], err: string | null, notice: string | null,
): string {
  return `
${err ? `<div class="banner" style="border-left-color:var(--bad)"><b>Not saved:</b> ${esc(err)}</div>` : ""}
${notice ? `<div class="banner"><b>${esc(notice)}</b></div>` : ""}

<h2>Sign-ups waiting</h2>

${rows.length === 0 ? `<div class="card">
  <p class="mut" style="margin:0">Nobody is waiting. New sign-ups from <code>/signup</code>
  land here, and cannot sign in until you accept them.</p>
</div>` : `
<p class="mut">Approving lets them sign in and send under the name below. Declining removes
  the request and frees the username, so an honest mistake can just sign up again.</p>

${rows.map(({ student: st, signature }) => `<div class="card">
  <div class="row" style="align-items:flex-start">
    <div style="flex:1;min-width:16rem">
      <div style="font-size:1.1rem"><b>${esc(st.name)}</b>
        <span class="mut">@${esc(st.username)}</span></div>
      <p class="mut" style="margin:.35rem 0 0">Asked on ${esc(st.created_at.slice(0, 16))}</p>
      <p style="margin:.6rem 0 0">Their emails will be signed
        <b>${esc(signature)}</b>, and every company they contact gets the tag
        <code>Student: ${esc(st.name)}</code>.</p>
    </div>
    <div class="row" style="gap:.5rem">
      <form method="post" action="/requests/${st.id}/approve" class="inline">
        <button class="primary">Approve</button></form>
      <form method="post" action="/requests/${st.id}/decline" class="inline">
        <button>Decline</button></form>
    </div>
  </div>
</div>`).join("")}`}

<p class="mut">Roles are separate: an approved sign-up is always a <b>student</b>.
  Making someone an admin is done from <a href="/accounts">Accounts</a>, deliberately.</p>`;
}

const rolePill = (s: Student) =>
  s.role === "admin" ? `<span class="pill ok">admin</span>` : `<span class="pill mut">student</span>`;

export function accountsPage(
  list: Student[], me: Student, err: string | null, notice: string | null,
  pending = 0,
): string {
  const isAdmin = me.role === "admin";
  return `
${err ? `<div class="banner" style="border-left-color:var(--bad)"><b>Not saved:</b> ${esc(err)}</div>` : ""}
${notice ? `<div class="banner"><b>${esc(notice)}</b></div>` : ""}
${isAdmin && pending ? `<div class="banner" style="border-left-color:var(--warn)">
  <b>${pending} sign-up${pending === 1 ? "" : "s"} waiting.</b>
  Nobody can sign in until you <a href="/requests">look at them</a>.</div>` : ""}

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
  <p class="mut" style="margin:.6rem 0 0">Students can also <a href="/signup">ask for an
    account</a>, which you accept on the <a href="/requests">requests</a> page; an account
    made here is approved already, because you made it. Their
    <b>name</b> signs the emails they send and becomes the <code>Student: …</code> tag on every
    company they contact, so enter it the way a sponsor should read it. Accounts with sends
    against them can be deactivated but not deleted — the log has to stay readable.</p>
</div>`
: `<p class="mut">Only an admin can reset someone else's password, or deactivate an account.</p>`}`;
}
