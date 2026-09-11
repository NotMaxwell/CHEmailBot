export const layout = (title: string, body: string) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - CHEmailBot</title>
<script src="https://unpkg.com/htmx.org@2.0.3"></script>
<style>
  :root { color-scheme: light dark; --fg:#111; --bg:#fff; --mut:#666; --line:#ddd; }
  @media (prefers-color-scheme:dark){ :root{ --fg:#eee; --bg:#111; --mut:#999; --line:#333; } }
  body { font:15px/1.5 ui-sans-serif,system-ui,sans-serif; color:var(--fg); background:var(--bg);
         margin:0 auto; max-width:1100px; padding:2rem 1rem; }
  table { border-collapse:collapse; width:100%; }
  td,th { border-bottom:1px solid var(--line); padding:.5rem .6rem; text-align:left; }
  .sent{color:#2a7}.queued{color:#c81}.new{color:var(--mut)}
</style></head>
<body><nav><a href="/">Companies</a> · <a href="/templates">Template</a> · <a href="/log">Send log</a></nav>
<h1>${title}</h1>${body}</body></html>`;
