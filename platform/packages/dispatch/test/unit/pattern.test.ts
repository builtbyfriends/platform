import { describe, it, expect } from 'vite-plus/test';
import {
  compilePattern,
  matchLiteralPattern,
  matchPattern,
  matchPatternCaptures,
  substituteParams,
} from '../../src/pattern.ts';

describe('matchPattern', () => {
  it('matches exact path', () => {
    expect(matchPattern('/index.html', '/index.html')).toBe(true);
  });

  it('rejects non-matching exact path', () => {
    expect(matchPattern('/index.html', '/about.html')).toBe(false);
  });

  it('matches wildcard at end', () => {
    expect(matchPattern('/assets/*', '/assets/app.js')).toBe(true);
  });

  it('matches wildcard across slashes', () => {
    expect(matchPattern('/assets/*', '/assets/js/app.js')).toBe(true);
  });

  it('matches leading wildcard extension', () => {
    expect(matchPattern('/*.html', '/index.html')).toBe(true);
  });

  it('rejects wildcard extension mismatch', () => {
    expect(matchPattern('/*.html', '/app.js')).toBe(false);
  });

  it('matches catch-all wildcard', () => {
    expect(matchPattern('/*', '/any/path/here')).toBe(true);
  });

  it('matches root with catch-all', () => {
    expect(matchPattern('/*', '/')).toBe(true);
  });

  it('matches path with special regex chars', () => {
    expect(matchPattern('/foo.bar', '/foo.bar')).toBe(true);
  });

  it('rejects dot as regex wildcard', () => {
    expect(matchPattern('/foo.html', '/fooXhtml')).toBe(false);
  });
});

describe('compilePattern', () => {
  it('captures :name as single path segment', () => {
    expect(compilePattern('/blog/:slug').paramNames).toEqual(['slug']);
    expect(matchPatternCaptures('/blog/:slug', '/blog/hello')).toEqual({ slug: 'hello' });
    expect(matchPatternCaptures('/blog/:slug', '/blog/hello/world')).toBeNull();
  });

  it('captures :name* as zero-or-more segments', () => {
    expect(compilePattern('/docs/:path*').paramNames).toEqual(['path']);
    expect(matchPatternCaptures('/docs/:path*', '/docs/a/b/c')).toEqual({ path: 'a/b/c' });
    expect(matchPatternCaptures('/docs/:path*', '/docs/')).toEqual({ path: '' });
  });

  it('captures legacy * as splat', () => {
    expect(compilePattern('/assets/*').paramNames).toEqual(['splat']);
    expect(matchPatternCaptures('/assets/*', '/assets/js/app.js')).toEqual({ splat: 'js/app.js' });
  });

  it('captures middle * as only what actually matched, not prefix-slice', () => {
    expect(matchPatternCaptures('/blog/*/edit', '/blog/hello/edit')).toEqual({ splat: 'hello' });
    expect(matchPatternCaptures('/blog/*/edit', '/blog/a/b/edit')).toEqual({ splat: 'a/b' });
    expect(matchPatternCaptures('/blog/*/edit', '/blog/hello')).toBeNull();
  });

  it('matches legacy patterns with multiple anonymous wildcards', () => {
    expect(compilePattern('/a/*/b/*').paramNames).toEqual(['splat']);
    expect(matchPattern('/a/*/b/*', '/a/x/b/y')).toBe(true);
    expect(matchPattern('/a/*/b/*', '/a/x/c/y')).toBe(false);
  });

  it('captures multiple named params in one pattern', () => {
    expect(compilePattern('/blog/:author/:slug').paramNames).toEqual(['author', 'slug']);
    expect(matchPatternCaptures('/blog/:author/:slug', '/blog/alice/hello')).toEqual({
      author: 'alice',
      slug: 'hello',
    });
    expect(matchPatternCaptures('/blog/:author/:slug', '/blog/alice/hello/world')).toBeNull();
  });

  it('escapes regex-special characters in literals', () => {
    expect(matchPattern('/foo.html', '/foo.html')).toBe(true);
    expect(matchPattern('/foo.html', '/fooXhtml')).toBe(false);
  });

  it('treats bare colon (no name chars after) as literal', () => {
    expect(compilePattern('/foo:/bar').paramNames).toEqual([]);
    expect(matchPattern('/foo:/bar', '/foo:/bar')).toBe(true);
    expect(matchPattern('/foo:/bar', '/fooX/bar')).toBe(false);
  });

  it('matchPattern supports legacy patterns with multiple anonymous wildcards', () => {
    expect(matchPattern('/a/*/b/*', '/a/x/b/y')).toBe(true);
    expect(matchPattern('/a/*/b/*', '/a/x/c/y')).toBe(false);
  });

  it('matchPatternCaptures returns the first legacy splat for multi-splat patterns', () => {
    expect(matchPatternCaptures('/a/*/b/*', '/a/x/b/y')).toEqual({ splat: 'x' });
  });

  it('returns cached CompiledPattern for repeated input', () => {
    const a = compilePattern('/cache-test/:id');
    const b = compilePattern('/cache-test/:id');
    expect(b).toBe(a);
  });
});

describe('matchPatternCaptures', () => {
  it('returns null when pattern does not match', () => {
    expect(matchPatternCaptures('/blog/:slug', '/articles/hello')).toBeNull();
  });

  it('returns captured groups on match', () => {
    expect(matchPatternCaptures('/blog/:author/:slug', '/blog/alice/hello')).toEqual({
      author: 'alice',
      slug: 'hello',
    });
  });

  it('returns empty object when pattern has no captures', () => {
    expect(matchPatternCaptures('/about', '/about')).toEqual({});
  });

  it('returns splat for legacy * pattern', () => {
    expect(matchPatternCaptures('/assets/*', '/assets/js/app.js')).toEqual({
      splat: 'js/app.js',
    });
  });
});

describe('matchLiteralPattern', () => {
  it('treats `:` as a literal character (no named capture)', () => {
    // Decision: `:health` would be a named capture in matchPattern, but the literal matcher keeps `:` literal.
    // Existing tenant header and revalidate configs may rely on that (`/api/v1:health`, `:batchGet`).
    expect(matchLiteralPattern('/api/v1:health', '/api/v1:health')).toBe(true);
    expect(matchLiteralPattern('/api/v1:health', '/api/v1foo')).toBe(false);
  });

  it('does NOT anchor a whole-segment `:name` — it stays a literal (regression guard)', () => {
    expect(matchLiteralPattern('/:batchGet', '/foo')).toBe(false);
    expect(matchLiteralPattern('/:batchGet', '/:batchGet')).toBe(true);
    expect(matchLiteralPattern('/blog/:slug', '/blog/hello')).toBe(false);
    expect(matchLiteralPattern('/blog/:slug', '/blog/:slug')).toBe(true);
  });

  it('keeps a mid-segment literal `:` a literal (Google custom-method form)', () => {
    expect(matchLiteralPattern('/api/v1:health', '/api/v1:health')).toBe(true);
    expect(matchLiteralPattern('/api/v1:health', '/api/v1anything')).toBe(false);
    expect(matchLiteralPattern('/api/v1:health', '/api/v1/health')).toBe(false);
    expect(matchLiteralPattern('/api/documents:batchGet', '/api/documents:batchGet')).toBe(true);
    expect(matchLiteralPattern('/api/documents:batchGet', '/api/documents')).toBe(false);
  });

  it('still expands `*` to match any characters including slashes', () => {
    expect(matchLiteralPattern('/assets/*', '/assets/js/app.js')).toBe(true);
    expect(matchLiteralPattern('/assets/*', '/other/file')).toBe(false);
    expect(matchLiteralPattern('/blog/*', '/blog/a/b')).toBe(true);
    expect(matchLiteralPattern('/blog/*', '/blog/hello')).toBe(true);
    expect(matchLiteralPattern('/*', '/')).toBe(true);
    expect(matchLiteralPattern('/*', '/x/y')).toBe(true);
  });
});

describe('regex-compatible details', () => {
  it('lets `*` stop at line terminators, while `:name` takes them', () => {
    expect(matchPatternCaptures('/*', '/a\nb')).toBeNull();
    expect(matchPatternCaptures('/:x', '/\n')).toEqual({ x: '\n' });
    expect(matchLiteralPattern('/*', '/a\u2028b')).toBe(false);
  });

  it('gives each wildcard, left to right, the longest text that still matches', () => {
    expect(matchPatternCaptures('/:a*/:b*', '/x/y/z')).toEqual({ a: 'x/y', b: 'z' });
    expect(matchPatternCaptures('/:a:b', '/xyz')).toEqual({ a: 'xy', b: 'z' });
    expect(matchPatternCaptures('/:a**', '/x/y')).toEqual({ a: 'x/y', splat: '' });
    expect(matchPatternCaptures('/*/static/*', '/a/static/b/static/c')).toEqual({
      splat: 'a/static/b',
    });
    expect(matchPatternCaptures('/u/:id*/files/*', '/u/files/files/x')).toEqual({
      id: 'files',
      splat: 'x',
    });
  });

  it('rejects a name that starts with a digit', () => {
    expect(() => compilePattern('/:1')).toThrow(/invalid capture group name/i);
    expect(() => compilePattern('/:2fa')).toThrow(/invalid capture group name/i);
    expect(matchPattern('/:1', '/x')).toBe(false);
    expect(matchPatternCaptures('/:1', '/x')).toBeNull();
    expect(matchPatternCaptures('/:id/:id', '/a/b')).toBeNull();
  });

  it('returns names as own keys of a null-prototype object', () => {
    const params = matchPatternCaptures('/:__proto__/:constructor', '/a/b')!;
    expect(Object.getPrototypeOf(params)).toBeNull();
    expect(Object.entries(params)).toEqual([
      ['__proto__', 'a'],
      ['constructor', 'b'],
    ]);
    expect(Object.getPrototypeOf(matchPatternCaptures('/old', '/old'))).toBeNull();
  });

  it('still offers the deprecated regex view', () => {
    const { regex } = compilePattern('/u/:id*/files/*');
    expect(regex.source).toBe(String.raw`^\/u\/(?<id>.*)\/files\/(?<splat>.*)$`);
    expect(regex.exec('/u/42/extra/files/a/b')?.groups).toEqual({ id: '42/extra', splat: 'a/b' });
  });
});

describe('large and adversarial patterns', () => {
  it('matches a pattern too long for a RegExp instead of throwing', () => {
    const big = '/' + 'a'.repeat(40_000);
    expect(matchLiteralPattern(big, big)).toBe(true);
    expect(matchPattern(big, big)).toBe(true);
    expect(matchPatternCaptures(big + '/:x', big + '/y')).toEqual({ x: 'y' });
    expect(matchPatternCaptures(big, '/foo')).toBeNull();
  });

  it('returns quickly for many wildcards on a long path that does not match', () => {
    // Decision: A backtracking matcher takes seconds or more on each of these.
    expect(matchLiteralPattern('/' + '*'.repeat(20) + 'x', '/' + 'a'.repeat(13) + '\nx')).toBe(
      false,
    );
    expect(
      matchLiteralPattern('/' + '*a'.repeat(40) + '\nb', '/' + 'a'.repeat(16_000) + 'x\nb'),
    ).toBe(false);
    const rest = '/' + Array.from({ length: 10 }, (_, i) => `:p${i}*`).join('/') + '/x';
    expect(matchPatternCaptures(rest, '/a'.repeat(40) + '\n/x')).toBeNull();
  });
});

describe('substituteParams', () => {
  it('substitutes :name tokens', () => {
    expect(substituteParams('/articles/:slug', { slug: 'hello' })).toBe('/articles/hello');
  });

  it('substitutes :name* tokens', () => {
    expect(substituteParams('/new/:path*', { path: 'a/b/c' })).toBe('/new/a/b/c');
  });

  it('substitutes :splat for legacy * destinations', () => {
    expect(substituteParams('/new/:splat', { splat: 'a/b' })).toBe('/new/a/b');
  });

  it('substitutes multiple tokens in one destination', () => {
    expect(substituteParams('/posts/:author/:slug', { author: 'alice', slug: 'hello' })).toBe(
      '/posts/alice/hello',
    );
  });

  it('leaves token untouched when param missing', () => {
    expect(substituteParams('/articles/:slug', {})).toBe('/articles/:slug');
  });

  it('leaves token untouched when :name* param missing', () => {
    expect(substituteParams('/new/:path*', {})).toBe('/new/:path*');
  });

  it('ignores extra params not referenced by destination', () => {
    expect(substituteParams('/articles/:slug', { slug: 'hi', extra: 'x' })).toBe('/articles/hi');
  });

  it('keeps a path destination on the same site when a capture starts with a slash', () => {
    expect(substituteParams('/:splat', { splat: '/evil.com' })).toBe('/evil.com');
    expect(substituteParams('/:splat', { splat: String.raw`\evil.com` })).toBe('/evil.com');
    expect(substituteParams(':splat', { splat: '//evil.com' })).toBe('/evil.com');
    expect(substituteParams('/:path*', { path: '//evil.com/x' })).toBe('/evil.com/x');
  });

  it('leaves protocol-relative, absolute and prefixed destinations unchanged', () => {
    expect(substituteParams('//cdn.example.com/:splat', { splat: 'a' })).toBe(
      '//cdn.example.com/a',
    );
    expect(substituteParams('https://x.com/:splat', { splat: '/a' })).toBe('https://x.com//a');
    expect(substituteParams('/posts/:splat', { splat: '/x' })).toBe('/posts//x');
  });
});
