import { describe, expect, it } from 'vite-plus/test';
import { dropParentDomainCookies } from '../../src/shared-domain-cookies.ts';

function headersWith(...cookies: Array<string>): Headers {
  const headers = new Headers();
  for (const cookie of cookies) {
    headers.append('set-cookie', cookie);
  }
  return headers;
}

describe('dropParentDomainCookies', () => {
  it('drops a cookie scoped to the shared parent domain and keeps the rest', () => {
    const headers = headersWith(
      'sid=attacker; Domain=example.test; Path=/',
      'other=1; Path=/; domain = .EXAMPLE.test',
      'own=1; Path=/; HttpOnly',
      'scoped=1; Domain=my-app.example.test',
      'child=1; Domain=.api.my-app.example.test',
    );
    dropParentDomainCookies(headers, 'my-app.example.test');
    expect(headers.getSetCookie()).toEqual([
      'own=1; Path=/; HttpOnly',
      'scoped=1; Domain=my-app.example.test',
      'child=1; Domain=.api.my-app.example.test',
    ]);
  });

  it("drops a cookie scoped to another project's hostname", () => {
    const headers = headersWith('sid=1; Domain=other.example.test');
    dropParentDomainCookies(headers, 'my-app.example.test');
    expect(headers.getSetCookie()).toEqual([]);
  });

  it('uses the last Domain attribute, as browsers do', () => {
    const headers = headersWith('sid=1; Domain=my-app.example.test; Domain=example.test');
    dropParentDomainCookies(headers, 'my-app.example.test');
    expect(headers.getSetCookie()).toEqual([]);
  });

  it('leaves the headers alone when no cookie names a parent domain', () => {
    const headers = headersWith('a=1', 'b=2; Domain=my-app.example.test');
    dropParentDomainCookies(headers, 'my-app.example.test');
    expect(headers.getSetCookie()).toEqual(['a=1', 'b=2; Domain=my-app.example.test']);
  });
});
