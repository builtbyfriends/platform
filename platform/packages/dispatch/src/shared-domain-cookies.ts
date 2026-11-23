function cookieDomain(cookie: string): string | null {
  let domain: string | null = null;
  for (const attribute of cookie.split(';').slice(1)) {
    const separator = attribute.indexOf('=');
    if (separator !== -1 && attribute.slice(0, separator).trim().toLowerCase() === 'domain') {
      domain = attribute
        .slice(separator + 1)
        .trim()
        .toLowerCase()
        .replace(/^\./, '');
    }
  }
  return domain;
}

// Decision: Project hostnames share one parent domain that isn't on the Public Suffix List, so a cookie an app sets
// with `Domain=<parent>` reaches every other project. Header rules already can't set cookies; this
// holds the app's own responses to its hostname. A custom domain is the owner's to scope.
export function dropParentDomainCookies(headers: Headers, hostname: string): void {
  const cookies = headers.getSetCookie();
  const kept = cookies.filter((cookie) => {
    const domain = cookieDomain(cookie);
    return (
      domain === null || domain === '' || domain === hostname || domain.endsWith(`.${hostname}`)
    );
  });
  if (kept.length === cookies.length) {
    return;
  }
  headers.delete('set-cookie');
  for (const cookie of kept) {
    headers.append('set-cookie', cookie);
  }
}
