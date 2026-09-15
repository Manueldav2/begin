#!/usr/bin/env node
// Ground-truth test for scan.mjs. Builds a throwaway git repo whose correct
// answers are known by construction, runs the scanner, and asserts each one.
//
// Every assertion here exists because the corresponding bug was real:
//   alias      — tsconfig "@/*": ["./*"] was eaten by a block-comment stripper
//   jsToTs     — NodeNext "./x.js" specifiers resolved to nothing
//   typeCycle  — type-only cycles were reported as architecture smells
//   template   — a runaway backtick regex erased 86% of a 284KB file
//   testFirst  — .test.tsx files were classified as user-facing surfaces
//
// Run:  node test-scan.mjs        (exit 0 = green)
//       node test-scan.mjs --mutate <alias|jsToTs|valueCycle|typeCycle|pyAbsolute|pyDotDot>
//         breaks one fixture input; that assertion MUST go red. Verified: it does.
//
// `template` and `testFirst` have no mutation branch — they can only be broken by
// editing scan.mjs itself. Both were observed red in the wild before the fix
// (a 7619-line .tsx reported complexityProxy 68, true value 1042; .test.tsx
// files were classified as user-facing surfaces), which is why they are here.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MUTATIONS = ['alias', 'jsToTs', 'valueCycle', 'typeCycle', 'pyAbsolute', 'pyDotDot', 'generated', 'duplicates', 'pyHashComment', 'pyShadow'];
const MUTATE = process.argv.includes('--mutate') ? process.argv[process.argv.indexOf('--mutate') + 1] : null;
// A typo'd mutation name used to run a clean fixture and print "all green",
// so a broken mutation gate looked like a passing one.
if (MUTATE && !MUTATIONS.includes(MUTATE)) {
  console.error(`test-scan: unknown mutation "${MUTATE}". Known: ${MUTATIONS.join(', ')}`);
  process.exit(2);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'begin-fixture-'));
const w = (p, s) => { fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), s); };

w('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }, null, 2));
w('package.json', JSON.stringify({ name: 'fx', exports: { '.': './dist/index.js' } }, null, 2));

// public-api surface -> a -> b <-> c   (value cycle), a <-> t (TYPE-only cycle)
w('src/index.ts', `export { a } from "./a.js";\n`);

// a.ts: alias import, .js->.ts import, a multi-line template with nested braces
// (the exact shape that made the old backtick regex run away), then 6 decisions.
w('src/a.ts', `import { b } from "@/src/b";
import type { T } from "./t.js";

const tpl = \`
  line one \${ JSON.stringify({ nested: { deep: 1 } }) }
  line two \${ [1,2].map((n) => \`n=\${n}\`).join(",") }
\`;

export function a(x: number, t?: T) {
  if (x > 0) { return b(x); }
  if (x < 0) { return -1; }
  for (let i = 0; i < 3; i++) { if (i === 2) break; }
  while (x > 100) { x--; }
  try { return x; } catch { return 0; }
  return tpl.length && x ? 1 : 2;
}
`);

w('src/b.ts', `import { c } from "./c.js";\nexport function b(n: number) { return c(n); }\n`);
w('src/c.ts', `import { b } from "./b.js";\nexport function c(n: number) { return n > 1 ? b(n - 1) : 0; }\n`);
w('src/t.ts', `import type { a } from "./a.js";\nexport type T = { fn: typeof a };\n`);
w('src/orphan.ts', `export const nobodyImportsMe = 1;\n`);
w('app/page.tsx', `export default function Page() { return <main>hi</main>; }\n`);

// --- Python. These fixtures exist because the scanner shipped with 5.4% Python
// edge capture and a `..` bug that invented edges to same-named siblings, and
// NO python fixture existed to catch either.
w('py/app.py', `from routes import leads, users
import helpers
from . import sibling
`);
w('py/routes/__init__.py', `ROUTES = []\n`);
w('py/routes/leads.py', `VALUE = 1\n`);
w('py/routes/users.py', `VALUE = 2\n`);
w('py/helpers.py', `def h(): return 1\n`);
w('py/sibling.py', `X = 1\n`);
w('py/__init__.py', `\n`);
// the `..` trap: pkg/models.py is the correct target; pkg/sub/models.py is the
// decoy that the old string-replace resolver picked instead.
w('py/pkg/__init__.py', `\n`);
w('py/pkg/models.py', `REAL = True\n`);
w('py/pkg/sub/__init__.py', `\n`);
w('py/pkg/sub/models.py', `DECOY = True\n`);
w('py/pkg/sub/agent.py', `from ..models import REAL\n`);
// A `#` comment containing `/*` made the C-family stripper delete everything to
// EOF: 173,638 bytes and 98 imports from one real file, while `partial: false`
// claimed it had been read whole.
w('py/hashcomment.py', `# the renderer reads totals/*.json and open/reply rates, but not the rest
import helpers
from routes import leads

def go():
    return helpers.h()
`);
// A declared third-party package must never resolve to a local file of the same
// name: \`import stripe\` is the SDK, not routes/stripe.py.
w('requirements.txt', 'stripe>=7.0.0\nrequests\n');
// Always present, not behind a mutation: a manifest that lists the project's
// OWN packages is the normal shape of a Python repo, and reading it as a
// dependency list destroyed 30 real edges while silencing the health warning.
// (No mutation can prove this one red — with the fix in place the manifest is
// harmless by construction. It was observed red in review: edges 30 -> 0.)
w('pyproject.toml', '[project]\nname = "fx"\ndependencies = ["requests"]\n\n[tool.setuptools]\npackages = [\n  "routes",\n  "pkg",\n]\n');
w('py/routes/stripe.py', `LOCAL = True\n`);
// The importer must live INSIDE py/routes/ — that directory then becomes an
// ancestor root, which is exactly how `import stripe` picked up the local
// routes/stripe.py in the real repo.
w('py/routes/uses_stripe.py', `import stripe\nX = 1\n`);
// per-language complexity: `elif`/`except`/`and` are invisible to the C set
w('py/logic.py', `def f(x):
    if x == 1:
        return 1
    elif x == 2:
        return 2
    elif x == 3:
        return 3
    try:
        return x and x or 0
    except ValueError:
        return -1
`);
// markup and generated code must not be scored for complexity
// one tag per line, so this tests markup complexity — not the minified detector
w('markup/form.html', '<form>\n' + '  <label for="a">A</label>\n'.repeat(40) + '</form>\n');
w('sql/schema.sql', '-- if for while case\n'.repeat(30) + 'CREATE TABLE t (id int);\n');
// Real bundlers keep statement-level newlines: the esbuild bundle that defeated
// the old detector averaged 113 chars/line and the rolldown one 30. A fixture
// that is one 4800-char line satisfies every branch and CANNOT fail, which is
// exactly why the detector shipped catching 0 of 15 real artifacts.
w('src/vendor-bundle.min.js', 'var a=1;' + 'a&&a||a?a:a;'.repeat(400) + '\n');
// esbuild-shaped: short lines, no .min. name, and deliberately under src/ —
// a public/ or assets/ path would be caught by the PATH rule, so the fingerprint
// would never actually be exercised and the assertion could not fail.
w('src/app-esbuild.js', 'var x = (() => {\n  var __defProp = Object.defineProperty;\n'
  + Array.from({ length: 120 }, (_, i) => `  var v${i} = a && b || c ? d : e;`).join('\n') + '\n})();\n');
// rolldown-shaped: a banner comment and ordinary line lengths
w('src/app-rolldown.js', '//#region \u0000rolldown/runtime.js\n'
  + Array.from({ length: 120 }, (_, i) => `const q${i} = a && b || c;`).join('\n') + '\n');
// the same built file checked in three times, which no line-length test catches
const DUP = Array.from({ length: 40 }, (_, i) => `export const dup${i} = ${i} && ${i};`).join('\n') + '\n';
// NOT under dist/ — that is in SKIP_DIR and would never be scanned, making the
// assertion pass for the wrong reason.
w('packages/a/shared-copy.js', DUP);
w('packages/b/shared-copy.js', DUP);
w('packages/c/shared-copy.js', DUP);
// A quote inside a REGEX CHARACTER CLASS shifted string parity for the rest of
// the file, so the JSDoc block below was never stripped and its commented-out
// import became a real edge — dead code reported as live, reached from a real
// surface. The inverse of the `"a/*b"` bug, introduced by fixing that one.
w('src/regexquote.ts', `const QUOTE_RE = /["']/g;
/**
 * Usage:
 *   import { ghost } from './ghost.js';
 */
export function strip(s) { return s.replace(QUOTE_RE, ''); }
`);
w('src/ghost.ts', `export const ghost = 1;\n`);
// JSX apostrophes are extremely common and hit the same parity bug.
w('src/apos.tsx', `export function P() {
  return <p>don't stop</p>;
}
/* import { ghost2 } from './ghost2.js'; */
`);
w('src/ghost2.ts', `export const ghost2 = 2;\n`);
// a `/*` inside a STRING must not eat the imports that follow it
w('src/tricky.ts', `const PATTERN = "a/*b";
import { b } from "./b.js";

/** a normal doc block */
export const t = 1;
`);
w('src/a.test.tsx', `import { a } from "./a.js";\nit("works", () => { expect(a(1)).toBe(1); });\nexport const X = () => <div />;\n`);

if (MUTATE === 'alias') w('tsconfig.json', JSON.stringify({ compilerOptions: {} }));
if (MUTATE === 'jsToTs') w('src/a.ts', fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8').replace('./t.js', './nowhere.js'));
if (MUTATE === 'valueCycle') w('src/c.ts', `export function c(n: number) { return n; }\n`);
if (MUTATE === 'pyAbsolute') w('py/app.py', `from nowhere_at_all import leads\n`);
if (MUTATE === 'pyDotDot') w('py/pkg/sub/agent.py', `from .models import DECOY\n`);
// Make the bundles look like ordinary authored code: the detector must then
// fail to drop them, proving these assertions can go red.
if (MUTATE === 'pyHashComment') {
  // Remove the /* from the comment: the imports below it must then survive
  // either way, so this mutation proves the assertion is really testing the
  // stripper rather than passing for an unrelated reason.
  w('py/hashcomment.py', `import nowhere_module\nfrom nowhere import x\n\ndef go():\n    return 1\n`);
}
if (MUTATE === 'pyShadow') w('requirements.txt', 'requests\n');
// A pyproject listing the project's OWN packages must not be read as a
// dependency list: doing so destroyed real edges AND silenced the warning.

if (MUTATE === 'generated') {
  w('src/app-esbuild.js', 'export const realCode = 1;\nexport function f(a) { return a + 1; }\n');
  w('src/app-rolldown.js', 'export const alsoReal = 2;\nexport function g(b) { return b * 2; }\n');
}
if (MUTATE === 'duplicates') {
  w('packages/b/shared-copy.js', 'export const different = 1;\n');
  w('packages/c/shared-copy.js', 'export const alsoDifferent = 2;\n');
}
// Both edges must become value imports: flipping only one leaves no value cycle,
// so a one-sided mutation cannot make the typeCycle assertion fail.
if (MUTATE === 'typeCycle') {
  w('src/t.ts', `import { a } from "./a.js";\nexport type T = { fn: typeof a };\n`);
  w('src/a.ts', fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8').replace('import type { T }', 'import { T }'));
}

const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
git('init', '-q');
git('config', 'user.email', 'fixture@example.com');
git('config', 'user.name', 'Fixture');
git('add', '-A');
git('commit', '-qm', 'fixture');

execFileSync('node', [path.join(HERE, 'scan.mjs'), '--root', dir, '--json-only'], { stdio: ['ignore', 'ignore', 'inherit'] });
const scan = JSON.parse(fs.readFileSync(path.join(dir, '.begin/scan.json'), 'utf8'));
const byFile = new Map(scan.files.map((f) => [f.file, f]));
const cycleSets = scan.cycles.map((c) => new Set(c));
const hasCycle = (...fs_) => cycleSets.some((s) => fs_.every((f) => s.has(f)));

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  ok    ${name}`); return; }
  failed++;
  console.log(`  FAIL  ${name} — ${detail}`);
};

console.log(`begin scan fixture: ${dir}${MUTATE ? `  [mutated: ${MUTATE}]` : ''}`);

check('alias      @/src/b resolves through tsconfig paths',
  byFile.get('src/a.ts')?.imports.includes('src/b.ts'),
  `src/a.ts imports = ${JSON.stringify(byFile.get('src/a.ts')?.imports)}`);

check('jsToTs     "./t.js" resolves to src/t.ts',
  byFile.get('src/a.ts')?.imports.includes('src/t.ts'),
  `src/a.ts imports = ${JSON.stringify(byFile.get('src/a.ts')?.imports)}`);

check('valueCycle b <-> c is reported',
  hasCycle('src/b.ts', 'src/c.ts'),
  `cycles = ${JSON.stringify(scan.cycles)}`);

check('typeCycle  a <-> t is NOT reported (type-only)',
  !hasCycle('src/a.ts', 'src/t.ts'),
  `cycles = ${JSON.stringify(scan.cycles)}`);

check('template   nested-brace template does not erase the file',
  (byFile.get('src/a.ts')?.complexityProxy ?? 0) >= 7,
  `complexityProxy = ${byFile.get('src/a.ts')?.complexityProxy} (expected >= 7 decision points)`);

check('testFirst  .test.tsx is classified test, not ui-component',
  byFile.get('src/a.test.tsx')?.surface === 'test',
  `surface = ${byFile.get('src/a.test.tsx')?.surface}`);

check('surface    package.json exports -> src/index.ts is public-api',
  byFile.get('src/index.ts')?.surface === 'public-api',
  `surface = ${byFile.get('src/index.ts')?.surface}`);

check('surface    app/page.tsx is a web-page',
  byFile.get('app/page.tsx')?.surface === 'web-page',
  `surface = ${byFile.get('app/page.tsx')?.surface}`);

check('reach      src/b.ts is 2 hops from the public-api surface',
  byFile.get('src/b.ts')?.hopsFromSurface === 2,
  `hops = ${byFile.get('src/b.ts')?.hopsFromSurface}`);

check('reach      src/orphan.ts is unreachable from any surface',
  byFile.get('src/orphan.ts')?.hopsFromSurface === null,
  `hops = ${byFile.get('src/orphan.ts')?.hopsFromSurface}`);

// ---- Python
check('py pkglist a pyproject `packages = [...]` list does not destroy local edges',
  byFile.get('py/app.py')?.imports.includes('py/routes/leads.py'),
  'the project\'s own package names must not enter the third-party set');

check('py abs     `from routes import leads` resolves to the package AND the submodules',
  byFile.get('py/app.py')?.imports.includes('py/routes/leads.py') &&
  byFile.get('py/app.py')?.imports.includes('py/routes/users.py'),
  `py/app.py imports = ${JSON.stringify(byFile.get('py/app.py')?.imports)}`);

check('py plain   `import helpers` resolves',
  byFile.get('py/app.py')?.imports.includes('py/helpers.py'),
  `py/app.py imports = ${JSON.stringify(byFile.get('py/app.py')?.imports)}`);

check('py dot     `from . import sibling` reaches the MODULE, not just __init__',
  byFile.get('py/app.py')?.imports.includes('py/sibling.py'),
  `py/app.py imports = ${JSON.stringify(byFile.get('py/app.py')?.imports)}`);

check('py dotdot  `from ..models` hits the PARENT, never the same-named sibling',
  byFile.get('py/pkg/sub/agent.py')?.imports.includes('py/pkg/models.py') &&
  !byFile.get('py/pkg/sub/agent.py')?.imports.includes('py/pkg/sub/models.py'),
  `agent.py imports = ${JSON.stringify(byFile.get('py/pkg/sub/agent.py')?.imports)} (sub/models.py is the decoy)`);

check('py cx      elif/except/and are counted as decision points',
  (byFile.get('py/logic.py')?.complexityProxy ?? 0) >= 6,
  `complexityProxy = ${byFile.get('py/logic.py')?.complexityProxy} (expected >= 6)`);

// ---- complexity must not be inverted by markup / generated code
check('py hash    a `#` comment containing /* does not erase the rest of the file',
  byFile.get('py/hashcomment.py')?.imports.includes('py/helpers.py') &&
  byFile.get('py/hashcomment.py')?.imports.includes('py/routes/leads.py'),
  `imports = ${JSON.stringify(byFile.get('py/hashcomment.py')?.imports)} (both should survive the comment)`);

check('py shadow  a declared dependency never resolves to a local file of the same name',
  !(byFile.get('py/routes/uses_stripe.py')?.imports || []).some((i) => i.endsWith('routes/stripe.py')),
  `imports = ${JSON.stringify(byFile.get('py/routes/uses_stripe.py')?.imports)} (stripe is declared in requirements.txt)`);

check('cx markup  an HTML form scores 0 complexity (<label for=> is not a branch)',
  (byFile.get('markup/form.html')?.complexityProxy ?? -1) === 0,
  `complexityProxy = ${byFile.get('markup/form.html')?.complexityProxy}`);

check('cx sql     a comment-only .sql file scores 0 complexity',
  (byFile.get('sql/schema.sql')?.complexityProxy ?? -1) === 0,
  `complexityProxy = ${byFile.get('sql/schema.sql')?.complexityProxy}`);

const isDropped = (f) => scan.unparsed.some((u) => u.file === f) && !scan.files.some((x) => x.file === f);

check('gen minified a .min.js bundle is flagged and kept OUT of the ranking',
  isDropped('src/vendor-bundle.min.js'),
  `unparsed = ${JSON.stringify(scan.unparsed.map((u) => u.file))}`);

check('gen esbuild  an esbuild bundle with SHORT lines is still detected',
  isDropped('src/app-esbuild.js'),
  'average line length does not catch modern bundlers — a fingerprint must');

check('gen rolldown a rolldown bundle with ordinary line lengths is detected',
  isDropped('src/app-rolldown.js'),
  'the //#region rolldown banner should identify it');

check('gen dupes    a file checked in 3x byte-identical is treated as a build artifact',
  ['packages/a/shared-copy.js', 'packages/b/shared-copy.js', 'packages/c/shared-copy.js'].every(isDropped),
  'content-hash duplicate detection did not fire');

check('strip regex a quote in /["\']/ does not turn a commented-out import into an edge',
  !(byFile.get('src/regexquote.ts')?.imports || []).includes('src/ghost.ts') &&
  (byFile.get('src/ghost.ts')?.fanIn ?? -1) === 0,
  `regexquote imports = ${JSON.stringify(byFile.get('src/regexquote.ts')?.imports)}, ghost fanIn = ${byFile.get('src/ghost.ts')?.fanIn}`);

check('strip jsx   a JSX apostrophe does not fabricate an edge from a comment',
  !(byFile.get('src/apos.tsx')?.imports || []).includes('src/ghost2.ts'),
  `apos imports = ${JSON.stringify(byFile.get('src/apos.tsx')?.imports)}`);

check('strip      `/*` inside a string does not erase the imports after it',
  byFile.get('src/tricky.ts')?.imports.includes('src/b.ts'),
  `src/tricky.ts imports = ${JSON.stringify(byFile.get('src/tricky.ts')?.imports)}`);

// ---- the machine layer must be able to check its own claims
check('graph      fanIn equals the length of the untruncated importedBy list',
  scan.files.every((f) => f.fanIn === f.importedBy.length),
  scan.files.filter((f) => f.fanIn !== f.importedBy.length).map((f) => `${f.file}: fanIn=${f.fanIn} list=${f.importedBy.length}`).join('; '));

check('rank       tests never outrank source on the surface map',
  byFile.get('src/a.test.tsx')?.hopsFromSurface === null || byFile.get('src/a.test.tsx')?.surface === 'test',
  'test file leaked into the surface graph');

fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : '\nall green');
process.exit(failed ? 1 : 0);
