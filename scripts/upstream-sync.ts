#!/usr/bin/env node
// Decision: Brings new upstream Void commits into this fork, one commit at a time.
//
//   vp run upstream:sync status        fetch upstream and list commits since the last sync
//   vp run upstream:sync apply <sha>   merge one upstream commit, renamed to our names, file by file
//   vp run upstream:sync mark <sha>    record <sha> as the last synced upstream commit
//   vp run upstream:sync rename [text] show what the rename table turns text (or stdin) into
//
// The script does the mechanical part. Judgment (port or skip, conflict fixes, names the rename
// table misses) is left to whoever runs it, usually an agent following
// .agents/skills/upstream-sync/SKILL.md.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stripComments } from './comments.ts';

const UPSTREAM_URL = 'https://github.com/voidzero-dev/void';
const UPSTREAM_REMOTE = 'upstream';
const UPSTREAM_BRANCH = 'main';
const STATE_FILE = 'UPSTREAM';
const WORK_DIR = '.git/upstream-sync';

const pathRenames: Array<[RegExp, string]> = [
  [/^packages\/void\//, 'packages/bwf/'],
  [/^packages\/create-void\//, 'packages/create-bwf/'],
  [/(^|\/)void\.config\.ts$/, '$1bwf.config.ts'],
];

// Decision: Applied to upstream contents before merging. Order matters: specific names come before general
// ones. Bare `void` is left alone because it's a TypeScript keyword.
const textRenames: Array<[RegExp, string]> = [
  [/@voidcloud\//g, '@platform-service/'],
  [/@void\//g, '@builtbyfriends/'],
  [/(['"])void(\/[\w./-]+)\1/g, '$1@builtbyfriends/bwf$2$1'],
  [/(from |import\(|resolve\()(['"])void\2/g, '$1$2@builtbyfriends/bwf$2'],
  [/(['"])void\1/g, '$1bwf$1'],
  [/(['"])void > /g, '$1@builtbyfriends/bwf > '],
  [/\bvoid\/(?=[a-z_])/g, 'bwf/'],
  [/\bruntime\/env\/runtime\.ts\b/g, 'runtime/env.ts'],
  [/\bvirtual:void-/g, 'virtual:platform-'],
  [/\bvirtual:void\b/g, 'virtual:bwf'],
  [/(['"`])void-/g, '$1platform-'],
  [/(['"`])void (?=[a-z])/g, '$1bwf '],
  [/\.void-wrangler\b/g, '.bwf-wrangler'],
  [/\bvoid\.(json|lock\.json)\b/g, 'bwf.$1'],
  [/\bpackages\/void\b/g, 'packages/bwf'],
  [/\bcreate-void\b/g, 'create-bwf'],
  [/\b__VOID_/g, '__PLATFORM_'],
  [/\bVOID_PLATFORM_/g, 'PLATFORM_'],
  [/\bVOID_ACCESS_/g, 'PLATFORM_ACCESS_'],
  [/\bVOID_/g, 'BWF_'],
  [/\bx-void-/g, 'x-platform-'],
  [/\bX-Void-Platform-/g, 'X-Platform-'],
  [/\bX-Void-/g, 'X-Platform-'],
  [/\/__void\//g, '/__platform/'],
  [/\b__void/g, '__platform'],
  [/\bvoid\.config\b/g, 'bwf.config'],
  [/(^|[^\w.])\.void\//g, '$1.bwf/'],
  [/'\.void'/g, "'.bwf'"],
  [/\bvoid([A-Z])/g, 'bwf$1'],
  [/\bVoid(?!Zero)([A-Z])/g, 'Bwf$1'],
  [/([a-z])Void([A-Z])/g, '$1Bwf$2'],
  [/\bVoid\b/g, 'bwf'],
];

function git(args: Array<string>, input?: string): string {
  return execFileSync('git', args, { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
}

function tryGit(args: Array<string>): { ok: boolean; output: string } {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}`.trim() };
}

function lastSynced(): string {
  const match = readFileSync(STATE_FILE, 'utf8').match(/^commit\s+([0-9a-f]{7,40})/m);
  if (!match) {
    throw new Error(`${STATE_FILE} has no "commit <sha>" line`);
  }
  return match[1];
}

function fetchUpstream(): void {
  if (!tryGit(['remote', 'get-url', UPSTREAM_REMOTE]).ok) {
    git(['remote', 'add', UPSTREAM_REMOTE, UPSTREAM_URL]);
  }
  git(['fetch', '--quiet', UPSTREAM_REMOTE, UPSTREAM_BRANCH]);
}

// Decision: The fork keeps the runtime as flat files where upstream moved it into folders
// (runtime/routing/index.ts is runtime/routing.ts here, runtime/ws/room.ts is runtime/ws-room.ts,
// runtime/env/runtime.ts is runtime/env.ts). The flat name is used when only it exists here.
function flatRuntimePath(path: string): string | undefined {
  const match = path.match(/^(.*\/src\/runtime\/)([\w-]+)\/([\w-]+)\.(tsx?)$/);
  if (!match) {
    return undefined;
  }
  const [, dir, folder, file, ext] = match;
  const candidates = [
    file === 'index' || file === 'runtime' ? `${dir}${folder}.${ext}` : undefined,
    `${dir}${folder}-${file}.${ext}`,
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

function renamePath(path: string): string {
  const renamed = pathRenames.reduce((value, [from, to]) => value.replace(from, to), path);
  return existsSync(renamed) ? renamed : (flatRuntimePath(renamed) ?? renamed);
}

function renameText(line: string): string {
  return textRenames.reduce((value, [from, to]) => value.replace(from, to), line);
}

function packageRoot(path: string): string | null {
  const parts = path.split('/');
  if (['packages', 'playground'].includes(parts[0]) && parts.length > 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  if (parts[0] === 'platform' && parts[1] === 'packages' && parts.length > 3) {
    return parts.slice(0, 3).join('/');
  }
  return null;
}

// Decision: A package folder this fork doesn't have was removed here on purpose, unless the commit
// adds the package's own package.json. Then upstream is starting a new package, and it needs a look.
function newPackageRoots(added: Iterable<string>): Set<string> {
  const roots = new Set<string>();
  for (const path of added) {
    const root = packageRoot(path);
    if (root !== null && path === `${root}/package.json` && !existsSync(root)) {
      roots.add(root);
    }
  }
  return roots;
}

function isRemovedHere(path: string, newPackages: Set<string>): boolean {
  const root = packageRoot(path);
  return root !== null && !newPackages.has(root) && !existsSync(root);
}

// Decision: Used by status only: a file upstream changed that this fork doesn't have was most likely
// removed here on purpose, along with its feature.
function isGoneHere(path: string, added: Set<string>): boolean {
  return isRemovedHere(path, newPackageRoots(added)) || (!added.has(path) && !existsSync(path));
}

function classify(files: Array<string>, added: Set<string>): string {
  const mapped = files.map(renamePath);
  const gone = (file: string) => isGoneHere(file, added);
  const newPackages = [...newPackageRoots(added)];
  if (newPackages.length > 0) {
    return `review: adds a package this fork doesn't have (${newPackages.join(', ')})`;
  }
  if (mapped.every(gone)) {
    return "skip: only touches code this fork doesn't have";
  }
  const isTooling = (file: string) =>
    /(^|\/)(test|tests|__tests__|fixtures)\//.test(file) ||
    /\.test\.[cm]?[jt]sx?$/.test(file) ||
    /^(\.github|scripts)\//.test(file) ||
    /^(TESTING\.md|vite\.config\.ts)$/.test(file) ||
    /(^|\/)(vite|vitest)\.config\.[cm]?ts$/.test(file);
  if (mapped.every((file) => gone(file) || isTooling(file))) {
    return 'tooling: tests or CI only';
  }
  return 'review';
}

function status(): void {
  fetchUpstream();
  const base = lastSynced();
  const shas = git(['rev-list', '--reverse', `${base}..${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`])
    .split('\n')
    .filter(Boolean);
  console.log(`Last synced: ${base}. New upstream commits: ${shas.length}.`);
  for (const sha of shas) {
    const subject = git(['log', '-1', '--format=%s', sha]).trim();
    const changes = git(['diff-tree', '--no-commit-id', '--name-status', '-r', sha])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'));
    const files = changes.map((change) => change.at(-1)!);
    const added = new Set(
      changes.filter(([code]) => code === 'A').map((change) => renamePath(change.at(-1)!)),
    );
    console.log(
      `\n${sha.slice(0, 9)}  ${subject}\n  ${classify(files, added)} (${files.length} files)`,
    );
    for (const file of files.slice(0, 12)) {
      const mapped = renamePath(file);
      const note = isGoneHere(mapped, added)
        ? '  [not in this fork]'
        : mapped === file
          ? ''
          : `  -> ${mapped}`;
      console.log(`    ${file}${note}`);
    }
    if (files.length > 12) {
      console.log(`    ... and ${files.length - 12} more`);
    }
  }
}

// Decision: upstream code comes with comments, which the bwf/no-comments lint rule bans. Stripping
// them from both the upstream base and the upstream change keeps the three-way merge clean: only
// real code differences, and our own Decision: records, show up against our files.
function upstreamText(sha: string, path: string): string {
  return stripComments(renamePath(path), renameText(git(['show', `${sha}:${path}`])));
}

// Decision: Three-way merge per file: the base is the upstream file before the commit and "theirs" is the
// file after it, both put through the rename table. Both sides carry our names, so only real
// differences between the fork and upstream show up as conflicts.
function apply(sha: string): void {
  const full = git(['rev-parse', sha]).trim();
  const changes = git([
    'diff-tree',
    '-r',
    '-M',
    '--no-commit-id',
    '--name-status',
    `${full}^`,
    full,
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
  const binary = new Set(
    git(['diff-tree', '-r', '-M', '--no-commit-id', '--numstat', `${full}^`, full])
      .split('\n')
      .filter((line) => line.startsWith('-\t-\t'))
      .map((line) => line.split('\t').at(-1)),
  );
  const newPackages = newPackageRoots(
    changes.filter(([code]) => code === 'A').map((change) => renamePath(change.at(-1)!)),
  );
  const tmp = `${WORK_DIR}/${full.slice(0, 9)}`;
  mkdirSync(tmp, { recursive: true });
  const report: Record<string, Array<string>> = {
    applied: [],
    conflicts: [],
    'left out (removed here, or the lockfile)': [],
    'needs a hand port': [],
  };

  for (const [statusCode, ...paths] of changes) {
    const kind = statusCode[0];
    const before = paths[0];
    const after = paths.at(-1)!;
    const oursBefore = renamePath(before);
    const ours = renamePath(after);
    if (
      (isRemovedHere(oursBefore, newPackages) && isRemovedHere(ours, newPackages)) ||
      ours === 'pnpm-lock.yaml'
    ) {
      report['left out (removed here, or the lockfile)'].push(after);
      continue;
    }
    if (binary.has(after)) {
      report['needs a hand port'].push(`${after}: binary file`);
      continue;
    }
    if (kind === 'D') {
      if (existsSync(ours) && readFileSync(ours, 'utf8') === upstreamText(`${full}^`, before)) {
        git(['rm', '--quiet', ours]);
        report.applied.push(`${ours} (deleted)`);
      } else if (existsSync(ours)) {
        report['needs a hand port'].push(`${ours}: deleted upstream but changed here`);
      }
      continue;
    }
    const theirs = upstreamText(full, after);
    if (kind === 'A' && !existsSync(ours)) {
      mkdirSync(ours.split('/').slice(0, -1).join('/') || '.', { recursive: true });
      writeFileSync(ours, theirs);
      report.applied.push(`${ours} (new)`);
      continue;
    }
    if (kind === 'R' && oursBefore !== ours && existsSync(oursBefore) && !existsSync(ours)) {
      mkdirSync(ours.split('/').slice(0, -1).join('/') || '.', { recursive: true });
      git(['mv', oursBefore, ours]);
    }
    if (!existsSync(ours)) {
      report['needs a hand port'].push(`${ours}: not in this fork (upstream ${after})`);
      continue;
    }
    const base = kind === 'A' ? '' : upstreamText(`${full}^`, before);
    writeFileSync(`${tmp}/base`, base);
    writeFileSync(`${tmp}/theirs`, theirs);
    const merged = spawnSync(
      'git',
      [
        'merge-file',
        '--diff3',
        '-L',
        'ours',
        '-L',
        'upstream base',
        '-L',
        'upstream',
        ours,
        `${tmp}/base`,
        `${tmp}/theirs`,
      ],
      { encoding: 'utf8' },
    );
    if (merged.status === 0) {
      report.applied.push(ours);
    } else if (merged.status !== null && merged.status > 0) {
      report.conflicts.push(`${ours} (${merged.status} conflict${merged.status === 1 ? '' : 's'})`);
    } else {
      report['needs a hand port'].push(`${ours}: git merge-file failed: ${merged.stderr.trim()}`);
    }
  }

  const subject = git(['log', '-1', '--format=%s', full]).trim();
  console.log(`${full.slice(0, 9)}  ${subject}`);
  for (const [label, files] of Object.entries(report)) {
    if (files.length) {
      console.log(`\n${label}:\n  ${files.join('\n  ')}`);
    }
  }
  if (report.conflicts.length || report['needs a hand port'].length) {
    console.log(
      '\nFix the conflict markers (ours | upstream base | upstream) and the files above.',
    );
    process.exitCode = 2;
  }
}

function mark(sha: string): void {
  const full = git(['rev-parse', sha]).trim();
  const subject = git(['log', '-1', '--format=%s', full]).trim();
  writeFileSync(
    STATE_FILE,
    `# Last upstream Void commit this fork has reviewed. scripts/upstream-sync.ts reads it.\n` +
      `upstream ${UPSTREAM_URL} ${UPSTREAM_BRANCH}\ncommit ${full}\nsubject ${subject}\n`,
  );
  console.log(`${STATE_FILE} now points at ${full.slice(0, 9)}.`);
}

const [command, arg] = process.argv.slice(2);
if (command === 'status') {
  status();
} else if (command === 'apply' && arg) {
  apply(arg);
} else if (command === 'mark' && arg) {
  mark(arg);
} else if (command === 'rename') {
  const input = arg ?? readFileSync(0, 'utf8');
  console.log(input.split('\n').map(renameText).join('\n'));
} else {
  console.log('Usage: vp run upstream:sync status | apply <sha> | mark <sha> | rename [text]');
  process.exitCode = 1;
}
