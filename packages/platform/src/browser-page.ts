/** Shared, dependency-free presentation for browser onboarding and authentication pages. */
export const browserPageLogo: string =
  '<svg role="img" aria-label="Platform" viewBox="0 0 270 58" fill="none" xmlns="http://www.w3.org/2000/svg">\n<circle cx="262" cy="48.96" r="8" fill="currentColor"/>\n<text x="0" y="56" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="78" font-weight="800" letter-spacing="-2" textLength="244" lengthAdjust="spacingAndGlyphs" fill="currentColor">bwf</text>\n</svg>';

// Decision: Scoped so dashboard and admin application styles stay independent of these pages.
export const browserPageStyles: string = `
:root { color-scheme: light dark; }
html[data-theme="light"] { color-scheme: light; }
html[data-theme="dark"] { color-scheme: dark; }
.platform-auth-page {
  --auth-radius-inner: .375rem; --auth-radius-element: .625rem; --auth-radius-container: .75rem;
  --auth-body: light-dark(#f1f1f1, #1b1b1b); --auth-card: light-dark(#fff, #1b1b1b);
  --auth-text: light-dark(#000, #fff); --auth-secondary: light-dark(#474747, #9e9e9e);
  --auth-border: light-dark(#0000000f, #ffffff1a); --auth-accent: light-dark(#1b1b1b, #f1f1f1); --auth-on-accent: light-dark(#fff, #1b1b1b);
  --auth-success: light-dark(#176e45, #79dba9); --auth-success-bg: light-dark(#e7f4ec, #173a29);
  --auth-error: light-dark(#b42332, #ff9aab); --auth-error-bg: light-dark(#fcebed, #421d26);
  box-sizing: border-box; min-height: 100svh; margin: 0;
  padding: clamp(40px, 10vh, 100px) 16px 48px; background: var(--auth-body); color: var(--auth-text);
  font: 14px/1.55 Figtree, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
@supports (color: AccentColor) { .platform-auth-page { --auth-accent: AccentColor; --auth-on-accent: AccentColorText; } }
/* Match the neutral administrator dashboard's radii, including its rounded fallback. */
@supports (corner-shape: squircle) {
  .platform-auth-page { --auth-radius-inner: .75rem; --auth-radius-element: 1.25rem; --auth-radius-container: 1.5rem; }
  .platform-auth-page, .platform-auth-page *, .platform-auth-page *::before, .platform-auth-page *::after { corner-shape: squircle; }
  .platform-auth-page .platform-auth-status { corner-shape: round; }
}
.platform-auth-page *, .platform-auth-page *::before, .platform-auth-page *::after { box-sizing: border-box; }
.platform-auth-page .platform-auth-container { width: 100%; max-width: 448px; margin: 0 auto; }
.platform-auth-page .platform-auth-brand { display: flex; align-items: center; gap: 12px; margin: 0 4px 24px; color: var(--auth-secondary); overflow-wrap: anywhere; }
.platform-auth-page .platform-auth-logo { display: flex; flex: 0 0 70px; color: var(--auth-text); }
.platform-auth-page .platform-auth-logo svg { display: block; width: 70px; height: auto; }
.platform-auth-page .platform-auth-divider { width: 1px; height: 18px; background: var(--auth-border); flex-shrink: 0; }
.platform-auth-page .platform-auth-card { display: grid; gap: 24px; min-width: 0; padding: 24px; border: 1px solid var(--auth-border); border-radius: var(--auth-radius-container); background: var(--auth-card); }
.platform-auth-page .platform-auth-lead { display: grid; gap: 10px; }
.platform-auth-page .platform-auth-section { display: grid; gap: 12px; min-width: 0; }
.platform-auth-page h1 { margin: 0; font-family: inherit; font-size: 26px; font-weight: 600; line-height: 1.2; letter-spacing: -.5px; color: var(--auth-text); overflow-wrap: anywhere; }
.platform-auth-page h2 { margin: 0; font-family: inherit; font-size: 18px; font-weight: 600; line-height: 1.3; color: var(--auth-text); overflow-wrap: anywhere; }
.platform-auth-page p { margin: 0; font: inherit; color: var(--auth-secondary); overflow-wrap: anywhere; }
.platform-auth-page strong { font-weight: 600; color: var(--auth-text); }
.platform-auth-page a:not(.platform-auth-button) { color: var(--auth-text); text-underline-offset: 3px; }
.platform-auth-page form { display: grid; gap: 12px; }
.platform-auth-page .platform-auth-actions { display: grid; gap: 8px; }
.platform-auth-page .platform-auth-button { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 44px; padding: 10px 16px; border: 1px solid var(--auth-border); border-radius: var(--auth-radius-element); background: var(--auth-body); color: var(--auth-text); font: inherit; font-weight: 550; line-height: 1.4; text-align: center; text-decoration: none; overflow-wrap: anywhere; cursor: pointer; }
.platform-auth-page .platform-auth-button-primary { background: var(--auth-accent); color: var(--auth-on-accent); border-color: var(--auth-accent); }
.platform-auth-page .platform-auth-button:hover { filter: brightness(.92); }
.platform-auth-page :is(a, button, input):focus-visible { outline: 2px solid var(--auth-accent); outline-offset: 3px; }
.platform-auth-page .platform-auth-form { display: grid; gap: 10px; }
.platform-auth-page label { font-weight: 550; }
.platform-auth-page input:not([type=hidden]) { width: 100%; min-width: 0; height: 44px; padding: 0 12px; border: 1px solid var(--auth-border); border-radius: var(--auth-radius-element); background: var(--auth-body); color: var(--auth-text); font: inherit; }
.platform-auth-page .platform-auth-form button { margin-top: 8px; }
.platform-auth-page .platform-auth-identity { margin: 0; padding: 8px 14px; border: 1px solid var(--auth-border); border-radius: var(--auth-radius-inner); background: var(--auth-body); }
.platform-auth-page .platform-auth-identity > div { display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: 16px; padding: 10px 0; }
.platform-auth-page .platform-auth-identity > div + div { border-top: 1px solid var(--auth-border); }
.platform-auth-page dt { color: var(--auth-secondary); font-size: 13px; }
.platform-auth-page dd { margin: 0; overflow-wrap: anywhere; }
.platform-auth-page .platform-auth-note { font-size: 13px; color: var(--auth-secondary); }
.platform-auth-page pre { margin: 0; padding: 14px; border: 1px solid var(--auth-border); border-radius: var(--auth-radius-container); background: var(--auth-body); white-space: pre-wrap; overflow-wrap: anywhere; }
.platform-auth-page code { font: 13px/1.6 ui-monospace, "SF Mono", Monaco, Consolas, monospace; }
.platform-auth-page p code { padding: 2px 7px; background: light-dark(#e5e5e5, #343434); color: var(--auth-text); border-radius: 24px; corner-shape: squircle; white-space: nowrap; }
.platform-auth-page .platform-auth-status { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; font-size: 22px; font-weight: 650; }
.platform-auth-page .platform-auth-status-success { color: var(--auth-success); background: var(--auth-success-bg); }
.platform-auth-page .platform-auth-status-error { color: var(--auth-error); background: var(--auth-error-bg); }
@media (max-width: 500px) { .platform-auth-page h1 { font-size: 24px; } }
`;

export function escapeBrowserHtml(value: string): string {
  return value.replaceAll(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
}

export function browserPageIdentity(identity: {
  login: string;
  issuer: string;
  subject: string;
}): string {
  return (
    '<dl class="platform-auth-identity">' +
    [
      ['Account', identity.login],
      ['Provider', identity.issuer],
      ['Identity', identity.subject],
    ]
      .map(
        ([label, value]) =>
          '<div><dt>' + label + '</dt><dd>' + escapeBrowserHtml(value) + '</dd></div>',
      )
      .join('') +
    '</dl>'
  );
}

export function browserPageStatus(status: 'success' | 'error'): string {
  return (
    '<div class="platform-auth-status platform-auth-status-' +
    status +
    '" aria-label="' +
    (status === 'success' ? 'Success' : 'Error') +
    '">' +
    (status === 'success' ? '✓' : '!') +
    '</div>'
  );
}

/** content is trusted markup; escape every dynamic value before composing it. */
export function renderBrowserPage({
  title,
  platformName = 'Platform',
  content,
}: {
  title: string;
  platformName?: string;
  content: string;
}): string {
  const pageTitle =
    title + ' · ' + platformName + (/\bplatform\b/i.test(platformName) ? '' : ' · bwf');
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>' +
    escapeBrowserHtml(pageTitle) +
    '</title><style>body{margin:0}' +
    browserPageStyles +
    '</style></head><body><main class="platform-auth-page"><div class="platform-auth-container"><div class="platform-auth-brand"><span class="platform-auth-logo">' +
    browserPageLogo +
    '</span><span class="platform-auth-divider" aria-hidden="true"></span><span>' +
    escapeBrowserHtml(platformName) +
    '</span></div><section class="platform-auth-card" aria-labelledby="platform-auth-title">' +
    content +
    '</section></div></main></body></html>'
  );
}

export function browserPageLead(title: string, description: string): string {
  return (
    '<div class="platform-auth-lead"><h1 id="platform-auth-title">' +
    escapeBrowserHtml(title) +
    '</h1><p>' +
    escapeBrowserHtml(description) +
    '</p></div>'
  );
}
