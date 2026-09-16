#!/usr/bin/env node
// Class-parameterised tests.
//
// WHY THIS FILE EXISTS. The other suites pin one assertion per historical bug:
// `/["']/`, `requirements.txt`, a column-0 fence. Three review rounds in a row
// found that fixing a bug shipped a NEW bug of the SAME CLASS, while every one
// of those pinned assertions stayed green — "all green" had come to mean "the
// last three bugs are still fixed".
//
// So each block below enumerates a whole class and asserts the INVARIANT over
// every member. Adding a dialect or a quoting context is one line here, and a
// regression anywhere in the class fails immediately.
//
// Invariants under test:
//   A. A commented-out or quoted import NEVER becomes a graph edge,
//      and a real import beside it ALWAYS survives.
//   B. A declared third-party package NEVER resolves to a local file of the
//      same name, in ANY manifest dialect — and a real local package is NEVER
//      destroyed by a manifest.
//   C. A stamp inside a code fence is NEVER parsed, and a real stamp outside
//      one is NEVER swallowed, for ANY CommonMark fence style.
//
// Run: node test-classes.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
const ok = (n) => console.log(`  ok    ${n}`);
const bad = (n, d) => { failed++; console.log(`  FAIL  ${n} — ${d}`); };

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'begin-class-'));
  for (const [p, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), body);
  }
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@e.com');
  g('config', 'user.name', 'T');
  g('add', '-A');
  g('commit', '-qm', 'init');
  return dir;
}
function scan(dir) {
  execFileSync('node', [path.join(HERE, 'scan.mjs'), '--root', dir, '--json-only'], { stdio: ['ignore', 'ignore', 'ignore'] });
  const j = JSON.parse(fs.readFileSync(path.join(dir, '.begin/scan.json'), 'utf8'));
  return new Map(j.files.map((f) => [f.file, f]));
}

// ───────────────────────────── A. quoting / comment contexts

console.log('\nCLASS A — a commented-out import never becomes an edge, a real one always survives');

// Each case supplies a body that (a) contains `./ghost.js` ONLY inside a comment,
// a string or a template, and (b) contains a real import of `./real.js`.
const quoting = {
  'block comment': `import { r } from "./real.js";\n/* import { g } from "./ghost.js"; */\nexport const a = r;\n`,
  'line comment': `import { r } from "./real.js";\n// import { g } from "./ghost.js";\nexport const a = r;\n`,
  'jsdoc example': `import { r } from "./real.js";\n/**\n * import { g } from "./ghost.js";\n */\nexport const a = r;\n`,
  'regex with quotes': `import { r } from "./real.js";\nconst RE = /["']/g;\n/* import { g } from "./ghost.js"; */\nexport const a = r + RE.source;\n`,
  'regex with backtick': "import { r } from \"./real.js\";\nconst RE = /[`]/g;\n/* import { g } from \"./ghost.js\"; */\nconst t = `x`;\nexport const a = r + t;\n",
  'regex with slash class': `import { r } from "./real.js";\nconst RE = /[/"']/g;\n// import { g } from "./ghost.js";\nexport const a = r;\n`,
  'jsx apostrophe next line': `import { r } from "./real.js";\nexport const P = () => <p>don't stop</p>;\n// import { g } from "./ghost.js";\n`,
  'jsx apostrophe same line': `import { r } from "./real.js";\nexport const P = () => <p>don't</p>; // import { g } from "./ghost.js";\n`,
  'multiline template': "import { r } from \"./real.js\";\nconst t = `line one\n// import { g } from \"./ghost.js\";\nline two`;\nexport const a = r + t;\n",
  'nested template': "import { r } from \"./real.js\";\nconst t = `a ${`b`}\n// import { g } from \"./ghost.js\";\nc`;\nexport const a = r + t;\n",
  'string containing /*': `import { r } from "./real.js";\nconst P = "a/*b";\n/* import { g } from "./ghost.js"; */\nexport const a = r + P;\n`,
  'string containing //': `import { r } from "./real.js";\nconst U = "https://example.com";\n/* import { g } from "./ghost.js"; */\nexport const a = r + U;\n`,
  'apostrophe in block comment': `import { r } from "./real.js";\n/* don't do this: import { g } from "./ghost.js"; */\nexport const a = r;\n`,
  'CRLF line comment': `import { r } from "./real.js";\r\n// import { g } from "./ghost.js";\r\nexport const a = r;\r\n`,
  'trailing backslash string': `import { r } from "./real.js";\nconst s = "ends with backslash \\\\";\n// import { g } from "./ghost.js";\nexport const a = r + s;\n`,
};

for (const [name, body] of Object.entries(quoting)) {
  const ext = name.startsWith('jsx') ? 'jsx' : 'js';
  const dir = repo({
    'package.json': '{"name":"q"}',
    [`src/subject.${ext}`]: body,
    'src/real.js': 'export const r = 1;\n',
    'src/ghost.js': 'export const g = 2;\n',
  });
  try {
    const by = scan(dir);
    const subj = by.get(`src/subject.${ext}`);
    const imports = subj?.imports || [];
    const fabricated = imports.includes('src/ghost.js');
    const realKept = imports.includes('src/real.js');
    if (fabricated) bad(`A/${name}`, `fabricated an edge to src/ghost.js (imports=${JSON.stringify(imports)})`);
    else if (!realKept) bad(`A/${name}`, `DESTROYED the real edge to src/real.js (imports=${JSON.stringify(imports)})`);
    else ok(`A/${name}`);
  } catch (e) { bad(`A/${name}`, `scan threw: ${e.message.slice(0, 90)}`); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Python: a docstring usage example must not become an edge either.
{
  const dir = repo({
    'app/__init__.py': '',
    'app/util.py': 'def helper(): return 1\n',
    'app/real.py': 'VALUE = 1\n',
    'app/main.py': '"""Entry.\n\nExample::\n\n    from app.util import helper\n    import app.util\n"""\nfrom app.real import VALUE\n',
  });
  try {
    const by = scan(dir);
    const imports = by.get('app/main.py')?.imports || [];
    if (imports.includes('app/util.py')) bad('A/python docstring example', `docstring became an edge (${JSON.stringify(imports)})`);
    else if (!imports.includes('app/real.py')) bad('A/python docstring example', `real import lost (${JSON.stringify(imports)})`);
    else ok('A/python docstring example');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ───────────────────────────── B. Python manifest dialects

console.log('\nCLASS B — a declared dependency never shadows a local file, in any manifest dialect');

const manifests = {
  'PEP621 inline': ['pyproject.toml', '[project]\nname = "x"\ndependencies = ["stripe"]\n'],
  'PEP621 multiline': ['pyproject.toml', '[project]\nname = "x"\ndependencies = [\n  "stripe",\n]\n'],
  'PEP621 optional extras': ['pyproject.toml', '[project]\nname = "x"\n\n[project.optional-dependencies]\npay = ["stripe"]\n'],
  'poetry table': ['pyproject.toml', '[tool.poetry.dependencies]\npython = "^3.11"\nstripe = "^7.0"\n'],
  'pipfile packages': ['Pipfile', '[[source]]\nname = "pypi"\n\n[packages]\nstripe = "*"\n'],
  'pipfile dev-packages': ['Pipfile', '[dev-packages]\nstripe = "*"\n'],
  'setup.cfg install_requires': ['setup.cfg', '[options]\ninstall_requires =\n    stripe\n    requests\n'],
  'requirements pinned': ['requirements.txt', 'stripe==7.0.0\nrequests\n'],
  'requirements with extras': ['requirements.txt', 'stripe[webhooks]>=7\n'],
};

for (const [name, [file, body]] of Object.entries(manifests)) {
  const dir = repo({
    [file]: body,
    'routes/__init__.py': '',
    'routes/stripe.py': 'LOCAL = True\n',
    'routes/app.py': 'import stripe\nX = 1\n',
  });
  try {
    const by = scan(dir);
    const imports = by.get('routes/app.py')?.imports || [];
    if (imports.some((i) => i.endsWith('routes/stripe.py'))) bad(`B/${name}`, `fabricated a local edge for a declared package (${JSON.stringify(imports)})`);
    else ok(`B/${name}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The inverse: a manifest must never DESTROY a real local package.
const localPkgCases = {
  'setuptools packages list': ['pyproject.toml', '[project]\nname = "x"\n\n[tool.setuptools]\npackages = [\n  "myapp",\n]\n'],
  'PEP420 namespace pkg + self-listed': ['pyproject.toml', '[project]\nname = "myapp"\ndependencies = ["myapp", "requests"]\n'],
  'packages.find': ['pyproject.toml', '[tool.setuptools.packages.find]\nwhere = ["."]\ninclude = ["myapp*"]\n'],
};
for (const [name, [file, body]] of Object.entries(localPkgCases)) {
  const withInit = !name.includes('PEP420');
  const files = {
    [file]: body,
    'myapp/engine.py': 'VALUE = 1\n',
    'myapp/api.py': 'from myapp.engine import VALUE\nX = VALUE\n',
  };
  if (withInit) files['myapp/__init__.py'] = '';
  const dir = repo(files);
  try {
    const by = scan(dir);
    const imports = by.get('myapp/api.py')?.imports || [];
    if (!imports.includes('myapp/engine.py')) bad(`B/local: ${name}`, `manifest DESTROYED a real local edge (${JSON.stringify(imports)})`);
    else ok(`B/local: ${name}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ───────────────────────────── C. CommonMark fence styles

console.log('\nCLASS C — doc stamps in fences are never parsed, real stamps are never swallowed');

function staleFor(dir) {
  execFileSync('node', [path.join(HERE, 'refresh.mjs'), '--root', dir, '--quiet'], { stdio: ['ignore', 'ignore', 'ignore'] });
  return fs.readFileSync(path.join(dir, '.begin/stale.md'), 'utf8');
}

const fences = {
  'column-0 backtick': ['```markdown', '```'],
  'indented 2 spaces': ['  ```markdown', '  ```'],
  'indented 3 spaces': ['   ```', '   ```'],
  'tilde fence': ['~~~markdown', '~~~'],
  'blockquoted fence': ['> ```', '> ```'],
  'four backticks': ['````', '````'],
};

for (const [name, [open, close]] of Object.entries(fences)) {
  const dir = repo({ 'src/a.ts': 'export const a = 1;\n' });
  const sha = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(dir, 'BEGIN.md'),
    `# B\n\n<!-- begin:section id="real" sha="${sha}" files="src/a.ts" -->\nReal prose.\n\n`
    + `Here is how to stamp a section:\n\n${open}\n<!-- begin:section id="DOCEXAMPLE" sha="deadbee" files="src/nonexistent.ts" -->\n${close}\n\nAfter the fence.\n`);
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'begin'], { stdio: 'ignore' });
  try {
    const stale = staleFor(dir);
    if (stale.includes('DOCEXAMPLE')) bad(`C/${name}`, 'a documentation stamp inside a fence was parsed as a real section');
    else if (!/1 stamped section|All 1 checkable/.test(stale)) bad(`C/${name}`, `the real stamp was swallowed: ${stale.split('\n').slice(0, 6).join(' | ')}`);
    else ok(`C/${name}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// An unclosed fence must be announced, never silently eat the rest of the file.
{
  const dir = repo({ 'src/a.ts': 'export const a = 1;\n' });
  const sha = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(dir, 'BEGIN.md'),
    `# B\n\n\`\`\`\nunclosed fence starts here\n\n<!-- begin:section id="swallowed" sha="${sha}" files="src/a.ts" -->\nProse.\n`);
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'begin'], { stdio: 'ignore' });
  try {
    const stale = staleFor(dir);
    if (/unclosed code fence|were \*\*not parsed\*\*|not parsed/.test(stale)) ok('C/unclosed fence is announced');
    else bad('C/unclosed fence is announced', `no warning; staleness silently disabled: ${stale.split('\n').slice(0, 8).join(' | ')}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log(failed ? `\n${failed} FAILED` : '\nall green');
process.exit(failed ? 1 : 0);
