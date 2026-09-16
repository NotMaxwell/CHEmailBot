export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** No CDN: the UI must work on a bad connection. Styles are inline. */
/** `refresh` reloads the page every few seconds -- used while a background job
 *  runs, so progress is visible without the old "reload to refresh" chore. */
export const layout = (
  title: string, body: string, stats?: Record<string, number>, opts: { refresh?: boolean } = {},
) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${opts.refresh ? '<meta http-equiv="refresh" content="4">' : ""}
<title>${esc(title)} · CHEmailBot</title>
<style>
  :root{color-scheme:light dark;--fg:#16181d;--bg:#fff;--mut:#6b7280;--line:#e5e7eb;
        --accent:#2563eb;--ok:#15803d;--warn:#b45309;--bad:#b91c1c;--card:#f9fafb;}
  @media(prefers-color-scheme:dark){:root{--fg:#e8eaed;--bg:#0f1115;--mut:#9aa1ac;
        --line:#2a2f39;--accent:#60a5fa;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--card:#171a21;}}
  *{box-sizing:border-box}
  body{font:15px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif;color:var(--fg);
       background:var(--bg);margin:0 auto;max-width:1080px;padding:1.5rem 1rem 4rem}
  a{color:var(--accent)} nav{display:flex;gap:1rem;margin-bottom:1.5rem;font-weight:500}
  h1{font-size:1.5rem;margin:.2rem 0 1rem} h2{font-size:1.05rem;margin:1.5rem 0 .5rem}
  table{border-collapse:collapse;width:100%;font-size:14px}
  td,th{border-bottom:1px solid var(--line);padding:.55rem .5rem;text-align:left;vertical-align:top}
  th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut)}
  .steps{display:flex;gap:.5rem;flex-wrap:wrap;margin:0 0 1.25rem;padding:0;list-style:none}
  .steps li{flex:1;min-width:120px;background:var(--card);border:1px solid var(--line);
            border-radius:8px;padding:.6rem .7rem}
  .steps b{display:block;font-size:1.3rem;line-height:1.2}
  .steps span{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut)}
  .pill{display:inline-block;font-size:11px;padding:.1rem .45rem;border-radius:999px;
        border:1px solid currentColor;white-space:nowrap}
  .ok{color:var(--ok)} .warn{color:var(--warn)} .bad{color:var(--bad)} .mut{color:var(--mut)}
  button{font:inherit;padding:.35rem .7rem;border:1px solid var(--line);border-radius:6px;
         background:var(--card);color:var(--fg);cursor:pointer}
  button.primary{background:var(--accent);color:#fff;border-color:transparent}
  button:disabled{opacity:.45;cursor:not-allowed}
  form.inline{display:inline}
  input[type=text],input[type=email],select,textarea{font:inherit;padding:.35rem .5rem;
         border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
  textarea{width:100%;min-height:14rem;font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:1rem;margin:.75rem 0}
  .row{display:flex;gap:.75rem;align-items:center;flex-wrap:wrap}
  nav{flex-wrap:wrap} .scroll{overflow-x:auto}
  .banner{background:var(--card);border-left:3px solid var(--accent);padding:.6rem .8rem;margin-bottom:1rem}
</style></head><body>
<nav><a href="/">Review queue</a><a href="/campaigns">Campaigns &amp; templates</a><a href="/history">Past companies</a><a href="/suppressions">Do not contact</a><a href="/log">Send log</a></nav>
${stats ? `<ul class="steps">
  <li><span>1 · Scraped</span><b>${stats.companies}</b></li>
  <li><span>2 · Verified co.</span><b>${stats.approved}</b></li>
  <li><span>3 · With email</span><b>${stats.withEmail}</b></li>
  <li><span>4 · Email verified</span><b>${stats.verified}</b></li>
  <li><span>5 · Sent</span><b>${stats.sent}</b></li>
</ul>` : ""}
<h1>${esc(title)}</h1>${body}</body></html>`;
