import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path/posix';
import { test } from 'node:test';
import { inspectPackage, isGithubPackagesName, isReleaseCohortName } from './packed-registry.mjs';

function createPackage(t, overrides = {}, includeLicense = true) {
  const root = mkdtempSync(join(tmpdir(), 'platform-packed-metadata-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'package');
  mkdirSync(directory);
  const manifest = {
    name: '@builtbyfriends/test',
    version: '0.0.0',
    description: 'A bwf test package.',
    license: 'MIT',
    homepage: 'https://github.com/builtbyfriends/platform',
    bugs: { url: 'https://github.com/voidzero-dev/void/issues' },
    exports: './index.mjs',
    ...overrides,
  };
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, 'index.mjs'), 'export {};\n');
  if (includeLicense) {
    writeFileSync(join(directory, 'LICENSE'), 'MIT License\n');
  }
  const tarball = join(root, 'package.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', root, 'package']);
  return tarball;
}

test('accepts complete metadata and license in a real package tarball', (t) => {
  const inspected = inspectPackage(createPackage(t));
  assert.equal(inspected.manifest.name, '@builtbyfriends/test');
  assert.match(inspected.integrity, /^sha512-/);
});

for (const [field, error] of [
  ['description', /missing package description/],
  ['license', /package license must be MIT/],
  ['homepage', /homepage must be an HTTPS URL/],
  ['bugs', /bugs.url must be an HTTPS URL/],
]) {
  test(`rejects a packed manifest missing ${field}`, (t) => {
    assert.throws(() => inspectPackage(createPackage(t, { [field]: undefined })), error);
  });
}

test('rejects blank descriptions and invalid package links', (t) => {
  for (const overrides of [
    { description: '  ' },
    { homepage: 'void.cloud' },
    { homepage: 'http://void.cloud' },
    { bugs: { url: 'not a URL' } },
  ]) {
    assert.throws(() => inspectPackage(createPackage(t, overrides)));
  }
});

test('requires the license file as well as its manifest field', (t) => {
  assert.throws(() => inspectPackage(createPackage(t, {}, false)), /missing packaged LICENSE/);
});

test("keeps this repository's release names inside the packed cohort", () => {
  for (const name of [
    'bwf',
    'bwf/package.json',
    'create-bwf',
    '@builtbyfriends/create-bwf',
    '@builtbyfriends/bwf',
    '@builtbyfriends/deploy-core',
    '@builtbyfriends/edge/package.json',
  ]) {
    assert.equal(isReleaseCohortName(name), true, name);
  }
  for (const name of [
    '@builtbyfriends/realtime',
    '@builtbyfriends/realtime-http',
    '@builtbyfriends/realtime-mcp',
    'bwf-other',
    'vite',
    '@cloudflare/workers-types',
  ]) {
    assert.equal(isReleaseCohortName(name), false, name);
  }
});

test('reads the Realtime packages from GitHub Packages and the rest from npm', () => {
  for (const name of [
    '@builtbyfriends/realtime',
    '@builtbyfriends/realtime-http',
    '@builtbyfriends/realtime-mcp',
  ]) {
    assert.equal(isGithubPackagesName(name), true, name);
  }
  for (const name of [
    '@builtbyfriends/bwf',
    '@builtbyfriends/create-bwf',
    'bwf',
    'vite',
    '@cloudflare/workers-types',
  ]) {
    assert.equal(isGithubPackagesName(name), false, name);
  }
});
