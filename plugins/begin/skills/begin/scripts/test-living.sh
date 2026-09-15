#!/usr/bin/env bash
# Ground-truth test for the living-document layer (refresh.mjs + install-hook.sh).
#
# Asserts the properties that actually matter:
#   - a stamped section goes stale when ITS files change, and only then
#   - a commit that touches an unrelated file leaves the section current
#   - the hook never dirties the working tree
#   - installing preserves a pre-existing hook; uninstalling leaves it intact
#   - a stamp pointing at a vanished commit is reported, not silently ignored

set -uo pipefail
SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="$(mktemp -d)"
FAIL=0
ok()   { echo "  ok    $1"; }
bad()  { echo "  FAIL  $1 — $2"; FAIL=$((FAIL+1)); }

cd "$DIR" || exit 2
git init -q .; git config user.email t@e.com; git config user.name Tester

mkdir -p src
echo 'export const a = 1;' > src/a.ts
echo 'export const b = 2;' > src/b.ts
git add -A; git commit -qm init
SHA0="$(git rev-parse --short HEAD)"

cat > BEGIN.md <<EOF
# BEGIN

<!-- begin:section id="alpha" sha="$SHA0" files="src/a.ts" -->
Alpha explains src/a.ts.

<!-- begin:section id="beta" sha="$SHA0" files="src/b.ts" -->
Beta explains src/b.ts.
EOF
git add -A; git commit -qm 'add BEGIN.md'

echo "== living-document tests in $DIR"

# --- pre-existing hook must survive installation
mkdir -p .git/hooks
printf '#!/usr/bin/env bash\necho "PRE-EXISTING HOOK RAN"\n' > .git/hooks/post-commit
chmod +x .git/hooks/post-commit

bash "$SCRIPTS/install-hook.sh" --root "$DIR" >/dev/null 2>&1
grep -q 'PRE-EXISTING HOOK RAN' .git/hooks/post-commit \
  && ok 'install preserves a pre-existing post-commit hook' \
  || bad 'install preserves a pre-existing hook' 'the original line is gone'
grep -q 'refresh.mjs' .git/hooks/post-commit \
  && ok 'install adds the refresh call' || bad 'install adds refresh call' 'not found in hook'
# (the installer deliberately does NOT touch .gitignore any more — .begin/
#  ignores itself; that is asserted explicitly further down)

# --- nothing changed yet: both sections current
node "$SCRIPTS/refresh.mjs" --root "$DIR" --quiet >/dev/null 2>&1
grep -qE 'All [0-9]+ checkable section' .begin/stale.md \
  && ok 'no change -> nothing stale' || bad 'no change -> nothing stale' "$(head -12 .begin/stale.md | tr '\n' ' ')"

# --- change ONLY src/a.ts: alpha stale, beta current
echo 'export const a = 99;' > src/a.ts
git add -A; git commit -qm 'touch a'
node "$SCRIPTS/refresh.mjs" --root "$DIR" --quiet >/dev/null 2>&1
grep -q '`alpha`' .begin/stale.md \
  && ok 'editing src/a.ts marks alpha stale' || bad 'editing src/a.ts marks alpha stale' "$(cat .begin/stale.md)"
grep -q '`beta`' .begin/stale.md \
  && bad 'beta stays current' 'beta was reported stale by an unrelated edit' \
  || ok 'beta (untouched) stays current'

# --- a brand new unclaimed source file is surfaced
echo 'export const c = 3;' > src/c.ts
git add -A; git commit -qm 'add c'
node "$SCRIPTS/refresh.mjs" --root "$DIR" --quiet >/dev/null 2>&1
grep -q 'src/c.ts' .begin/stale.md \
  && ok 'new unclaimed source file is reported' || bad 'new unclaimed file reported' "$(cat .begin/stale.md)"

# --- the hook must not dirty the working tree
node "$SCRIPTS/refresh.mjs" --root "$DIR" --quiet >/dev/null 2>&1
DIRTY="$(git status --porcelain | grep -v '^?? .begin/' || true)"
[ -z "$DIRTY" ] && ok 'refresh leaves the working tree clean' || bad 'refresh leaves tree clean' "$DIRTY"

# --- a stamp pointing at a commit that no longer exists is reported, not ignored
sed -i.bak 's/sha="[a-f0-9]*" files="src\/b.ts"/sha="deadbee" files="src\/b.ts"/' BEGIN.md && rm -f BEGIN.md.bak
node "$SCRIPTS/refresh.mjs" --root "$DIR" --quiet >/dev/null 2>&1
grep -q 'cannot be checked' .begin/stale.md \
  && ok 'stamp with a vanished commit is reported' || bad 'vanished commit reported' "$(cat .begin/stale.md)"

# --- REGRESSION: re-stamping a section must not blind the unclaimed-file check.
# The old code diffed newestStamp..HEAD, so re-stamping the section SKILL.md tells
# you to update most often permanently silenced this warning.
NEWSHA="$(git rev-parse --short HEAD)"
sed -i.bak "s/id=\"alpha\" sha=\"[a-f0-9]*\"/id=\"alpha\" sha=\"$NEWSHA\"/" BEGIN.md && rm -f BEGIN.md.bak
git add -A; git commit -qm 're-stamp alpha to HEAD'
node "$SCRIPTS/refresh.mjs" --root "$DIR" --quiet >/dev/null 2>&1
grep -q 'src/c.ts' .begin/stale.md \
  && ok 'unclaimed file still reported after a section is re-stamped to HEAD' \
  || bad 'unclaimed survives re-stamp' "$(cat .begin/stale.md)"

# --- a section whose files= names a path that does not exist must be reported
# UNVERIFIABLE, never silently "current" (it produces an empty diff either way).
cat >> BEGIN.md <<'EOF'

<!-- begin:section id="typo" sha="HEADSHA" files="src/does-not-exist.ts" -->
Typo section.
EOF
sed -i.bak "s/sha=\"HEADSHA\"/sha=\"$(git rev-parse --short HEAD)\"/" BEGIN.md && rm -f BEGIN.md.bak
git add -A; git commit -qm 'add typo section'
echo 'export const a = 1234;' > src/a.ts
git add -A; git commit -qm 'touch a again'
node "$SCRIPTS/refresh.mjs" --root "$DIR" --quiet >/dev/null 2>&1
grep -q 'exist at neither' .begin/stale.md \
  && ok 'section with a non-existent files= path is reported unverifiable' \
  || bad 'bad files= reported unverifiable' "$(cat .begin/stale.md)"

# The first version of this check tested the WHOLE list at once, so one valid
# path masked any number of typos beside it — which is the likely shape of the
# mistake, not the all-bogus case.
cat >> BEGIN.md <<'EOF'

<!-- begin:section id="mixed" sha="HEADSHA" files="src/a.ts,src/typo-here.ts" -->
One good path, one typo.
EOF
sed -i.bak "s/sha=\"HEADSHA\"/sha=\"$(git rev-parse --short HEAD)\"/" BEGIN.md && rm -f BEGIN.md.bak
git add -A; git commit -qm 'add mixed section'
node "$SCRIPTS/refresh.mjs" --root "$DIR" --quiet >/dev/null 2>&1
grep -q 'src/typo-here.ts' .begin/stale.md \
  && ok 'a typo beside a VALID path is still reported (per-path, not all-or-nothing)' \
  || bad 'mixed files= check' "$(cat .begin/stale.md)"

# --- a section with NO files= can never go stale, so it must be called out
cat >> BEGIN.md <<EOF

<!-- begin:section id="nofiles" sha="$(git rev-parse --short HEAD)" -->
No files recorded.
EOF
git add -A; git commit -qm 'add nofiles section'
node "$SCRIPTS/refresh.mjs" --root "$DIR" --quiet >/dev/null 2>&1
grep -q 'no files= recorded' .begin/stale.md \
  && ok 'section with no files= is reported unverifiable' \
  || bad 'no files= reported' "$(cat .begin/stale.md)"

# --- the hook must land where git will actually run it when core.hooksPath is set
git config core.hooksPath .myhooks
bash "$SCRIPTS/install-hook.sh" --root "$DIR" >/dev/null 2>&1
[ -f .myhooks/post-commit ] \
  && ok 'install honours core.hooksPath (husky-style repos)' \
  || bad 'install honours core.hooksPath' 'hook not written to .myhooks/'
git config --unset core.hooksPath
rm -rf .myhooks

# --- appending to a hook with no trailing newline must not corrupt it
printf '#!/usr/bin/env bash\necho hi\nexit 0' > .git/hooks/post-commit
chmod +x .git/hooks/post-commit
bash "$SCRIPTS/install-hook.sh" --root "$DIR" >/dev/null 2>&1
bash -n .git/hooks/post-commit 2>/dev/null \
  && ok 'appending to a newline-less hook keeps it syntactically valid' \
  || bad 'newline-less hook stays valid' "$(bash -n .git/hooks/post-commit 2>&1)"

# --- a non-shell hook must be refused, not corrupted
printf '#!/usr/bin/env python3\nprint("py hook")\n' > .git/hooks/post-commit
chmod +x .git/hooks/post-commit
bash "$SCRIPTS/install-hook.sh" --root "$DIR" >/dev/null 2>&1
grep -q 'refresh.mjs' .git/hooks/post-commit \
  && bad 'non-shell hook refused' 'bash was appended into a python hook' \
  || ok 'non-shell hook is refused rather than corrupted'

# --- .begin/ ignores itself without touching the repo's tracked .gitignore
printf '#!/usr/bin/env bash\necho "PRE-EXISTING HOOK RAN"\n' > .git/hooks/post-commit
chmod +x .git/hooks/post-commit
git add -A; git commit -qm 'reset hook' >/dev/null 2>&1 || true
GI_BEFORE="$(cat .gitignore 2>/dev/null || echo NONE)"
bash "$SCRIPTS/install-hook.sh" --root "$DIR" >/dev/null 2>&1
node "$SCRIPTS/scan.mjs" --root "$DIR" --json-only >/dev/null 2>&1
GI_AFTER="$(cat .gitignore 2>/dev/null || echo NONE)"
[ "$GI_BEFORE" = "$GI_AFTER" ] \
  && ok 'installer leaves the tracked .gitignore untouched' \
  || bad 'gitignore untouched' 'installer modified a tracked file'
[ -f .begin/.gitignore ] \
  && ok '.begin/ ignores itself via .begin/.gitignore' \
  || bad '.begin self-ignores' '.begin/.gitignore missing'
git status --porcelain | grep -q '^?? .begin' \
  && bad '.begin is untracked-but-visible' '.begin/ still shows in git status' \
  || ok '.begin/ does not appear in git status'

# --- uninstall removes only our block
bash "$SCRIPTS/install-hook.sh" --root "$DIR" --uninstall >/dev/null 2>&1
grep -q 'PRE-EXISTING HOOK RAN' .git/hooks/post-commit \
  && ok 'uninstall keeps the pre-existing hook' || bad 'uninstall keeps pre-existing hook' 'original hook was destroyed'
grep -q 'refresh.mjs' .git/hooks/post-commit \
  && bad 'uninstall removes our block' 'refresh.mjs still present' \
  || ok 'uninstall removes our block'

cd /; rm -rf "$DIR"
[ "$FAIL" = 0 ] && echo "
all green" || echo "
$FAIL FAILED"
exit "$FAIL"
