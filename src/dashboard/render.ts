export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(title)} — SHLD</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #e5e5e5; }
  th { font-size: 0.85rem; color: #666; text-transform: uppercase; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.8rem; }
  .badge-blocked, .badge-still_exploitable, .badge-failed { background: #fee2e2; color: #991b1b; }
  .badge-completed, .badge-verified_fixed, .badge-passed { background: #dcfce7; color: #166534; }
  .badge-awaiting_fix, .badge-fix_pending { background: #fef3c7; color: #92400e; }
  .badge-confirmed { background: #fee2e2; color: #991b1b; }
  nav { margin-bottom: 1.5rem; }
  nav a { margin-right: 1rem; }
  pre { background: #f5f5f5; padding: 1rem; overflow-x: auto; }
</style>
</head>
<body>
<nav><a href="/dashboard/runs">Runs</a><a href="/dashboard/settings">Settings</a></nav>
${body}
</body>
</html>`;
}

export function statusBadge(status: string): string {
  return `<span class="badge badge-${esc(status)}">${esc(status)}</span>`;
}
