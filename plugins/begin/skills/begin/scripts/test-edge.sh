#!/usr/bin/env bash
# Edge-case regressions for `begin`.
#
# Every case here is a defect that was FOUND IN REVIEW and fixed. They live in
# their own suite because each needs a purpose-built repo, and because a fix that
# was only ever verified by reading the code is not a fix — it is a claim.

set -uo pipefail
SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAIL=0
ok()  { echo "  ok    $1"; }
bad() { echo "  FAIL  $1 — $2"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d)"
trap 'cd /; rm -rf "$WORK"' EXIT
echo "== edge-case regressions in $WORK"

newrepo() {                       # newrepo <name> [author]
  local d="$WORK/$1"
  mkdir -p "$d/src"; cd "$d" || exit 2
  git init -q -b main .
  git config user.email t@e.com
  git config user.name "${2:-Tester}"
  echo 'export const a = 1;' > src/a.ts
  git add -A; git commit -qm init
}

# ---------------------------------------------------------------- git plumbing

# Non-ASCII paths: `git log --name-only` quotes and octal-escapes them, so they
# never matched `ls-files -z` output and silently scored churn 0 — losing 1.6 of
# the 3.6 score weight for those files.
newrepo quotepath
printf 'export const x=1;\n' > src/café.ts
printf 'export const y=1;\n' > "src/has space.ts"
git add -A; git commit -qm add
printf 'export const x=2;\n' > src/café.ts
git commit -qam edit
node "$SCRIPTS/scan.mjs" --json-only >/dev/null 2>&1
ACC="$(node -e 'const s=require(process.argv[1]);const f=s.files.find(x=>x.file.includes("caf"));console.log(f?f.commits:0)' "$PWD/.begin/scan.json" 2>/dev/null)"
[ "${ACC:-0}" -ge 2 ] && ok 'non-ASCII filenames accumulate churn' \
  || bad 'non-ASCII churn' "commits=$ACC, expected >= 2"
SPC="$(node -e 'const s=require(process.argv[1]);const f=s.files.find(x=>x.file.includes("has space"));console.log(f?f.commits:0)' "$PWD/.begin/scan.json" 2>/dev/null)"
[ "${SPC:-0}" -ge 1 ] && ok 'filenames with spaces accumulate churn' \
  || bad 'spaced filename churn' "commits=$SPC"

# A git user.name containing regex metacharacters used to crash the whole scan
# with an uncaught SyntaxError from `new RegExp(name)`.
newrepo authorregex 'Tester (Test) [x] +1'
node "$SCRIPTS/scan.mjs" --json-only >/dev/null 2>&1 \
  && ok 'a git user.name full of regex metacharacters does not crash the scan' \
  || bad 'author regex' 'scan exited non-zero'

# `--top` with no value produced `parseInt(undefined)` -> "Top NaN" and an empty
# table, exit 0: the entire point of the scan silently absent.
newrepo topflag
node "$SCRIPTS/scan.mjs" --top 2>/dev/null | grep -q 'Top NaN' \
  && bad '--top with no value' 'still prints Top NaN' \
  || ok '--top with no value falls back to the default instead of NaN'

# ---------------------------------------------------------------- honest errors

# "not a git repo" was printed for a repo that IS one but has no commits yet —
# the first thing a user of a brand-new project would see, and false.
# NB: capture first, grep second. `set -o pipefail` propagates the scan's
# intentional exit 2 and would fail the check even when grep matched.
mkdir -p "$WORK/nocommits"; cd "$WORK/nocommits"; git init -q -b main .; echo x > a.ts
MSG="$(node "$SCRIPTS/scan.mjs" 2>&1 || true)"
case "$MSG" in
  *'no commits yet'*) ok 'a git repo with no commits says so (not "not a git repo")' ;;
  *) bad 'no-commit message' "$MSG" ;;
esac

mkdir -p "$WORK/notarepo"; cd "$WORK/notarepo"
MSG="$(node "$SCRIPTS/scan.mjs" 2>&1 || true)"
case "$MSG" in
  *'not a git repository'*) ok 'a non-repo says it is a non-repo' ;;
  *) bad 'non-repo message' "$MSG" ;;
esac

# ---------------------------------------------------------------- hooks

# In a worktree, `--git-dir` points at .git/worktrees/<name>/, where git never
# looks for hooks: the installer reported success and nothing ever ran.
newrepo worktree
git worktree add -q "$WORK/wt" -b wt 2>/dev/null
cd "$WORK/wt" || exit 2
bash "$SCRIPTS/install-hook.sh" --root "$WORK/wt" >/dev/null 2>&1
[ -f "$WORK/worktree/.git/hooks/post-commit" ] \
  && ok 'worktree install lands in the COMMON git dir where git looks' \
  || bad 'worktree hook placement' 'hook not in the common .git/hooks'
echo 'export const a = 7;' > src/a.ts
HOOKOUT="$(git -c user.email=t@e.com -c user.name=T commit -qam wt 2>&1)"
printf '%s' "$HOOKOUT" | grep -q 'begin:' \
  && ok 'the hook actually fires and prints from inside a worktree' \
  || bad 'worktree hook fires' "commit output: $HOOKOUT"
cd "$WORK/worktree" && git worktree remove --force "$WORK/wt" 2>/dev/null

# Uninstall used to delete everything after the start marker when the end marker
# was gone, silently eating whatever the user had appended.
newrepo uninstall
printf '#!/usr/bin/env bash\necho ORIGINAL\n' > .git/hooks/post-commit
chmod +x .git/hooks/post-commit
bash "$SCRIPTS/install-hook.sh" --root "$PWD" >/dev/null 2>&1
grep -v '<<< begin skill <<<' .git/hooks/post-commit > h.tmp && mv h.tmp .git/hooks/post-commit
echo 'echo USER_APPENDED_STEP' >> .git/hooks/post-commit
bash "$SCRIPTS/install-hook.sh" --root "$PWD" --uninstall >/dev/null 2>&1
grep -q 'USER_APPENDED_STEP' .git/hooks/post-commit \
  && ok 'uninstall refuses to truncate when the end marker is missing' \
  || bad 'uninstall truncation' "the user's appended step was deleted"

# A hook parked with `chmod -x` is disabled on purpose; re-enabling someone
# else's disabled code is not ours to do.
newrepo chmodhook
printf '#!/usr/bin/env bash\necho PARKED\n' > .git/hooks/post-commit
chmod -x .git/hooks/post-commit
bash "$SCRIPTS/install-hook.sh" --root "$PWD" >/dev/null 2>&1
[ -x .git/hooks/post-commit ] \
  && bad 'disabled hook stays disabled' 'install re-enabled a parked hook' \
  || ok 'a deliberately disabled hook is not re-enabled by install'

# ---------------------------------------------------------------- recon

# recon.sh piped everything through `node redact.mjs`. With no node it wrote a
# ZERO-BYTE recon.md and exited 0, so an agent read an empty file and concluded
# the repo had no recent activity.
newrepo nonode
env PATH=/usr/bin:/bin bash "$SCRIPTS/recon.sh" --root "$PWD" >/dev/null 2>&1
RC=$?
if [ "$RC" != 0 ] && [ ! -s .begin/recon.md ]; then
  ok 'recon fails loudly without node instead of writing an empty report'
else
  bad 'recon without node' "exit=$RC, recon.md size=$(wc -c < .begin/recon.md 2>/dev/null || echo missing)"
fi

# `awk '{print $2}'` split on whitespace, so `src/has space.ts` was reported as
# the path `src/has` — a file that does not exist.
newrepo reconpaths
printf 'export const y=1;\n' > "src/two words.ts"
git add -A; git commit -qm add
bash "$SCRIPTS/recon.sh" --root "$PWD" >/dev/null 2>&1
if grep -q 'two words.ts' .begin/recon.md 2>/dev/null && ! grep -qE '^- `src/two` ' .begin/recon.md 2>/dev/null; then
  ok 'recon does not fabricate truncated paths for filenames with spaces'
else
  bad 'recon path fabrication' "$(grep -n 'src/two' .begin/recon.md | head -3)"
fi

# `gh` being installed and authenticated is GLOBAL state and says nothing about
# whether THIS repo is on GitHub; the merge-commit fallback never ran.
newrepo ghfallback
git checkout -q -b side; echo 'export const z=1;' > src/z.ts
git add -A; git commit -qm side
git checkout -q main; git merge -q --no-ff side -m "Merge branch 'side'" 2>/dev/null
bash "$SCRIPTS/recon.sh" --root "$PWD" >/dev/null 2>&1
grep -q "Merge branch 'side'" .begin/recon.md \
  && ok 'a local-only repo falls back to listing merge commits' \
  || bad 'gh fallback' 'no merge commits listed for a non-GitHub repo'

# ---------------------------------------------------------------- honesty about blind spots

# A language whose imports are not parsed produced 0 edges, declared every file
# "unreachable (dead code)", and said NOTHING — because the health check was
# gated on a JS/Python allowlist instead of on the evidence.
mkdir -p "$WORK/gorepo/pkg/alpha" "$WORK/gorepo/cmd/app"; cd "$WORK/gorepo"
git init -q -b main .; git config user.email t@e.com; git config user.name T
for i in $(seq 1 12); do printf 'package alpha\nfunc F%s() int { return %s }\n' "$i" "$i" > "pkg/alpha/f$i.go"; done
printf 'package main\nimport "example.com/m/pkg/alpha"\nfunc main() { _ = alpha.F1() }\n' > cmd/app/main.go
printf 'module example.com/m\ngo 1.21\n' > go.mod
git add -A; git commit -qm init
GOOUT="$(node "$SCRIPTS/scan.mjs" 2>/dev/null)"
case "$GOOUT" in
  *'.go` imports are not parsed'*) ok 'a Go repo is told its imports are not parsed, not silently emptied' ;;
  *) bad 'unparsed-language warning' 'no warning for a 13-file Go repo with 0 edges' ;;
esac

# ---------------------------------------------------------------- concurrency

# The post-commit hook runs a scan on EVERY commit, so two scans racing is the
# normal case. A non-atomic write produced spliced JSON in half of concurrent
# reads, and a spliced scan.md has no parse step to catch it.
newrepo concurrent
for i in $(seq 1 120); do
  printf 'import { a } from "./a.js";\nexport const v%s = a + %s;\n' "$i" "$i" > "src/f$i.ts"
done
git add -A; git commit -qm bulk
# Seed one complete scan.json FIRST, so a read that lands before any writer
# finishes is a missing file, not a corrupt one — otherwise the test measures
# its own startup race instead of tearing.
node "$SCRIPTS/scan.mjs" --json-only >/dev/null 2>&1
for i in 1 2 3 4 5; do node "$SCRIPTS/scan.mjs" --json-only >/dev/null 2>&1 & done
TORN=0
for i in $(seq 1 60); do
  OUT="$(node -e '
    const fs=require("fs");
    let t; try { t = fs.readFileSync(process.argv[1],"utf8"); } catch { console.log("MISSING"); process.exit(0); }
    try { JSON.parse(t); console.log("OK"); } catch (e) { console.log("TORN"); }
  ' "$PWD/.begin/scan.json" 2>/dev/null)"
  [ "$OUT" = "TORN" ] && TORN=$((TORN+1))
done
wait
[ "$TORN" = 0 ] && ok 'concurrent scans never expose a torn scan.json' \
  || bad 'concurrent scan tearing' "$TORN torn reads of 60"

cd /
[ "$FAIL" = 0 ] && echo "
all green" || echo "
$FAIL FAILED"
exit "$FAIL"
