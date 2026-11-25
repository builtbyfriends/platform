/**
 * 200 + JS `location.replace`, NOT a 302. `wrangler dev` rewrites
 * `Location: http://localhost:*` headers (prepending the dev origin port, so a
 * real 302 arrives as `localhost:8787:8787:5173/...` and ERR_INVALID_REDIRECTs —
 * see meta/lessons.md). Any browser redirect to another localhost:port must use
 * this instead of a 30x. `https`/`127.0.0.1` are unaffected, but this shape is
 * safe for any target, and `app.fetch` in tests returns it identically (it never
 * hits wrangler), so tests verify the embedded target string, not a Location header.
 *
 * @param target absolute URL to navigate the browser to
 * @param title  document `<title>` shown briefly while redirecting
 */
export function localhostRedirectResponse(target: string, title = 'Redirecting…'): Response {
  // Decision: Safe to embed in an inline <script>: JSON.stringify escapes quotes and backslashes but not
  // `</script>` or `<!--`, which would break out of the script element. Escape `<` (and `>`) so the
  // literal is safe for any input. Don't escape `&`: HTML doesn't decode entities inside <script>, and
  // escaping it would corrupt the query string the browser navigates to.
  const targetLiteral = JSON.stringify(target)
    .replaceAll('<', String.raw`\u003c`)
    .replaceAll('>', String.raw`\u003e`);
  // Decision: The noscript fallback puts `target` in a double-quoted HTML attribute. Escape `&` first, then `"`,
  // `<` and `>`, so it can't break the attribute or inject markup.
  const targetAttr = target
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  const body =
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<script>location.replace(${targetLiteral})</script>` +
    `<noscript><meta http-equiv="refresh" content="0;url=${targetAttr}"></noscript>`;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
