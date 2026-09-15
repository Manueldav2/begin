#!/usr/bin/env node
// begin/refresh.mjs — keeps BEGIN.md honest as the code moves underneath it.
//
// DESIGN RULE: this never edits a tracked file. A hook that rewrites BEGIN.md
// on commit fights the working tree, dirties every checkout, and eventually
// clobbers a human edit. Instead it recomputes the machine layer and writes
// .begin/stale.md — a list of which prose sections the code has outrun.
// Prose is rewritten by the agent on the next `/begin update`, as a normal edit
// the user reviews and commits.
//
// Usage: node refresh.mjs [--root DIR] [--quiet]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const QUIET = argv.includes('--quiet');

const ROOT = path.resolve(arg('root', process.cwd()));
const git = (args) => {
  try {
    return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch { return ''; }
};

const OUT_DIR = path.join(ROOT, '.begin');
fs.mkdirSync(OUT_DIR, { recursive: true });

// 1. machine layer always regenerates — it is cheap and never wrong-by-staleness
try {
  execFileSync('node', [path.join(HERE, 'scan.mjs'), '--root', ROOT, '--json-only'], { stdio: ['ignore', 'ignore', 'ignore'] });
} catch { /* scan failure must not break a commit */ }

const BEGIN_MD = path.join(ROOT, 'BEGIN.md');
const head = git(['rev-parse', 'HEAD']).trim();

if (!fs.existsSync(BEGIN_MD)) {
  fs.writeFileSync(path.join(OUT_DIR, 'stale.md'),
    `# begin: staleness\n\nNo \`BEGIN.md\` in this repo yet. Run \`/begin\` to write one.\n`);
  if (!QUIET) console.log('begin: no BEGIN.md yet — run /begin');
  process.exit(0);
}

const doc = fs.readFileSync(BEGIN_MD, 'utf8');

// <!-- begin:section id="x" sha="abc1234" files="a.ts,b/**" -->
const STAMP = /<!--\s*begin:section\s+([^>]*?)-->/g;
const attr = (s, k) => (s.match(new RegExp(`${k}="([^"]*)"`)) || [])[1] || '';

const sections = [];
let m;
while ((m = STAMP.exec(doc))) {
  const a = m[1];
  sections.push({
    id: attr(a, 'id') || `unnamed@${m.index}`,
    sha: attr(a, 'sha'),
    files: attr(a, 'files').split(',').map((s) => s.trim()).filter(Boolean),
  });
}

const lines = [];
lines.push('# begin: staleness');
lines.push('');
lines.push(`_checked ${new Date().toISOString()} · HEAD \`${head.slice(0, 9)}\` · ${sections.length} stamped section(s)_`);
lines.push('');

if (sections.length === 0) {
  lines.push('`BEGIN.md` carries no `<!-- begin:section ... -->` stamps, so staleness cannot be');
  lines.push('computed. Re-run `/begin` so each section records the commit and files it was derived from.');
  fs.writeFileSync(path.join(OUT_DIR, 'stale.md'), lines.join('\n') + '\n');
  if (!QUIET) console.log('begin: BEGIN.md has no section stamps — run /begin update');
  process.exit(0);
}

const stale = [];
const unknown = [];
let checked = 0;

for (const s of sections) {
  if (!s.sha) { unknown.push({ ...s, why: 'no sha recorded' }); continue; }
  const exists = git(['rev-parse', '--verify', `${s.sha}^{commit}`]).trim();
  if (!exists) { unknown.push({ ...s, why: `commit ${s.sha} is not in this repo (rebased or squashed)` }); continue; }
  // A section with no files= has nothing to diff, so it can never go stale —
  // it would sit there reporting itself healthy forever. Unverifiable is not
  // the same as verified.
  // `files="-"` is an explicit declaration that a section is not derived from
  // code (a glossary, the unverified-assumptions list). Those are exempt; a
  // section that merely FORGOT files= is not, and is reported.
  if (s.files.length === 1 && s.files[0] === '-') continue;
  if (!s.files.length) { unknown.push({ ...s, why: 'no files= recorded — there is nothing to diff against (use files="-" if it is deliberately not code-derived)' }); continue; }
  // Likewise a files= that matches no path at either end: a typo'd filename
  // produces an empty diff, which is indistinguishable from "unchanged".
  // PER PATH, not "all paths". Checking the whole list at once meant a single
  // valid entry masked any number of typos beside it — the likely shape of the
  // bug, not the all-bogus case that was originally tested.
  const bogus = s.files.filter((f) => {
    if (f.includes('*')) return false;                 // globs are checked by the diff itself
    return !git(['ls-tree', '-r', '--name-only', head, '--', f]).trim()
        && !git(['ls-tree', '-r', '--name-only', s.sha, '--', f]).trim();
  });
  if (bogus.length) {
    unknown.push({ ...s, why: `files= names ${bogus.length} path(s) that exist at neither ${s.sha} nor HEAD: ${bogus.join(', ')}` });
    continue;
  }
  checked++;
  if (s.sha.startsWith(head.slice(0, s.sha.length))) continue; // same commit
  const changed = git(['diff', '--name-only', `${s.sha}..HEAD`, '--', ...s.files]).split('\n').filter(Boolean);
  if (changed.length) {
    const commits = git(['log', '--oneline', `${s.sha}..HEAD`, '--', ...s.files]).split('\n').filter(Boolean);
    stale.push({ ...s, changed, commits });
  }
}

// Source files that NO section claims.
//
// This used to diff `newestStamp..HEAD`, which quietly destroyed itself: the
// moment you re-stamp any one section to HEAD — and SKILL.md tells you to
// re-stamp the "where you left off" section most often — the window becomes
// empty and genuinely unclaimed files stop being reported forever. Comparing
// the claimed set against the current tracked source set has no such window.
const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|vue|svelte|py|go|rb|rs|java|kt|swift|php|cs)$/;
const SKIP_RE = /(^|\/)(node_modules|dist|build|out|\.next|vendor|__pycache__|coverage|\.begin)(\/|$)/;
const claimed = new Set(sections.flatMap((s) => s.files));
const claimedDirs = [...claimed].filter((c) => c.includes('*')).map((c) => c.split('*')[0]);
const trackedNow = git(['ls-files', '-z']).split('\0').filter(Boolean);
const uncovered = trackedNow.filter((f) =>
  CODE_RE.test(f) && !SKIP_RE.test(f) && !/\.(test|spec)\./.test(f) &&
  !claimed.has(f) && !claimedDirs.some((d) => d && f.startsWith(d)));

if (stale.length) {
  lines.push(`## ${stale.length} section${stale.length > 1 ? 's' : ''} the code has outrun`);
  lines.push('');
  for (const s of stale) {
    lines.push(`### \`${s.id}\` — derived at \`${s.sha}\`, now \`${head.slice(0, 9)}\``);
    lines.push('');
    lines.push(`Changed since: ${s.changed.map((f) => `\`${f}\``).join(', ')}`);
    lines.push('');
    for (const c of s.commits.slice(0, 8)) lines.push(`- ${c}`);
    lines.push('');
  }
} else {
  lines.push(`## All ${checked} checkable section${checked === 1 ? '' : 's'} are current`);
  lines.push('');
}

if (uncovered.length) {
  // On a large repo "862 files no section claims" is guaranteed noise that
  // buries the real signal. Report the count, but list only files that arrived
  // AFTER the oldest stamp — those are the ones a section plausibly should have
  // picked up.
  const oldest = sections.map((s) => s.sha).filter(Boolean)
    .map((sha) => ({ sha, t: +git(['show', '-s', '--format=%ct', sha]).trim() || Infinity }))
    .sort((a, b) => a.t - b.t)[0];
  const recent = oldest && Number.isFinite(oldest.t)
    ? new Set(git(['diff', '--name-only', '--diff-filter=A', `${oldest.sha}..HEAD`]).split('\n').filter(Boolean))
    : null;
  const newOnes = recent ? uncovered.filter((f) => recent.has(f)) : uncovered;
  lines.push(`## ${uncovered.length} source file(s) no section claims${newOnes.length !== uncovered.length ? `, ${newOnes.length} of them added since the oldest stamp` : ''}`);
  lines.push('');
  const show = (newOnes.length ? newOnes : uncovered).slice(0, 20);
  lines.push(show.map((f) => `- \`${f}\``).join('\n'));
  const total = newOnes.length || uncovered.length;
  if (total > 20) lines.push(`- _…and ${total - 20} more_`);
  if (!newOnes.length && uncovered.length > 20) lines.push('');
  if (uncovered.length > 100 && newOnes.length === uncovered.length) {
    lines.push('');
    lines.push('_A very large count usually means BEGIN.md covers a few subsystems rather than the whole repo. That is fine — it is a map, not an index._');
  }
  lines.push('');
}

if (unknown.length) {
  lines.push('## Sections that cannot be checked');
  lines.push('');
  for (const u of unknown) lines.push(`- \`${u.id}\` — ${u.why}`);
  lines.push('');
}

const stalePath = path.join(OUT_DIR, 'stale.md');
const tmpPath = `${stalePath}.${process.pid}.tmp`;
fs.writeFileSync(tmpPath, lines.join('\n') + '\n');
fs.renameSync(tmpPath, stalePath);   // atomic: the hook can race a manual run

const n = stale.length + uncovered.length;
if (!QUIET || n > 0) {
  console.log(n === 0
    ? 'begin: BEGIN.md is current'
    : `begin: ${stale.length} stale section${stale.length === 1 ? '' : 's'}${uncovered.length ? `, ${uncovered.length} unclaimed new file${uncovered.length === 1 ? '' : 's'}` : ''} — run /begin update (see .begin/stale.md)`);
}
process.exit(0);
