import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SNAPSHOT_NPM_TAG = 'snapshot';

export function snapshotVersion(
  base: string,
  change: string,
  sha: string,
  baseIsReleased = false,
): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(base);
  if (!match) {
    throw new Error(`${base} is not a version to build a snapshot from.`);
  }
  const [major, minor, patch] = match.slice(1).map(Number);
  const release = `${major}.${minor}.${baseIsReleased ? patch + 1 : patch}`;
  if (!/^[a-z0-9]+$/.test(change) || /^0\d/.test(change)) {
    throw new Error(`${change} is not a pull request number or a plain label.`);
  }
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new Error(`${sha} is not a commit id.`);
  }
  return `${release}-snap.${change}.g${sha.slice(0, 7)}`;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = new URL('../../packages/', import.meta.url);
  const manifests = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => new URL(`${encodeURIComponent(name)}/package.json`, root))
    .map((url) => ({ url, manifest: JSON.parse(readFileSync(url, 'utf8')) }))
    .filter(({ manifest }) => !manifest.private);
  const bwf = manifests.find(({ manifest }) => manifest.name === '@builtbyfriends/bwf');
  if (!bwf) {
    throw new Error('The snapshot must include the public @builtbyfriends/bwf package.');
  }
  const version = snapshotVersion(
    bwf.manifest.version,
    process.env.SNAPSHOT_CHANGE ?? '',
    process.env.SNAPSHOT_SHA ?? '',
    execFileSync('git', ['tag', '--list', `v${bwf.manifest.version}`], {
      encoding: 'utf8',
    }).trim() !== '',
  );
  for (const { url, manifest } of manifests) {
    writeFileSync(url, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nnpm-tag=${SNAPSHOT_NPM_TAG}\n`);
  }
  console.log(
    `Snapshot ${version} for ${manifests.length} packages; npm tag: ${SNAPSHOT_NPM_TAG}.`,
  );
}
