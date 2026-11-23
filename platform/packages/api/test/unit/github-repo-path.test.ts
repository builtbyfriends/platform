import { describe, expect, it } from 'vite-plus/test';
import { githubRepoApiTarget } from '../../src/github/repo-path.ts';

describe('githubRepoApiTarget', () => {
  it.each([
    ['/repos/Acme/Widgets', 'acme/widgets'],
    ['/repos/acme/widgets/pulls?state=open&per_page=5', 'acme/widgets'],
    ['/repos/acme/widgets/contents/docs/caf%C3%A9.md', 'acme/widgets'],
    ['/repos/acme/widgets/git/ref/heads%2Fmain', 'acme/widgets'],
  ])('takes %s', (path, repository) => {
    expect(githubRepoApiTarget(path)).toEqual({
      url: `https://api.github.com${path}`,
      repository,
    });
  });

  it.each([
    undefined,
    7,
    '',
    '/user',
    '/repos/acme',
    '/repos//x/y',
    '/repos/acme/widgets/../../user',
    '/repos/acme/widgets/%2e%2e/%2e%2e/user',
    '/repos/acme/widgets/%2E./%2e%2E/orgs/acme/repos',
    '/repos/acme/%2e%2e/other/repo',
    '/repos/acme/widgets/./pulls',
    '/repos/acme/widgets\\..\\x',
    '/repos/acme/widgets/pulls#x',
    '/repos/acme/widgets/a b',
    'https://evil.test/repos/a/b',
    '//evil.test/repos/a/b',
  ])('refuses %s', (path) => {
    expect(githubRepoApiTarget(path)).toBeNull();
  });
});
