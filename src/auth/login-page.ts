/**
 * Minimal HTML login page served by the Authorization Code flow.
 *
 * The user types their DSpace credentials into this page IN THE BROWSER; the
 * credentials are POSTed straight to the MCP server's own login handler and
 * are never seen by the MCP client or the model. On success the server logs in
 * to DSpace, mints an authorization code, and redirects back to the client's
 * redirect_uri.
 */

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));

export interface LoginPageParams {
  /** Where the form posts to (the server's internal login-submit endpoint). */
  actionUrl: string;
  /** Opaque authorization-request handle carried through the login. */
  requestId: string;
  /** Optional error message to display (e.g. after a failed attempt). */
  error?: string;
}

export function renderLoginPage(params: LoginPageParams): string {
  const { actionUrl, requestId, error } = params;
  const errorBlock = error
    ? `<div class="error" role="alert">${escapeHtml(error)}</div>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Sign in to DSpace</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
         display: flex; min-height: 100vh; margin: 0; align-items: center;
         justify-content: center; background: #f4f5f7; }
  .card { background: #fff; padding: 2rem; border-radius: 12px; width: 340px;
          box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  h1 { font-size: 1.15rem; margin: 0 0 1.25rem; }
  label { display: block; font-size: .8rem; margin: .75rem 0 .25rem; color: #444; }
  input { width: 100%; box-sizing: border-box; padding: .6rem .7rem; font-size: .95rem;
          border: 1px solid #cbd0d8; border-radius: 8px; }
  button { margin-top: 1.25rem; width: 100%; padding: .7rem; font-size: .95rem;
           border: 0; border-radius: 8px; background: #1f6feb; color: #fff; cursor: pointer; }
  button:hover { background: #1a5fd0; }
  .error { background: #fdecec; color: #a61b1b; padding: .6rem .7rem; border-radius: 8px;
           font-size: .85rem; margin-bottom: 1rem; }
  .hint { margin-top: 1rem; font-size: .75rem; color: #777; line-height: 1.4; }
</style>
</head>
<body>
  <form class="card" method="post" action="${escapeHtml(actionUrl)}" autocomplete="off">
    <h1>Sign in to DSpace</h1>
    ${errorBlock}
    <input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
    <label for="user">Email</label>
    <input id="user" name="user" type="email" required autofocus>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" required>
    <button type="submit">Sign in</button>
    <p class="hint">Your credentials are sent only to this server to establish a
    DSpace session. They are not shared with the AI client or model.</p>
  </form>
</body>
</html>`;
}
