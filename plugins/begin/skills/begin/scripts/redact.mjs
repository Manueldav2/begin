#!/usr/bin/env node
// begin/redact.mjs — stdin -> stdout secret scrubber.
//
// Lives in node, not sed, on purpose: BSD sed (macOS default) does not support
// \b word boundaries, so a sed implementation of these rules silently matches
// nothing on the machine most of this runs on. That failure is invisible —
// output looks fine and the token ships anyway.
//
// Run `node redact.mjs --self-test` to prove the rules still fire.

const RULES = [
  // Credentials inside a URL — but NOT a bare `user@host` (ssh://git@github.com
  // is the normal way a git remote looks, and destroying it wrecks the one line
  // recon exists to print). Only redact when there is a user:password pair.
  [/(:\/\/)[^/@\s:]+:[^/@\s]+@/g, '$1***:***@'],

  [/\bgithub_pat_[A-Za-z0-9_]{10,}/g, 'github_pat_***'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, (m) => m.slice(0, 4) + '***'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, 'glpat-***'],
  [/\bnpm_[A-Za-z0-9]{30,}/g, 'npm_***'],
  [/\bhf_[A-Za-z0-9]{30,}/g, 'hf_***'],
  [/\bGOCSPX-[A-Za-z0-9_-]{20,}/g, 'GOCSPX-***'],
  [/\bwhsec_[A-Za-z0-9]{24,}/g, 'whsec_***'],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, 'SG.***'],
  // The tail must be an UNBROKEN alphanumeric run. Allowing hyphens matched the
  // branch name `fix/sk-improve-the-error-message` and rewrote it to `fix/sk-***`.
  [/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9]{20,}/g, 'sk-***'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, 'xox*-***'],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9\/+_-]{20,}/g, 'https://hooks.slack.com/services/***'],
  [/\bAKIA[0-9A-Z]{16}/g, 'AKIA***'],
  [/\bASIA[0-9A-Z]{16}/g, 'ASIA***'],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, 'AIza***'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g, '<jwt-redacted>'],

  // Vendor-prefixed keys (sk_live_…, pk_test_…). These MUST require a long
  // high-entropy tail: matching `sk_` loosely turned the branch name
  // `fix/sk-improve-the-error-message` into `fix/sk-***` and the identifier
  // `mk_config_defaults_table` into `mk_***` — the redactor inventing data.
  [/\b(sk|pk|rk|mk|ak)_(live|test|prod|dev)?_?[A-Za-z0-9]{24,}/g, (m) => m.split('_')[0] + '_***'],

  // Secrets assigned to an obviously-secret name.
  [/\b([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[:=]\s*["']?([^\s"'#,;]{6,})/g,
    (_m, k) => `${k}=***`],

  // AWS secret access keys have no prefix — only shape plus context.
  [/\b(aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*["']?[A-Za-z0-9/+=]{30,}/gi, '$1=***'],

  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, '$1***$2'],
];

export function redact(text) {
  let out = text;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

if (process.argv.includes('--self-test')) {
  // Fixtures are ASSEMBLED at runtime, never written as literals. A repo that
  // contains token-shaped strings trips GitHub push protection and, worse,
  // trains people to ignore secret-scanning alerts. The redactor still sees a
  // fully-formed secret, so the test is unchanged in strength.
  const rep = (c, n) => c.repeat(n);
  const T = {
    gho: 'gho' + '_' + rep('A', 24),
    ghp: 'ghp' + '_' + rep('B', 26),
    skLive: 'sk' + '_live_' + rep('c', 26),
    skProj: 'sk' + '-proj-' + rep('d', 24),
    slack: 'xox' + 'b-' + '123456789-' + rep('e', 12),
    akia: 'AKIA' + rep('Z', 16),
    aiza: 'AIza' + rep('f', 32),
    jwt: 'eyJ' + rep('g', 14) + '.eyJ' + rep('h', 14) + '.' + rep('i', 12),
    glpat: 'glpat' + '-' + rep('J', 20),
    npm: 'npm' + '_' + rep('k', 36),
    hf: 'hf' + '_' + rep('m', 34),
    gocspx: 'GOCSPX' + '-' + rep('n', 24),
    whsec: 'whsec' + '_' + rep('p', 26),
    sg: 'SG' + '.' + rep('Q', 18) + '.' + rep('r', 20),
    hook: 'https://hooks.slack.com/services/' + rep('T', 9) + '/' + rep('B', 9) + '/' + rep('s', 20),
    aws: rep('t', 20) + rep('U', 20),
  };

  const cases = [
    [`https://x-access-token:${T.gho}@github.com/a/b`, T.gho],
    [`token ${T.ghp} here`, T.ghp],
    [`key ${T.skLive}`, T.skLive],
    [`openai ${T.skProj}`, T.skProj],
    [`slack ${T.slack}`, T.slack],
    [`aws ${T.akia}`, T.akia],
    [`google ${T.aiza}`, T.aiza],
    [`jwt ${T.jwt}`, T.jwt.split('.')[0]],
    [`gitlab ${T.glpat}`, T.glpat],
    [`npm ${T.npm}`, T.npm],
    [`hugging ${T.hf}`, T.hf],
    [`google ${T.gocspx}`, T.gocspx],
    [`stripe ${T.whsec}`, T.whsec],
    [`sendgrid ${T.sg}`, T.sg.split('.').slice(0, 2).join('.')],
    [`hook ${T.hook}`, T.hook.split('/').pop()],
    ['DATABASE_PASSWORD=hunter2hunter2', 'hunter2hunter2'],
    [`AWS_SECRET_ACCESS_KEY=${T.aws}`, T.aws],
  ];

  // Text that must survive UNTOUCHED. A redactor that mangles ordinary output is
  // inventing data — branch names and git remotes are exactly what recon prints.
  const cleanCases = [
    'just a normal sentence about src/index.ts and PR #123',
    'ssh://git@github.com/acme/repo.git',
    'git@github.com:acme/repo.git',
    'branch fix/sk-improve-the-error-message',
    'const ak_identifier_for_thing = 1',
    'mk_config_defaults_table',
    'feat(pk_test): rename pk_test_placeholder_value',
    'https://github.com/acme/repo/pull/2310',
    'run `npm_config_cache` to see the path',
  ];

  let bad = 0;
  for (const [input, mustNotSurvive] of cases) {
    const got = redact(input);
    const leaked = got.includes(mustNotSurvive);
    console.log(`  ${leaked ? 'LEAK ' : 'ok   '} ${input.slice(0, 52)}  ->  ${got.slice(0, 52)}`);
    if (leaked) bad++;
  }
  // A redactor that mangles clean text is as damaging as one that leaks: it puts
  // fabricated strings into a document the reader trusts.
  for (const clean of cleanCases) {
    const got = redact(clean);
    if (got !== clean) { console.log(`  MANGLED  ${clean}  ->  ${got}`); bad++; }
    else console.log(`  ok       (unchanged) ${clean.slice(0, 48)}`);
  }
  console.log(bad ? `\n${bad} FAILED` : '\nall green');
  process.exit(bad ? 1 : 0);
} else {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { buf += d; });
  process.stdin.on('end', () => process.stdout.write(redact(buf)));
}
