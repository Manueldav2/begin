#!/usr/bin/env node
// begin/scan.mjs — dependency-free structural scan of a git repo.
//
// Emits .begin/scan.json (full) and .begin/scan.md (digest) containing, per file:
//   importance (PageRank over the import graph), churn (git), complexity proxy,
//   surface role, and shortest path from a user-facing surface.
//
// Everything here is DERIVED, never recalled. If a number is a proxy it is
// named a proxy in the output.
//
// Usage: node scan.mjs [--root <dir>] [--since <git date>] [--author <pat>]
//                      [--top <n>] [--json-only]

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);

let ROOT = path.resolve(arg('root', process.cwd()));
const SINCE = arg('since', '90 days ago');   // must match recon.sh's default
const TOP = Number.isFinite(parseInt(arg('top', '25'), 10)) ? parseInt(arg('top', '25'), 10) : 25;
const EXCLUDE = (arg('exclude', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

// Reading fully is better than skipping: the biggest files in a repo are often
// the ones with the most commits. Above the cap we still read the head for
// imports and surfaces and still count churn — the record is marked `partial`,
// never dropped.
const FULL_BYTES = 2 * 1024 * 1024;
const HEAD_BYTES = 512 * 1024;
const MAX_FILES = 20000;

const gitRaw = (cwd, args) => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return ''; }
};
// Scanning a subdirectory silently produces a partial graph and writes a stray
// .begin/ there. Always anchor on the repo root.
{
  const top = gitRaw(ROOT, ['rev-parse', '--show-toplevel']).trim();
  if (top && path.resolve(top) !== ROOT) {
    console.error(`begin: anchoring to repo root ${top} (was ${ROOT})`);
    ROOT = path.resolve(top);
  }
}
const OUT_DIR = path.join(ROOT, '.begin');

// Default the author filter to this repo's own identity, then to its most
// prolific committer, so "what have I been working on" is never silently empty.
let AUTHOR = arg('author', '');
if (!AUTHOR) AUTHOR = (gitRaw(ROOT, ['config', 'user.name']) || '').trim();

const git = (args, opts = {}) => {
  try {
    // core.quotepath=false: without it `git log --name-only` emits non-ASCII
    // paths octal-escaped and quoted ("src/caf\303\251.ts"), which never match
    // the raw paths from `ls-files -z` — so those files silently get churn 0.
    return execFileSync('git', ['-C', ROOT, '-c', 'core.quotepath=false', ...args], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      ...opts,
    });
  } catch {
    return '';
  }
};

// ---------------------------------------------------------------- files

const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.vue', '.svelte', '.py', '.go', '.rb', '.rs', '.java', '.kt',
  '.swift', '.php', '.cs', '.c', '.h', '.cc', '.cpp', '.hpp',
  '.sql', '.html', '.css', '.scss',
]);
const SKIP_DIR = /(^|\/)(node_modules|dist|build|out|\.next|\.turbo|vendor|__pycache__|\.venv|coverage|\.git|target|Pods|\.begin)(\/|$)/;

const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
if (tracked.length === 0) {
  // Three different situations that used to share one misleading message. A
  // freshly `git init`'d project being told "not a git repo" is the first thing
  // a new user sees, and it is false.
  const isRepo = gitRaw(ROOT, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  if (!isRepo) {
    console.error(`begin: ${ROOT} is not a git repository. begin derives churn and focus from git history — run \`git init\` and make a first commit.`);
  } else if (!gitRaw(ROOT, ['rev-parse', '--verify', 'HEAD']).trim()) {
    console.error('begin: this git repo has no commits yet. Commit your files first — begin reads tracked files, not the working directory.');
  } else {
    console.error('begin: this repo has commits but no tracked files match a known source extension. Check `git ls-files`.');
  }
  process.exit(2);
}

// Anchored at BOTH ends (`(/|$)`), and `?` escaped: without the tail anchor
// `--exclude lib` also removed `library/`, and `--exclude docs` removed
// `docs-site/`. Silently dropping files produces missing edges and phantom
// "unreachable" entries, so the count is reported too.
const excludeRe = EXCLUDE.length
  ? new RegExp(EXCLUDE.map((g) => '^' + g.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '(/|$)').join('|'))
  : null;

const allCode = tracked
  .filter((f) => !SKIP_DIR.test(f))
  .filter((f) => CODE_EXT.has(path.extname(f)))
  .filter((f) => !excludeRe || !excludeRe.test(f));
// Truncation must be shouted, not implied. "20000 scanned (of 20202 tracked)"
// reads as "the rest aren't code", when in fact every surface in the repo can
// be in the dropped tail.
const excludedCount = tracked
  .filter((f) => !SKIP_DIR.test(f) && CODE_EXT.has(path.extname(f)))
  .filter((f) => excludeRe && excludeRe.test(f)).length;
const truncatedCount = Math.max(0, allCode.length - MAX_FILES);
const files = allCode.slice(0, MAX_FILES);

const fileSet = new Set(files);

// ---------------------------------------------------------------- read + per-file metrics

const LINE_COMMENT = /^\s*(\/\/|#|\*|\/\*|--)/;

// Decision-point sets are per-language. The C-family set never matches Python's
// `elif` (the \b fails inside the word), `except`, `and` or `or`, which made an
// identical algorithm measure 74 in JS and 3 in Python — a 25x under-count that
// kept every Python engine out of the hotspot table.
const DECISION_C = /\b(if|else\s+if|for|while|case|catch|switch)\b|&&|\|\||\?\?|\?\./g;
const DECISION_PY = /\b(if|elif|else|for|while|except|with|and|or|assert)\b/g;

// Only real logic languages contribute a complexity score. Markup and schema
// files have no decision points; counting `<label for=...>` as a branch put an
// HTML form above hand-written code.
const CX_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte',
  '.py', '.go', '.rb', '.rs', '.java', '.kt', '.swift', '.php', '.cs',
  '.c', '.h', '.cc', '.cpp', '.hpp',
]);

/** Vendored, minified or generated code is not this repo's complexity.
 *
 *  Average line length alone is useless against modern bundlers: an esbuild
 *  bundle measured 113 chars/line and a rolldown bundle 30, because both keep
 *  statement-level newlines. That single test caught 0 of 15+ real build
 *  artifacts in one repo, where 13 of the top 40 hotspots were byte-identical
 *  copies of the same bundle. */
const GENERATED_MARKERS = [
  /\/\/\s*#region\s+\0?rolldown/,          // rolldown
  /var\s+\w+\s*=\s*\(\s*\(\s*\)\s*=>\s*\{\s*var\s+__/, // esbuild IIFE preamble
  /webpackJsonp|__webpack_require__/,        // webpack
  /\/\*!\s*(bundle|generated|For license information)/i,
  /^\s*(\/\/|#|\/\*)\s*(@generated|AUTO-GENERATED|Code generated by|DO NOT EDIT|prettier-ignore-start)/im,
  /sourceMappingURL=data:application\/json;base64/,
];
const GENERATED_PATH = /(^|\/)(vendor|vendored|polyfills?|third[_-]?party|generated|__generated__|node_modules|bower_components)\//i;
// `lib/` is a SOURCE directory in a large share of npm packages, and
// public//assets/ hold hand-written JS in Rails, Django and Phoenix apps.
// Classifying by those paths alone deleted 8 of 9 real source files from one
// package's ranking. Only unambiguous build directories qualify.
const BUILD_PATH = /(^|\/)(dist|build|out|\.output|umd)\/.*\.(js|mjs|cjs|css)$/i;

function looksGenerated(file, src, lineCount) {
  if (/\.(min|bundle|chunk)\.(js|css)$/i.test(file)) return 'minified';
  if (GENERATED_PATH.test(file)) return 'vendored';
  if (BUILD_PATH.test(file)) return 'build-output';
  const head = src.slice(0, 4000);
  for (const re of GENERATED_MARKERS) if (re.test(head)) return 'generated';
  if (src.length / Math.max(1, lineCount) > 300) return 'minified';
  // Bundles are overwhelmingly single-letter identifiers after mangling.
  const ids = head.match(/\b[A-Za-z_$][\w$]*\b/g) || [];
  if (ids.length > 200) {
    const single = ids.filter((t) => t.length === 1).length / ids.length;
    if (single > 0.45) return 'minified';
  }
  return null;
}

/**
 * Two derived forms, because they are needed for opposite reasons:
 *  - stripComments: kills block comments and whole-line `//` comments (where
 *    commented-out imports live) but KEEPS string literals — import specifiers
 *    are string literals, so this is what the import scanner must read.
 *  - decontent: also blanks string/template bodies, so decision-point and
 *    surface regexes cannot match text that merely appears inside a string.
 */
function stripComments(src) {
  // A character scanner, not a regex. `const P = "a/*b";` followed later by any
  // `*/` made the regex version swallow every import in between and report the
  // targets as dead code. A string containing /* is not a comment, and the only
  // way to know that is to track quoting.
  let out = '';
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      // A ' or " cannot span a line. Without that bound, a quote inside a regex
      // character class (/["']/) or a JSX apostrophe (<p>don't</p>) shifted
      // quote parity for the rest of the file, left the next block comment
      // unstripped, and turned a commented-out `import` into a real edge —
      // dead code presented as live, with no signal.
      if (q === '`' && src.indexOf('`', i + 1) === -1) { out += ch; i++; continue; }
      out += ch; i++;
      while (i < src.length && src[i] !== q && (q === '`' || src[i] !== '\n')) {
        if (src[i] === '\\') { out += src[i++] ?? ''; if (i < src.length) out += src[i++]; continue; }
        out += src[i++];
      }
      if (i < src.length && src[i] === q) out += src[i++];
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e === -1 ? src.length : e + 2;
      out += ' ';
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      i = e === -1 ? src.length : e;
      continue;
    }
    out += ch; i++;
  }
  return out;
}
/** Python comment/string scanner.
 *
 *  The C-family stripper was being applied to .py files. A perfectly ordinary
 *  `#` comment containing `/*` — a glob, a path, an "and/or" — made it hunt for
 *  a closing star-slash, never find one, and delete everything to EOF. On one
 *  real repo that removed 173,638 bytes and 98 import statements from the
 *  single highest-ranked file, corrupting 13.4% of the Python in the repo,
 *  while `partial: false` asserted the file had been read whole. */
function stripCommentsPy(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    if ((ch === '"' || ch === "'") && src[i + 1] === ch && src[i + 2] === ch) {
      const q = src.slice(i, i + 3);
      const e = src.indexOf(q, i + 3);
      const end = e === -1 ? src.length : e + 3;
      out += src.slice(i, end);            // kept here; decontent blanks it
      i = end; continue;
    }
    if (ch === '"' || ch === "'") {
      const q = ch; out += ch; i++;
      while (i < src.length && src[i] !== q && src[i] !== '\n') {
        if (src[i] === '\\') { out += src[i++]; if (i < src.length) out += src[i++]; continue; }
        out += src[i++];
      }
      if (i < src.length) out += src[i++];
      continue;
    }
    if (ch === '#') { const e = src.indexOf('\n', i); i = e === -1 ? src.length : e; continue; }
    out += ch; i++;
  }
  return out;
}

function decontent(src, ext) {
  // Python docstrings are strings, and a `"""..."""` block containing an
  // example like `>>> asyncio.run(main())` was being read as a real call and
  // inventing `worker` surfaces that exist nowhere in the program.
  const base = ext === '.py'
    ? stripCommentsPy(src).replace(/("""|''')[\s\S]*?\1/g, '""')
    : stripComments(src);
  return base
    // `--` (SQL) and `#` (Python/shell) line comments. Without this every
    // `if`/`for` inside a SQL comment block counts as a decision point; a
    // comment-only .sql file measured a complexity proxy of 201.
    .replace(/^[ \t]*(--|#)[^\n]*$/gm, '')
    // Single-line templates only. A regex cannot match `${ {a:1} }` (nested
    // braces), and the runaway match then swallows everything between two
    // distant backticks — measured at 86% of one 284KB .tsx file.
    // Multi-line templates are left in place: slightly over-counting decision
    // points inside a template beats erasing most of the file.
    .replace(/`[^`\n]*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

const info = new Map(); // file -> record

for (const f of files) {
  const abs = path.join(ROOT, f);
  let stat;
  try { stat = fs.statSync(abs); } catch { continue; }
  // Huge files are the ones with the most commits surprisingly often — the five
  // biggest files in one real repo were also its five most-edited. Dropping them
  // deleted exactly the code the user lived in, so read the head instead.
  let src, partial = false;
  if (stat.size > FULL_BYTES) {
    try {
      const fd = fs.openSync(abs, 'r');
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      fs.closeSync(fd);
      src = buf.slice(0, n).toString('utf8');
      partial = true;
    } catch { continue; }
  } else {
    try { src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  }

  const lines = src.split('\n');
  const loc = lines.filter((l) => l.trim() && !LINE_COMMENT.test(l)).length;

  const ext0 = path.extname(f);
  const generated = looksGenerated(f, src, lines.length);
  const nocomment = ext0 === '.py' ? stripCommentsPy(src) : stripComments(src);
  const clean = decontent(src, ext0);
  const decisions = (generated || !CX_EXT.has(ext0))
    ? 0
    : (clean.match(ext0 === '.py' ? DECISION_PY : DECISION_C) || []).length;

  // indentation-based nesting proxy (honest: a proxy, not a parse)
  let maxDepth = 0;
  for (const l of lines) {
    if (!l.trim()) continue;
    const ws = l.match(/^[ \t]*/)[0].replace(/\t/g, '  ').length;
    if (ws / 2 > maxDepth) maxDepth = Math.floor(ws / 2);
  }
  if (maxDepth > 20) maxDepth = 20; // guard against generated/minified

  info.set(f, {
    file: f,
    bytes: stat.size,
    loc,
    complexity: decisions,              // cyclomatic PROXY (0 = not a logic file)
    generated,                          // 'minified' | 'vendored' | 'generated' | null
    maxDepth,
    raw: src,
    nocomment,
    clean,
    partial,
    hash: crypto.createHash('sha1').update(src).digest('hex'),
    imports: [],
  });
}

// A file checked into the repo several times byte-for-byte is a copied build
// artifact, not authored code. No line-length or fingerprint test catches this,
// and in one repo fifteen identical copies of one bundle took 13 of the top 40
// hotspot slots. Two copies can be legitimate; three or more is conclusive.
{
  const byHash = new Map();
  for (const rec of info.values()) {
    if (!rec.hash || (rec.loc || 0) < 5) continue;
    const list = byHash.get(rec.hash) || [];
    list.push(rec.file);
    byHash.set(rec.hash, list);
  }
  const BUNDLE_EXT = new Set(['.js', '.mjs', '.cjs', '.css']);
  for (const [, list] of byHash) {
    if (list.length < 3) continue;
    for (const f of list) {
      const rec = info.get(f);
      if (!rec) continue;
      rec.duplicateCount = list.length;
      // Only DROP duplicated bundles. Hand-written source copied into several
      // deploy directories (a shared email_sender.py vendored into four worker
      // dirs) is still this repo's code, and the duplication is itself worth
      // seeing — so it stays ranked and merely carries the count.
      if (!rec.generated && BUNDLE_EXT.has(path.extname(f))) rec.generated = 'duplicate-artifact';
    }
  }
}

// ---------------------------------------------------------------- import graph

// tsconfig / jsconfig path aliases
//
// NOTE: do NOT strip /* */ before parsing. Every tsconfig `paths` block contains
// globs like "@/*": ["./*"], and a naive block-comment stripper treats the `/*`
// inside those strings as the start of a comment and eats the rest of the file —
// which silently yields zero aliases and a near-empty import graph.
function readJsonAt(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch { return null; }
}
function readJsonc(p) {
  let txt;
  try { txt = fs.readFileSync(p, 'utf8'); } catch { return null; }
  try { return JSON.parse(txt); } catch { /* fall through to jsonc repair */ }
  // JSONC. stripComments is quote-aware, so it removes `/* Bundler mode */`
  // without touching the `/*` inside a "@/*" path glob — the hazard that made a
  // naive stripper eat whole configs and yield zero aliases.
  const repaired = stripComments(txt).replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(repaired); } catch { return null; }
}

const aliases = [];
{
  const seenCfg = new Set();
  const loadCfg = (rel, hops = 0) => {
    if (hops > 3 || seenCfg.has(rel)) return;
    seenCfg.add(rel);
    const abs = path.join(ROOT, rel);
    const cfg = readJsonc(abs);
    if (!cfg) return;
    const co = cfg.compilerOptions || {};
    const cfgDir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    const base = co.baseUrl ? path.posix.join(cfgDir, co.baseUrl.replace(/^\.\//, '').replace(/\/$/, '')) : cfgDir;
    for (const [k, v] of Object.entries(co.paths || {})) {
      aliases.push({
        scope: cfgDir,
        prefix: k.replace(/\*$/, ''),
        targets: (Array.isArray(v) ? v : [v]).map((t) =>
          path.posix.join(base, String(t).replace(/\*$/, '').replace(/^\.\//, ''))),
      });
    }
    if (co.baseUrl) aliases.push({ scope: cfgDir, prefix: '', targets: [base], bare: true });
    if (typeof cfg.extends === 'string' && cfg.extends.startsWith('.')) {
      loadCfg(path.posix.normalize(path.posix.join(cfgDir, cfg.extends)).replace(/(\.json)?$/, '.json'), hops + 1);
    }
    // TS project references: the root tsconfig often holds no paths at all and
    // just points at the configs that do (promptfoo declares @app/* only in a
    // referenced tsconfig.app.json).
    for (const ref of cfg.references || []) {
      if (ref && typeof ref.path === 'string') {
        let rp = path.posix.normalize(path.posix.join(cfgDir, ref.path));
        if (!/\.json$/.test(rp)) rp = path.posix.join(rp, 'tsconfig.json');
        loadCfg(rp, hops + 1);
      }
    }
  };
  // EVERY tsconfig/jsconfig in the tree, not just the root one. A monorepo whose
  // config lives at `app/tsconfig.json` otherwise loses every aliased import —
  // measured at 1,325 silently dropped edges in one real repo.
  // Each config's aliases are scoped to files under that config's directory, and
  // the deepest matching scope wins, which is how tsc itself resolves.
  const configs = tracked.filter((f) => /(^|\/)(tsconfig|jsconfig)([.\w-]*)\.json$/.test(f) && !SKIP_DIR.test(f));
  for (const cfg of configs.sort((a, b) => a.split('/').length - b.split('/').length)) loadCfg(cfg);
}

const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.vue', '.svelte', '.py'];
// NodeNext/ESM TypeScript writes `./x.js` for a file that is actually `./x.ts`.
// Without this rewrite every relative import in a modern TS repo resolves to
// nothing and the graph comes out empty.
const JS_TO_TS = [['.js', ['.ts', '.tsx']], ['.jsx', ['.tsx']], ['.mjs', ['.mts']], ['.cjs', ['.cts']]];
function resolveTo(cand) {
  for (const e of EXTS) {
    const c = cand + e;
    if (fileSet.has(c)) return c;
  }
  for (const [from, tos] of JS_TO_TS) {
    if (!cand.endsWith(from)) continue;
    const stem = cand.slice(0, -from.length);
    for (const t of tos) if (fileSet.has(stem + t)) return stem + t;
  }
  for (const e of EXTS.slice(1)) {
    const c = path.posix.join(cand, 'index' + e);
    if (fileSet.has(c)) return c;
    const d = path.posix.join(cand, '__init__' + e);
    if (fileSet.has(d)) return d;
  }
  return null;
}

// The `from` must be preceded by a real import/export STATEMENT start, anchored
// to a line. Without that, the word `from` inside a SQL string
// (`select id from "users"`) matched and invented `users` as an external package.
const JS_IMPORT = /(?:^|[^\w.])(?:import\s+[\s\S]{0,2000}?\sfrom\s*|import\s*|export\s+[\s\S]{0,2000}?\sfrom\s*|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;

// Python, captured properly:
//   group 1 = leading dots (relative level), 2 = module path, 3 = imported names
//   group 4 = plain `import a.b, c.d`
// `from x import (\n a,\n b\n)` is covered by allowing a parenthesised name list.
const PY_FROM = /^[ \t]*from\s+(\.*)([\w.]*)\s+import\s+(\([^)]*\)|[^\n#]+)/gm;
const PY_PLAIN = /^[ \t]*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;

// Python has no tsconfig. A module `a.b.c` is resolved against a set of roots:
// the importing file's own ancestor directories (nearest first, which is what
// sys.path insertion actually does for a script), then the repo root. Without
// this, every absolute intra-repo import is misfiled as a third-party package —
// measured at 5.4% edge capture on a real 878-file Python repo, with the most
// depended-on module in the whole codebase reporting fan-in 0.
function pyRootsFor(fromFile) {
  const roots = [];
  let d = path.posix.dirname(fromFile);
  while (d && d !== '.') { roots.push(d); d = path.posix.dirname(d); }
  roots.push('');
  return roots;
}

function resolvePyModule(fromFile, level, mod) {
  // level 0 = absolute. level 1 = this package. level n = n-1 directories up.
  if (level > 0) {
    let base = path.posix.dirname(fromFile);
    for (let i = 1; i < level; i++) base = path.posix.dirname(base);
    if (base === '.') base = '';
    const cand = mod ? path.posix.join(base, mod.replace(/\./g, '/')) : base;
    return resolvePyPath(cand);
  }
  // A declared third-party package NEVER resolves to a local file of the same
  // name. `import stripe` means the Stripe SDK; a repo that happens to contain
  // routes/stripe.py was producing a fabricated edge to it, because the app runs
  // with sys.path[0] = backend/ and routes/ is never on the path.
  const top = mod.split('.')[0];
  // A directory with __init__.py IS this repo's package; no manifest entry may
  // override it. (routes/stripe.py is a bare module in a non-root directory,
  // which is why the shadowing guard still applies there.)
  const isLocalPkg = top && pyRootsFor(fromFile).some((r) => fileSet.has(path.posix.join(r, top, '__init__.py')));
  if (!isLocalPkg && top && (declaredDeps.has(top) || declaredDeps.has(top.toLowerCase().replace(/-/g, '_')) || PY_STDLIB.has(top))) return null;
  const rel = mod.replace(/\./g, '/');
  for (const r of pyRootsFor(fromFile)) {
    const hit = resolvePyPath(path.posix.join(r, rel));
    if (hit) return hit;
  }
  return null;
}

function resolvePyPath(cand) {
  if (!cand) return null;
  // Packages before modules: CPython's FileFinder checks for a directory with
  // __init__.py first, so with both `config/` and `config.py` the package wins.
  if (fileSet.has(path.posix.join(cand, '__init__.py'))) return path.posix.join(cand, '__init__.py');
  if (fileSet.has(cand + '.py')) return cand + '.py';
  if (fileSet.has(cand) && cand.endsWith('.py')) return cand;
  return null;
}

/** `from pkg import a, b` also depends on pkg/a.py and pkg/b.py, not just pkg. */
function resolvePySubmodules(fromFile, level, mod, names) {
  const out = [];
  for (const raw of names.replace(/[()]/g, '').split(',')) {
    const name = raw.trim().split(/\s+as\s+/)[0].trim();
    if (!name || name === '*' || !/^\w+$/.test(name)) continue;
    const hit = resolvePyModule(fromFile, level, mod ? `${mod}.${name}` : name);
    if (hit) out.push(hit);
  }
  return out;
}

function resolveSpec(fromFile, spec) {
  const dir = path.posix.dirname(fromFile);
  if (spec.startsWith('.')) return resolveTo(path.posix.normalize(path.posix.join(dir, spec)));
  // Deepest-scoped config wins, mirroring how tsc picks the nearest tsconfig.
  const scoped = aliases
    .filter((a) => !a.scope || fromFile === a.scope || fromFile.startsWith(a.scope + '/'))
    .sort((a, b) => (b.scope || '').length - (a.scope || '').length);
  for (const a of scoped) {
    if (a.bare) {
      const hit = resolveTo(path.posix.join(a.targets[0], spec));
      if (hit) return hit;
      continue;
    }
    if (a.prefix && spec.startsWith(a.prefix)) {
      const rest = spec.slice(a.prefix.length);
      for (const t of a.targets) {
        const hit = resolveTo(path.posix.join(t, rest));
        if (hit) return hit;
      }
    }
  }
  return null; // external package — recorded separately
}

const externals = new Map(); // pkg -> count

// Graph health. A resolver that silently misses 95% of edges still prints a
// confident table; the only defence is counting what did NOT resolve and saying
// so out loud. `unresolvedTop` names the prefixes that failed most, which points
// straight at a missing alias or a missing language root.
let resolvedCount = 0, unresolvedCount = 0;
const unresolvedTop = new Map();

// Only FIRST-PARTY-LOOKING misses are evidence of a broken resolver. `os`,
// `json` and `react` not resolving is correct and expected; `routes` or
// `supabase_init` not resolving means a language root or alias is missing.
// Counting all of them together buries the real signal under stdlib noise.
const repoNames = new Set();
for (const f of tracked) {
  const parts = f.split('/');
  for (let i = 0; i < parts.length - 1; i++) repoNames.add(parts[i]);
  repoNames.add(parts[parts.length - 1].replace(/\.[^.]+$/, ''));
}
// Anything the project itself declares as a dependency is third-party by
// definition, even when a directory happens to share its name.
const declaredDeps = new Set();
for (const f of tracked) {
  const base = path.posix.basename(f);
  if (base === 'package.json') {
    const j = readJsonAt(f);
    if (j) for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
      for (const d of Object.keys(j[k] || {})) declaredDeps.add(d.replace(/^@/, '').split('/')[0]), declaredDeps.add(d);
  } else if (/^requirements.*\.txt$/.test(base) || base === 'pyproject.toml' || base === 'Pipfile' || base === 'setup.cfg') {
    try {
      const txt = fs.readFileSync(path.join(ROOT, f), 'utf8');
      // Only DEPENDENCY sections. Reading every line of pyproject.toml swept up
      // `[tool.setuptools] packages = ["app"]` — the project's OWN package —
      // into the third-party set, which then destroyed 30 real edges and
      // silenced the graph-health warning at the same time.
      const isReqTxt = /^requirements.*\.txt$/.test(base);
      let inDeps = isReqTxt;
      for (const raw of txt.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        if (!isReqTxt) {
          if (/^\[/.test(line)) { inDeps = /dependencies|packages\.find|requires/i.test(line) && !/tool\.setuptools\]/i.test(line); continue; }
          if (/^(dependencies|install_requires|requires)\s*=/.test(line)) { inDeps = true; continue; }
          if (/^[A-Za-z_][\w.-]*\s*=/.test(line) && !/^(dependencies|install_requires|requires)\s*=/.test(line)) { inDeps = false; continue; }
          if (!inDeps) continue;
        }
        const m2 = line.match(/^["']?([A-Za-z0-9_.-]+)/);
        if (m2) declaredDeps.add(m2[1].toLowerCase().replace(/-/g, '_'));
      }
    } catch { /* unreadable manifest */ }
  }
}
// Python's standard library is external and enormous; listing the common ones
// keeps stdlib noise out of the health signal.
const PY_STDLIB = new Set(('os sys json re time datetime typing math random logging pathlib collections itertools functools subprocess threading asyncio dataclasses enum abc io csv uuid hashlib base64 copy traceback warnings shutil tempfile glob argparse unittest sqlite3 socket ssl urllib http email string textwrap decimal struct pickle inspect operator contextlib secrets statistics zipfile tarfile signal platform getpass queue heapq bisect array weakref gc types').split(' '));

const looksFirstParty = (spec) => {
  if (spec.startsWith('.')) return true;
  const head = spec.replace(/^@/, '').split(/[./]/)[0];
  if (!head) return false;
  if (PY_STDLIB.has(head)) return false;
  if (declaredDeps.has(head) || declaredDeps.has(head.toLowerCase().replace(/-/g, '_'))) return false;
  if (spec.startsWith('@') && declaredDeps.has(spec.split('/').slice(0, 2).join('/'))) return false;
  return repoNames.has(head);
};

function unresolvedBump(ok, spec) {
  if (ok) { resolvedCount++; return; }
  if (!looksFirstParty(spec)) return;   // a genuine third-party package
  unresolvedCount++;
  const key = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split(/[./]/)[0] || spec;
  unresolvedTop.set(key, (unresolvedTop.get(key) || 0) + 1);
}

for (const rec of info.values()) {
  if (rec.skipped) continue;
  const ext = path.extname(rec.file);
  const seen = new Set();
  const typeOnly = new Set();
  const valueDeps = new Set();
  const lazyDeps = new Set();
  const add = (spec, isType = false, isLazy = false) => {
    if (!spec) return;
    const t = resolveSpec(rec.file, spec);
    if (t && t !== rec.file) {
      seen.add(t);
      if (isType) typeOnly.add(t); else valueDeps.add(t);
      if (isLazy) lazyDeps.add(t);
      unresolvedBump(true, spec);
      return;
    }
    // A bare specifier that resolves to nothing is either a real package or a
    // resolver failure. We cannot tell them apart here, so count it either way
    // and let the graph-health line expose a suspicious pile-up.
    if (!spec.startsWith('.') || !t) unresolvedBump(false, spec);
    if (!spec.startsWith('.')) {
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (pkg && !pkg.startsWith('node:')) externals.set(pkg, (externals.get(pkg) || 0) + 1);
    }
  };
  if (ext === '.py') {
    let m;
    const addPy = (target) => {
      if (!target || target === rec.file) return;
      seen.add(target); valueDeps.add(target);
    };
    const addPyExternal = (mod) => {
      const pkg = mod.split('.')[0];
      if (pkg) externals.set(pkg, (externals.get(pkg) || 0) + 1);
    };

    PY_FROM.lastIndex = 0;
    while ((m = PY_FROM.exec(rec.nocomment))) {
      // Dots are COUNTED, never string-replaced. `'..pkg'.replace(/\./g,'/')`
      // yields '//pkg', which normalises to a SIBLING directory — that produced
      // real, silently wrong edges to same-named siblings.
      const level = m[1].length;
      const mod = m[2] || '';
      const names = m[3] || '';
      const modHit = resolvePyModule(rec.file, level, mod);
      if (modHit) addPy(modHit);
      // `from pkg import a, b` depends on pkg/a.py and pkg/b.py too. Without this,
      // `from . import x, y` collapsed to a single edge at the package __init__
      // and manufactured a phantom import cycle.
      for (const sub of resolvePySubmodules(rec.file, level, mod, names)) addPy(sub);
      if (!modHit && level === 0 && mod) addPyExternal(mod);
      // `level > 0` used to force success here, which made the health counter
      // structurally blind to every relative Python import: 48 relative imports
      // pointing at nothing reported 0 unresolved.
      unresolvedBump(!!modHit, level > 0 ? '.'.repeat(level) + (mod || '') : (mod || ''));
    }

    PY_PLAIN.lastIndex = 0;
    while ((m = PY_PLAIN.exec(rec.nocomment))) {
      // `import a, b` — every name, not just the first.
      for (const raw of m[1].split(',')) {
        const mod = raw.trim().split(/\s+as\s+/)[0].trim();
        if (!mod) continue;
        const hit = resolvePyModule(rec.file, 0, mod);
        if (hit) addPy(hit); else addPyExternal(mod);
        unresolvedBump(!!hit, mod);
      }
    }
  } else {
    let m;
    JS_IMPORT.lastIndex = 0;
    // `import type X from` / `export type { X } from` is erased at compile time.
    // It is a real coupling for a reader, so it stays in the graph — but a cycle
    // made only of type edges is not an architecture smell, so track it apart.
    while ((m = JS_IMPORT.exec(rec.nocomment))) {
      // `await import('./x')` is a DELIBERATELY broken cycle as often as it is a
      // lazy load. Reporting such a pair as an "architecture smell" tells the user
      // to fix code that is already correct, so lazy edges are tracked and labelled.
      const lazy = /import\s*\(\s*['"]$/.test(m[0]) || /\bimport\s*\(/.test(m[0]);
      add(m[1], /\b(im|ex)port\s+type\b/.test(m[0]), lazy);
    }
  }
  rec.imports = [...seen];
  // a target imported both ways counts as a value dependency
  rec.valueImports = [...seen].filter((t) => valueDeps.has(t) || !typeOnly.has(t));
  rec.lazyImports = [...lazyDeps];
  // Cycles are judged on STATIC value edges only: a type edge is erased at build
  // time and a lazy edge is resolved at call time, so neither forms a real
  // initialisation cycle.
  rec.staticValueImports = rec.valueImports.filter((t) => !lazyDeps.has(t));
}

const fanOut = new Map(), fanIn = new Map(), importedBy = new Map();
for (const f of files) { fanOut.set(f, 0); fanIn.set(f, 0); importedBy.set(f, []); }
for (const rec of info.values()) {
  if (!rec.imports) continue;
  fanOut.set(rec.file, rec.imports.length);
  for (const t of rec.imports) {
    fanIn.set(t, (fanIn.get(t) || 0) + 1);
    importedBy.get(t)?.push(rec.file);
  }
}

// ---------------------------------------------------------------- PageRank (rank flows to the depended-upon)

function pagerank(nodes, edgesOf, d = 0.85, iters = 30) {
  const n = nodes.length;
  const idx = new Map(nodes.map((f, i) => [f, i]));
  let r = new Float64Array(n).fill(1 / n);
  const out = nodes.map((f) => (edgesOf(f) || []).map((t) => idx.get(t)).filter((x) => x !== undefined));
  for (let it = 0; it < iters; it++) {
    const nr = new Float64Array(n).fill((1 - d) / n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (out[i].length === 0) { dangling += r[i]; continue; }
      const share = (d * r[i]) / out[i].length;
      for (const j of out[i]) nr[j] += share;
    }
    const spread = (d * dangling) / n;
    for (let i = 0; i < n; i++) nr[i] += spread;
    r = nr;
  }
  return new Map(nodes.map((f, i) => [f, r[i]]));
}

// PageRank and the surface BFS BOTH run on VALUE imports. Running them on the
// all-imports graph floats pure type-barrel files (one line: `export * from …`)
// into the top 5 on fan-in they only have at compile time, and reports a
// type-only chain as a runtime path from a user action to the engine.
const rank = pagerank(files, (f) => info.get(f)?.valueImports || []);

// ---------------------------------------------------------------- cycles (Tarjan SCC)

function sccs(nodes, edgesOf) {
  const index = new Map(), low = new Map(), onStack = new Set();
  const stack = []; let counter = 0; const out = [];
  const iterative = (root) => {
    const work = [[root, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, pi] = frame;
      if (pi === 0) { index.set(v, counter); low.set(v, counter); counter++; stack.push(v); onStack.add(v); }
      const succ = edgesOf(v) || [];
      if (pi < succ.length) {
        frame[1]++;
        const w = succ[pi];
        if (!index.has(w)) { if (info.has(w)) work.push([w, 0]); }
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
      } else {
        if (low.get(v) === index.get(v)) {
          const comp = [];
          let w;
          do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
          if (comp.length > 1) out.push(comp);
        }
        work.pop();
        if (work.length) { const u = work[work.length - 1][0]; low.set(u, Math.min(low.get(u), low.get(v))); }
      }
    }
  };
  for (const v of nodes) if (!index.has(v)) iterative(v);
  return out;
}
const cycles = sccs(files, (f) => info.get(f)?.staticValueImports || []);

// ---------------------------------------------------------------- surfaces (what a human actually touches)

const pkgJson = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch { return null; }
})();

const SURFACE_RULES = [
  // `test` MUST come first: a .test.tsx otherwise matches the ui-component rule
  // and a test file starts masquerading as a user-facing surface.
  { kind: 'test', test: (f) => /(^|\/)(test|tests|__tests__|spec|e2e|fixtures)\//.test(f) || /\.(test|spec)\.[a-z]+$/.test(f) },

  // `example` and `config` exist so that live, deliberate entry points stop being
  // reported as "dead code". An examples/ script is a documentation surface; a
  // vitest.config.ts is executed by a runner and imported by nothing.
  { kind: 'example', test: (f) => /(^|\/)(examples?|samples?|demos?|site|docs?)\//i.test(f) },
  { kind: 'config', test: (f) => /(^|\/)[\w.-]*\.?config\.[cm]?[jt]s$/.test(f) || /(^|\/)(vite|vitest|webpack|rollup|jest|eslint|tailwind|next|nuxt|astro|svelte|babel)\.config\./.test(f) },

  // --- HTTP, JS and Python. `.websocket` matters: it is frequently THE entry
  // point of an app and was previously invisible.
  { kind: 'http-route', test: (f, r) => /\b(app|router|server|fastify|hono|api_router|bp|blueprint)\s*\.\s*(get|post|put|patch|delete|all|head|options|websocket|ws)\s*\(/.test(r.clean || '') },
  { kind: 'http-route', test: (f, r) => /@\s*[\w.]*\s*(app|router|api_router|bp|blueprint)\s*\.\s*(get|post|put|patch|delete|head|options|websocket)\s*\(/.test(r.clean || '') },
  { kind: 'http-route', test: (f, r) => /@\s*[\w.]+\.route\s*\(|\.add_url_rule\s*\(|\.add_api_route\s*\(|include_router\s*\(/.test(r.clean || '') },
  { kind: 'http-route', test: (f, r) => /^\s*urlpatterns\s*=/m.test(r.clean || '') || /=\s*(FastAPI|Flask|Starlette|Quart)\s*\(/.test(r.clean || '') },
  { kind: 'http-route', test: (f, r) => /\b(createRoute|registerRoutes|addRoute)\s*\(/.test(r.clean || '') },

  { kind: 'web-page', test: (f) => /(^|\/)(app|pages|routes)\/(.*\/)?(page|route|layout|template|\+page|\+server)\.(t|j)sx?$/.test(f) || /(^|\/)pages\/(?!api\/).*\.(t|j)sx$/.test(f) },
  { kind: 'web-page', test: (f) => /\.html$/.test(f) },
  { kind: 'ui-component', test: (f, r) => /\.(tsx|jsx|vue|svelte)$/.test(f) && /(return\s*\(?\s*<|<\/[A-Za-z]|<template)/.test(r.raw || '') },

  { kind: 'mcp-tool', test: (f, r) => /\b(server\.(tool|registerTool)|ListToolsRequestSchema|CallToolRequestSchema|tools\/list)\b/.test(r.clean || '') || /@\s*\w+\.tool\s*\(|def\s+(list_tools|call_tool)\b/.test(r.clean || '') },

  { kind: 'cli-command', test: (f, r) => /\b(commander|yargs|\.command\s*\(|process\.argv|@oclif)/.test(r.clean || '') },
  { kind: 'cli-command', test: (f, r) => /^\s*if\s+__name__\s*==\s*['"]__main__['"]/m.test(r.clean || '') || /argparse\.ArgumentParser|@\s*click\.(command|group)|typer\.Typer\s*\(/.test(r.clean || '') },

  // Background work is a real entry point with no caller in the import graph.
  { kind: 'worker', test: (f, r) => /@\s*[\w.]*\.?(shared_task|task)\s*[(\n]|Celery\s*\(|BackgroundScheduler|asyncio\.run\s*\(|\bnew Worker\s*\(/.test(r.clean || '') },

  { kind: 'public-api', test: () => false }, // filled from package.json below
  { kind: 'migration', test: (f) => /(^|\/)(migrations?|db\/migrate|drizzle|prisma|alembic\/versions)\//i.test(f) || /\.sql$/.test(f) },
];

// A human can declare entry points the heuristics cannot see — a WebSocket URL,
// a string-keyed registry, a queue consumer. One path per line in
// `.begin/surfaces.txt`, optionally `path<TAB>kind`. Declared beats detected,
// so the judgement a reader makes once is not re-made on every run.
const declaredSurfaces = new Map();
try {
  const txt = fs.readFileSync(path.join(OUT_DIR, 'surfaces.txt'), 'utf8');
  for (const line of txt.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    // Split on the LAST whitespace run so a path containing spaces survives,
    // and strip a leading ./ — both used to be discarded without a word, which
    // silently defeated the documented escape hatch for correcting the scan.
    const m2 = t.match(/^(.*?)(?:[ \t]+(\S+))?$/);
    const p2 = (m2?.[1] || '').replace(/^\.\//, '');
    if (p2) declaredSurfaces.set(p2, m2?.[2] || 'declared');
  }
} catch { /* optional file */ }

const surfaces = new Map(); // file -> kind
for (const rec of info.values()) {
  for (const rule of SURFACE_RULES) {
    if (rule.kind === 'public-api') continue;
    try {
      if (rule.test(rec.file, rec)) { surfaces.set(rec.file, rule.kind); break; }
    } catch { /* rule misfire on odd content: skip */ }
  }
}
// A human's declaration outranks every heuristic.
for (const [f, k] of declaredSurfaces) {
  if (fileSet.has(f)) surfaces.set(f, k);
  else console.error(`begin: .begin/surfaces.txt declares "${f}", which is not a tracked file — ignored`);
}

// public API entry points declared in package.json
const declaredEntries = new Set();
if (pkgJson) {
  const collect = (v) => {
    if (typeof v === 'string') declaredEntries.add(v.replace(/^\.\//, ''));
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  collect(pkgJson.exports); collect(pkgJson.main); collect(pkgJson.module); collect(pkgJson.bin);
  for (const e of declaredEntries) {
    // dist/x.js usually mirrors src/x.ts
    const cands = [e, e.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'), e.replace(/^dist\//, 'src/').replace(/\.js$/, '.tsx')];
    for (const c of cands) if (fileSet.has(c) && !surfaces.has(c)) surfaces.set(c, 'public-api');
  }
}

// ---------------------------------------------------------------- reachability: surface -> engine

const depth = new Map(), viaSurface = new Map();
const q = [];
for (const [f, kind] of surfaces) {
  if (kind === 'test') continue;
  depth.set(f, 0); viaSurface.set(f, [f]); q.push(f);
}
// Reachability traverses ALL imports, including type-only ones: a reader
// genuinely follows a type edge, and excluding them made the single
// most-imported file in a repo report as "unreachable — dead code".
// Ranking still uses value edges only; these are different questions.
for (let qi = 0; qi < q.length; qi++) {
  const u = q[qi];
  const du = depth.get(u);
  for (const v of info.get(u)?.imports || []) {
    if (!depth.has(v)) { depth.set(v, du + 1); viaSurface.set(v, [...new Set(viaSurface.get(u))].slice(0, 3)); q.push(v); }
    else if (depth.get(v) === du + 1) {
      const cur = viaSurface.get(v) || [];
      if (cur.length < 3) viaSurface.set(v, [...new Set([...cur, ...viaSurface.get(u)])].slice(0, 3));
    }
  }
}

// ---------------------------------------------------------------- churn (git)

// A git user.name routinely contains ( ) + [ ] — characters that make an
// unguarded `new RegExp(name)` throw and kill the whole scan with a stack trace.
let authorRe = null;
if (AUTHOR) {
  try { authorRe = new RegExp(AUTHOR, 'i'); }
  catch {
    authorRe = new RegExp(AUTHOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    console.error(`begin: --author "${AUTHOR}" is not valid regex — matching it literally`);
  }
}

const churn = new Map(), lastTouch = new Map(), authorsOf = new Map(), myChurn = new Map();
let commitsInWindow = 0;
{
  const log = git(['log', `--since=${SINCE}`, '--no-merges', '--name-only', '--pretty=format:%x01%H%x02%at%x02%an%x02%s']);
  let cur = null;
  for (const line of log.split('\n')) {
    if (line.startsWith('\x01')) {
      const [sha, at, an, subj] = line.slice(1).split('\x02');
      cur = { sha, at: +at, an, subj, mine: authorRe ? authorRe.test(an) : false };
      commitsInWindow++;
      continue;
    }
    const f = line.trim();
    if (!f || !fileSet.has(f)) continue;
    churn.set(f, (churn.get(f) || 0) + 1);
    if (cur?.mine) myChurn.set(f, (myChurn.get(f) || 0) + 1);
    if (!lastTouch.has(f) && cur) lastTouch.set(f, cur.at);
    if (cur) {
      const s = authorsOf.get(f) || new Set();
      s.add(cur.an); authorsOf.set(f, s);
    }
  }
}

// ---------------------------------------------------------------- scoring

// Damping is applied to RAW PageRank before z-scoring, never to the z-score.
// Multiplying a z-score is sign-asymmetric: it shrinks a NEGATIVE z toward zero,
// so it promoted unimportant small files while demoting important ones. With a
// 0.25 floor, a 3-line hub imported by 60 files stays rank 1; without it, that
// hub fell to rank 61 of 62.
const substance = (f) => {
  const loc = info.get(f)?.loc || 0;
  const size = 0.25 + 0.75 * (loc / (loc + 60));
  // PageRank concentrates mass on SINKS — a file that imports nothing collects
  // rank from whatever points at it, however few things those are. The legend
  // promises "many things depend on it", so require direct corroboration:
  // fan-in 3 is damped hard, fan-in 138 barely at all. Size alone could not
  // tell a 5-line hub (fanIn 138) from a 16-line sink (fanIn 3).
  const fi = fanIn.get(f) || 0;
  return size * (fi / (fi + 4));
};

const vals = (m) => files.map((f) => m.get(f) || 0);
function z(m) {
  const v = vals(m);
  const mu = v.reduce((a, b) => a + b, 0) / (v.length || 1);
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / (v.length || 1)) || 1;
  return new Map(files.map((f) => [f, ((m.get(f) || 0) - mu) / sd]));
}
const zRank = z(new Map(files.map((f) => [f, (rank.get(f) || 0) * substance(f)]))), zChurn = z(churn), zCx = z(new Map(files.map((f) => [f, (info.get(f)?.complexity || 0) * (1 + (info.get(f)?.maxDepth || 0) / 10)])));

const now = Date.now() / 1000;

// A 4-line re-export imported everywhere collects enormous PageRank and teaches
// a reader nothing. The substance factor damps importance for files with almost
// no code, so hubs still rank but trivial barrels stop crowding out engines.

const terms = new Map(files.map((f) => {
  const recency = lastTouch.has(f) ? Math.exp(-(now - lastTouch.get(f)) / (60 * 60 * 24 * 45)) : 0;
  const t = {
    importance: 1.2 * (zRank.get(f) || 0),
    churn: 1.0 * (zChurn.get(f) || 0),
    complexity: 0.8 * (zCx.get(f) || 0),
    recency: 0.6 * recency,
    yours: AUTHOR && myChurn.get(f) ? 0.5 : 0,
  };
  return [f, t];
}));
const score = new Map(files.map((f) => {
  const t = terms.get(f);
  return [f, t.importance + t.churn + t.complexity + t.recency + t.yours];
}));
/** Which single term carried this file into the table — so a reader can tell
 *  "everyone depends on it" apart from "it changes every day". */
const whyRanked = (f) => {
  const t = terms.get(f) || {};
  const pairs = [['depended-on', t.importance], ['churn', t.churn], ['complex', t.complexity], ['recent', t.recency]];
  pairs.sort((a, b) => b[1] - a[1]);
  return pairs[0][1] <= 0 ? '—' : pairs[0][0];
};

// Files with no parsed lines (too large to read, pure markup, vendored or
// generated) carry a real churn number but no code of this repo's to explain.
// They are ranked separately, not suppressed.
const hasCode = (f) => (info.get(f)?.loc || 0) > 0 && !info.get(f)?.skipped && !info.get(f)?.generated;
const ranked = files.filter(hasCode).sort((a, b) => score.get(b) - score.get(a));
const unparsed = files.filter((f) => !hasCode(f)).sort((a, b) => (churn.get(b) || 0) - (churn.get(a) || 0));

// ---------------------------------------------------------------- output

fs.mkdirSync(OUT_DIR, { recursive: true });

// The post-commit hook runs a scan on EVERY commit, so two scans racing is the
// normal case, not an edge case. A non-atomic write produced spliced JSON in
// 30 of 60 concurrent reads — and a spliced scan.md has no parse step to catch
// it, so an agent would simply read and cite corrupted text.
const atomicWrite = (p, data) => {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
};
// Makes .begin/ self-ignoring without ever touching the repo's tracked
// .gitignore — the machine layer stays out of git with zero working-tree diff.
fs.writeFileSync(path.join(OUT_DIR, '.gitignore'), '*\n');

const head = git(['rev-parse', 'HEAD']).trim();
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();

const record = (f) => {
  const r = info.get(f) || {};
  return {
    file: f,
    loc: r.loc || 0,
    complexityProxy: r.complexity || 0,
    maxNestingProxy: r.maxDepth || 0,
    fanIn: fanIn.get(f) || 0,
    fanOut: fanOut.get(f) || 0,
    // Raw PageRank concentrates mass on graph SINKS: in one repo the single
    // highest score belonged to a 16-line module with fan-in 3, under a legend
    // promising "many things depend on it". The displayed figure is therefore
    // damped by substance, exactly as the score is, and fanIn sits beside it.
    importance: +((rank.get(f) || 0) * substance(f)).toFixed(6),   // damped, matches the ranking
    importanceRaw: +(rank.get(f) || 0).toFixed(6),
    commits: churn.get(f) || 0,
    yourCommits: myChurn.get(f) || 0,
    lastTouched: lastTouch.has(f) ? new Date(lastTouch.get(f) * 1000).toISOString().slice(0, 10) : null,
    authors: [...(authorsOf.get(f) || [])],
    surface: surfaces.get(f) || null,
    hopsFromSurface: depth.has(f) ? depth.get(f) : null,
    reachedVia: viaSurface.get(f) || [],
    // NOT truncated: a machine layer that cannot reproduce its own fanIn number
    // cannot be used to check its own claims, which is the whole point of it.
    importedBy: importedBy.get(f) || [],
    imports: info.get(f)?.imports || [],
    lazyImports: info.get(f)?.lazyImports || [],
    generated: info.get(f)?.generated || null,
    partial: info.get(f)?.partial || false,
    // Duplicated SOURCE stays ranked; the count makes the duplication visible,
    // because "this file exists byte-identical in four places" is a finding.
    identicalCopies: info.get(f)?.duplicateCount || 1,
    why: whyRanked(f),
    score: +(score.get(f) || 0).toFixed(3),
  };
};

const out = {
  generatedAt: new Date().toISOString(),
  root: ROOT,
  head,
  branch,
  window: SINCE,
  authorFilter: AUTHOR || null,
  counts: {
    trackedFiles: tracked.length,
    scannedFiles: files.length,
    edges: [...info.values()].reduce((a, r) => a + (r.imports?.length || 0), 0),
    surfaces: [...surfaces.values()].filter((k) => k !== 'test').length,
    testFiles: [...surfaces.values()].filter((k) => k === 'test').length,
    codeFiles: allCode.length,
    notScanned: truncatedCount,
    excludedByFlag: excludedCount,
    droppedAsGenerated: [...info.values()].filter((r) => r.generated).length,
    commitsInWindow,
    resolvedSpecifiers: resolvedCount,
    unresolvedSpecifiers: unresolvedCount,
    unreachable: files.filter((f) => !depth.has(f) && surfaces.get(f) !== 'test').length,
    cycles: cycles.length,
  },
  surfacesByKind: [...surfaces.entries()].reduce((a, [f, k]) => ((a[k] = a[k] || []).push(f), a), {}),
  topExternals: [...externals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => ({ pkg: k, imports: v })),
  cycles: cycles.slice(0, 20),
  files: ranked.map(record),
  unparsed: unparsed.slice(0, 40).map((f) => ({
    file: f,
    commits: churn.get(f) || 0,
    // Report the REAL reason. This said "no-code-lines" for a 94KB vendored
    // polyfill: excluded correctly, explained wrongly.
    reason: info.get(f)?.generated || info.get(f)?.skipped || 'no-code-lines',
    ...(info.get(f)?.duplicateCount ? { identicalCopies: info.get(f).duplicateCount } : {}),
  })),
};

atomicWrite(path.join(OUT_DIR, 'scan.json'), JSON.stringify(out, null, 2));

// --- markdown digest (what the agent actually reads)

const pad = (s, n) => String(s).padEnd(n);
const md = [];
md.push(`# begin scan — ${path.basename(ROOT)}`);
md.push('');
md.push(`generated ${out.generatedAt} · branch \`${branch}\` · HEAD \`${head.slice(0, 9)}\` · churn window "${SINCE}"${AUTHOR ? ` · author filter /${AUTHOR}/i` : ''}`);
md.push('');
md.push(`**${out.counts.scannedFiles}** source files scanned (of ${out.counts.trackedFiles} tracked) · **${out.counts.edges}** import edges · **${out.counts.surfaces}** surface files · **${out.counts.unreachable}** files unreachable from any surface · **${out.counts.cycles}** import cycles`);
md.push('');
// Degraded signals must be shouted at the top, not inferred from a table of
// zeroes. Silence here is how a confident ranking gets built on nothing.
const warnings = [];
if (truncatedCount > 0) warnings.push(`**${truncatedCount} source files were NOT scanned** (cap ${MAX_FILES}). Edges, surfaces and reachability below are incomplete.`);
// A shallow clone truncates history at a boundary date. If that boundary is
// INSIDE the churn window, churn is silently partial — which is worse than
// churn being zero, because the numbers look plausible. README claimed this
// check existed before it did.
if (gitRaw(ROOT, ['rev-parse', '--is-shallow-repository']).trim() === 'true') {
  const boundary = gitRaw(ROOT, ['log', '--reverse', '--format=%ci', '--max-count=1']).trim();
  warnings.push(`**This is a shallow clone.** History is truncated${boundary ? ` at ${boundary.slice(0, 10)}` : ''}, so churn and recency are partial for every file and missing entirely for older ones. Run \`git fetch --unshallow\` for a trustworthy ranking.`);
}
if (commitsInWindow === 0) warnings.push(`**No commits in the window "${SINCE}"** — shallow clone, fresh clone, or dormant repo. Churn and recency contributed NOTHING; the ranking is importance + complexity only.`);
else if (commitsInWindow <= 2) warnings.push(`**Only ${commitsInWindow} commit(s) in the window** — churn and recency are near-constant and carry almost no signal.`);
if (unresolvedCount > 0 && unresolvedCount <= 20) {
  warnings.push(`${unresolvedCount} first-party import specifier(s) did not resolve (${((unresolvedCount / Math.max(1, resolvedCount + unresolvedCount)) * 100).toFixed(1)}% of all specifiers). Small, but those edges are missing.`);
}
if (unresolvedCount > 20 && unresolvedCount > resolvedCount * 0.15) {
  const top = [...unresolvedTop.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `\`${k}\`x${v}`).join(', ');
  warnings.push(`**${unresolvedCount} import specifiers that look first-party did NOT resolve** (vs ${resolvedCount} resolved). Those edges are missing, so importance and reachability are understated. Heaviest: ${top}. Each is a name that exists in this repo — suspect a missing tsconfig alias or an unusual source root.`);
}
// Any language present in bulk but contributing almost no edges is a resolver
// failure, and it looks exactly like "this code is dead" in the output.
{
  const byLang = new Map();
  for (const f of files) {
    const e = path.extname(f);
    const b = byLang.get(e) || { n: 0, edges: 0 };
    b.n++; b.edges += (info.get(f)?.imports || []).length;
    byLang.set(e, b);
  }
  // Languages whose imports this tool does not parse AT ALL. Naming them is not
  // optional: a 38-file Go module produced 0 edges, declared every file possibly
  // dead, and printed no warning, because the check was gated on a JS/Python
  // allowlist rather than on the evidence.
  const UNPARSED_LANGS = new Set(['.go', '.rb', '.rs', '.java', '.kt', '.swift', '.php', '.cs', '.c', '.h', '.cc', '.cpp', '.hpp']);
  // Stylesheets, schemas and markup are scanned for size and churn but are not
  // expected to contribute import edges, so "0 edges" is correct for them and
  // warning about it is a false alarm that trains people to ignore the block.
  const NO_IMPORT_LANGS = new Set(['.css', '.scss', '.sql', '.html']);
  for (const [ext, b] of byLang) {
    if (b.n < 10 || NO_IMPORT_LANGS.has(ext)) continue;
    if (UNPARSED_LANGS.has(ext)) {
      warnings.push(`**\`${ext}\` imports are not parsed by this tool** (${b.n} files). They contribute NO edges, so every one of them will show importance at the floor and appear under "unreachable from any surface" even when they are the product. Size, churn and complexity are still real for them; the graph is not.`);
    } else if (b.n >= 20 && b.edges / b.n < 0.1) {
      warnings.push(`**Import resolution looks broken for \`${ext}\`** (${b.n} files, ${b.edges} edges). Those files will sit at the importance floor and appear "unreachable" even when they are the product.`);
    }
  }
}
// Files removed from the ranking must be VISIBLE. Vendored/minified/build
// detection is a heuristic; silently deleting real source is the failure mode,
// so the count is always printed and the reasons are in scan.json.
{
  const gen = out.counts.droppedAsGenerated;
  if (gen > 0 || excludedCount > 0) {
    const bits = [];
    if (gen > 0) bits.push(`**${gen}** excluded as vendored / minified / build output / duplicate artifacts`);
    if (excludedCount > 0) bits.push(`**${excludedCount}** removed by \`--exclude\``);
    md.push(`_${bits.join(' · ')}. Reasons are in \`.begin/scan.json\` under \`unparsed\` — check them if a file you expected is missing._`);
    md.push('');
  }
}

if (warnings.length) {
  md.push('> [!WARNING]');
  for (const w of warnings) md.push(`> - ${w}`);
  md.push('');
}

md.push('> **How to read this.** `complexityProxy` = decision-point count, not a parse. `maxNesting` = indentation depth. `importance` = PageRank over the value-import graph, damped by file size — read it together with `fanIn`, which is the plain count of files that import this one. `why` names the single term that put a row in the table.');
md.push('>');
md.push('> Every column is a LEAD, not a verdict — including `fanIn` and `hops←surface`, which are only as good as the import graph above. Open the file before you cite it.');
md.push('');

md.push('## Surfaces (where a human or caller actually touches this system)');
md.push('');
for (const [kind, list] of Object.entries(out.surfacesByKind)) {
  if (kind === 'test') continue;
  md.push(`- **${kind}** (${list.length}): ${list.slice(0, 12).map((f) => `\`${f}\``).join(', ')}${list.length > 12 ? ` … +${list.length - 12}` : ''}`);
}
if (!Object.keys(out.surfacesByKind).filter((k) => k !== 'test').length) md.push('- _none detected — this is a library with no declared entry points, or the heuristics missed. Check package.json exports and README by hand._');
md.push('');

md.push(`## Top ${TOP} by combined score (importance + churn + complexity + recency)`);
md.push('');
md.push('| # | file | why | score | imp | fanIn | LOC | cx | nest | commits | yours | last | hops←surface |');
md.push('|---|------|-----|-------|-----|-------|-----|----|------|---------|-------|------|--------------|');
ranked.slice(0, TOP).forEach((f, i) => {
  const r = record(f);
  md.push(`| ${i + 1} | \`${f}\` | ${r.why} | ${r.score} | ${r.importance} | ${r.fanIn} | ${r.loc} | ${r.complexityProxy} | ${r.maxNestingProxy} | ${r.commits} | ${r.yourCommits} | ${r.lastTouched || '—'} | ${r.hopsFromSurface ?? '∞'} |`);
});
md.push('');

md.push('## Surface → engine paths (how a user action reaches the hard part)');
md.push('');
const shown = new Set();
for (const f of ranked.slice(0, TOP)) {
  const r = record(f);
  if (r.hopsFromSurface === null || r.hopsFromSurface === 0) continue;
  const via = r.reachedVia[0];
  if (!via || shown.has(`${via}->${f}`)) continue;
  shown.add(`${via}->${f}`);
  // Mark lazy edges in the HUMAN report, not only in scan.json. The digest is
  // the file the skill tells you to read; rendering `await import()` as a plain
  // static hop there launders the one honest datum we already have.
  const lazyIn = (info.get(via)?.lazyImports || []).includes(f) || (info.get(f)?.lazyImports || []).length > 0;
  const tag = lazyIn ? ' _(path includes a lazy `await import()` edge)_' : '';
  md.push(`- \`${via}\` (${surfaces.get(via)}) → …${r.hopsFromSurface} hop${r.hopsFromSurface > 1 ? 's' : ''}… → \`${f}\`${tag}`);
}
if (shown.size === 0) md.push('- _no top-scoring file sits behind a detected surface. Either the surface heuristics missed, or the hot code is infrastructure with no user path — say which in the atlas._');
md.push('');

if (cycles.length) {
  md.push('## Import cycle groups (strongly connected — verify direction before citing)');
  md.push('');
  md.push('_A group is a set of files that can all reach each other. It is NOT a chain of mutual imports: rendering it with `↔` invented pairs that do not exist in the source. Where a concrete loop could be walked, the real directed path is shown._');
  md.push('');
  // Walk one genuine directed cycle inside the component, so the printed claim
  // is checkable against the source.
  const findCycle = (comp) => {
    const inComp = new Set(comp);
    const start = comp[0];
    const prev = new Map([[start, null]]);
    const stack = [start];
    while (stack.length) {
      const u = stack.pop();
      for (const v of (info.get(u)?.staticValueImports || [])) {
        if (!inComp.has(v)) continue;
        if (v === start) {
          const pathArr = [start];
          let c = u;
          while (c !== null && c !== undefined) { pathArr.unshift(c); c = prev.get(c); }
          return [...new Set(pathArr)].concat(start);
        }
        if (!prev.has(v)) { prev.set(v, u); stack.push(v); }
      }
    }
    return null;
  };
  for (const c of cycles.slice(0, 8)) {
    const loop = findCycle(c);
    md.push(`- **${c.length} files, mutually reachable.** ${loop ? `One real loop: ${loop.map((f) => `\`${f}\``).join(' → ')}` : 'No two-file loop found; the cycle runs through more files than shown.'}`);
    if (c.length <= 8) md.push(`  - members: ${c.map((f) => `\`${f}\``).join(', ')}`);
    else md.push(`  - members (first 8 of ${c.length}): ${c.slice(0, 8).map((f) => `\`${f}\``).join(', ')}`);
  }
  md.push('');
}

const orphans = ranked.filter((f) => !depth.has(f) && surfaces.get(f) !== 'test').slice(0, 15);
if (orphans.length) {
  md.push('## Unreachable from any surface (dead code, or a surface we failed to detect)');
  md.push('');
  md.push(orphans.map((f) => `\`${f}\``).join(', '));
  md.push('');
}

if (AUTHOR) {
  const mine = ranked.filter((f) => (myChurn.get(f) || 0) > 0).sort((a, b) => (myChurn.get(b) || 0) - (myChurn.get(a) || 0)).slice(0, 15);
  if (mine.length) {
    md.push('## Files YOU touched most in the window');
    md.push('');
    for (const f of mine) md.push(`- \`${f}\` — ${myChurn.get(f)} of your commits, last ${record(f).lastTouched}`);
    md.push('');
  }
}

const churnyUnparsed = out.unparsed.filter((u) => u.commits > 3).slice(0, 8);
if (churnyUnparsed.length) {
  md.push('## High-churn files with no parsed code (markup, generated, or too large)');
  md.push('');
  md.push('_Ranked separately: they change constantly but hold no logic to explain._');
  md.push('');
  for (const u of churnyUnparsed) md.push(`- \`${u.file}\` — ${u.commits} commits (${u.reason})`);
  md.push('');
}

md.push('## Heaviest external dependencies (by import count)');
md.push('');
md.push(out.topExternals.slice(0, 15).map((e) => `\`${e.pkg}\`×${e.imports}`).join(' · ') || '_none_');
md.push('');

// Stamp the digest with the JSON's own generatedAt so a reader can tell whether
// the pair came from the same run — two independent atomic writes can still
// interleave under the post-commit hook, which races itself by design.
md.push('');
md.push(`<!-- begin:scan generatedAt="${out.generatedAt}" head="${head}" -->`);
atomicWrite(path.join(OUT_DIR, 'scan.md'), md.join('\n'));

if (!flag('json-only')) process.stdout.write(md.join('\n') + '\n');
console.error(`begin: wrote ${path.relative(ROOT, path.join(OUT_DIR, 'scan.json'))} and scan.md (${files.length} files, ${out.counts.edges} edges)`);
