import { MCP_SCOPE_LABELS } from "./config.js";

// Server-rendered sign-in + consent page for the MCP OAuth flow. Staff sign
// in with their CRM email/password and pick which access to grant. Publish
// scopes start unticked so publishing access is always a deliberate choice.

const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

const SENSITIVE = new Set([
  "blogs:publish",
  "instagram:publish",
  "instagram:cleanup",
]);

export const consentSecurityHeaders = (res, redirectUri) => {
  let target = "";
  try {
    target = new URL(redirectUri).origin;
  } catch (_error) {
    target = "";
  }
  res.set({
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${target}; frame-ancestors 'none'; base-uri 'none'`,
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
};

export const renderConsentPage = ({
  action,
  requestId,
  clientName,
  redirectUri,
  scopes,
  email = "",
  error = "",
}) => {
  let host = "";
  try {
    host = new URL(redirectUri).host;
  } catch (_error) {
    host = "";
  }
  const items = scopes
    .map(
      (
        scope,
      ) => `<label class="scope"><input type="checkbox" name="scope" value="${escape(scope)}"${SENSITIVE.has(scope) ? "" : " checked"}>
        <span><strong>${escape(scope)}</strong> &mdash; ${escape(MCP_SCOPE_LABELS[scope] || scope)}</span></label>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Aquakart</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --text:#1d2330; --muted:#5b6475; --line:#d8dce3; --accent:#0b6bcb; --danger:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12151b; --card:#1b2029; --text:#e8ebf1; --muted:#a3abba; --line:#323a47; --accent:#5aa7f5; --danger:#f97066; } }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.5 system-ui, sans-serif; }
  main { max-width:440px; margin:40px auto; padding:0 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:24px; }
  h1 { font-size:20px; margin:0 0 4px; } p { color:var(--muted); margin:0 0 16px; }
  label { display:block; margin:12px 0 4px; font-weight:600; }
  input[type=email], input[type=password] { width:100%; box-sizing:border-box; padding:10px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; font:inherit; }
  .scope { display:flex; gap:8px; align-items:flex-start; font-weight:400; }
  .error { color:var(--danger); font-weight:600; }
  .actions { display:flex; gap:8px; margin-top:20px; }
  button { flex:1; padding:10px; border-radius:8px; border:1px solid var(--line); font:inherit; cursor:pointer; background:transparent; color:inherit; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
</style></head>
<body><main><div class="card">
  <h1>Connect ${escape(clientName || "an MCP client")} to Aquakart</h1>
  <p>Sign in with your Aquakart staff account. Access is limited to blogs and Instagram publishing, and is returned to <strong>${escape(host)}</strong>.</p>
  ${error ? `<p class="error" role="alert">${escape(error)}</p>` : ""}
  <form method="post" action="${escape(action)}">
    <input type="hidden" name="request_id" value="${escape(requestId)}">
    <label for="email">Email</label><input id="email" type="email" name="email" autocomplete="username" required value="${escape(email)}">
    <label for="password">Password</label><input id="password" type="password" name="password" autocomplete="current-password" required>
    <label>Access to grant</label>${items}
    <div class="actions"><button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
    <button class="primary" type="submit" name="decision" value="approve">Allow</button></div>
  </form>
</div></main></body></html>`;
};

export const renderMessagePage = (title, message) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
<style>:root{color-scheme:light dark} body{margin:0;font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText} main{max-width:440px;margin:40px auto;padding:0 16px}</style>
</head><body><main><h1>${escape(title)}</h1><p>${escape(message)}</p></main></body></html>`;
