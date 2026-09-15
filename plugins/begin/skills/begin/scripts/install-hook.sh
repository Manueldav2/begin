#!/usr/bin/env bash
# begin/install-hook.sh — make BEGIN.md a living document.
#
# Installs a post-commit hook that re-derives the machine layer and reports which
# BEGIN.md sections the code has outrun.
#
# It never edits a tracked file: `.begin/` ignores itself via `.begin/.gitignore`,
# written by scan.mjs, so the repo's own .gitignore is left alone.
#
# Usage: install-hook.sh [--root DIR] [--uninstall] [--pre-push]

set -uo pipefail

ROOT="$PWD"; MODE="post-commit"; UNINSTALL=0
SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --pre-push) MODE="pre-push"; shift ;;
    *) shift ;;
  esac
done

cd "$ROOT" || exit 2
git rev-parse --git-dir >/dev/null 2>&1 || { echo "begin: not a git repo" >&2; exit 2; }
TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null)" || TOPLEVEL="$ROOT"

# Where git will ACTUALLY look for hooks:
#  - core.hooksPath wins when set (husky sets it; that is the common case in JS repos)
#  - otherwise the COMMON git dir, because inside a worktree `--git-dir` points at
#    .git/worktrees/<name>/ and git never reads hooks from there
HP="$(git config --get core.hooksPath 2>/dev/null || true)"
if [ -n "$HP" ]; then
  case "$HP" in
    /*) HOOKDIR="$HP" ;;
    *)  HOOKDIR="$TOPLEVEL/$HP" ;;
  esac
else
  COMMON="$(git rev-parse --git-common-dir 2>/dev/null || git rev-parse --git-dir)"
  case "$COMMON" in
    /*) HOOKDIR="$COMMON/hooks" ;;
    *)  HOOKDIR="$TOPLEVEL/$COMMON/hooks" ;;
  esac
fi
HOOK="$HOOKDIR/$MODE"
MARK="# >>> begin skill >>>"
ENDMARK="# <<< begin skill <<<"

if [ "$UNINSTALL" = 1 ]; then
  if [ -f "$HOOK" ] && grep -qF "$MARK" "$HOOK"; then
    # Refuse to guess. Without a closing marker, stripping "everything after the
    # start marker" silently deletes whatever the user appended afterwards.
    if ! grep -qF "$ENDMARK" "$HOOK"; then
      echo "begin: $HOOK has our start marker but no end marker — refusing to edit it." >&2
      echo "begin: remove the block between '$MARK' and the end of our snippet by hand." >&2
      exit 3
    fi
    awk -v m="$MARK" -v e="$ENDMARK" '
      $0==m {skip=1; next}
      $0==e {skip=0; next}
      skip==0 {print}
    ' "$HOOK" > "$HOOK.tmp" && mv "$HOOK.tmp" "$HOOK"
    echo "begin: removed the $MODE hook block from $HOOK"
  else
    echo "begin: no hook block to remove"
  fi
  exit 0
fi

mkdir -p "$HOOKDIR"

if [ -f "$HOOK" ] && grep -qF "$MARK" "$HOOK"; then
  echo "begin: $MODE hook already installed at $HOOK"
  exit 0
fi

CREATED=0
if [ ! -f "$HOOK" ]; then
  printf '#!/usr/bin/env bash\n' > "$HOOK"
  CREATED=1
else
  # Appending bash into a python/ruby/node hook breaks BOTH that hook and ours.
  SHEBANG="$(head -1 "$HOOK")"
  case "$SHEBANG" in
    '#!'*sh|'#!'*bash|'#!'*zsh|'#!'*env\ bash|'#!'*env\ sh|'#!'*env\ zsh) ;;
    '#!'*)
      echo "begin: existing $MODE hook is not a shell script:" >&2
      echo "begin:   $SHEBANG" >&2
      echo "begin: refusing to append. Call this line from your hook yourself:" >&2
      echo "begin:   node \"$SCRIPTS/refresh.mjs\" --root \"\$(git rev-parse --show-toplevel)\"" >&2
      exit 3 ;;
  esac
  # A hook whose last line has no newline would be concatenated with our first
  # line, producing a syntax error in the user's working hook.
  if [ -s "$HOOK" ] && [ -n "$(tail -c1 "$HOOK")" ]; then printf '\n' >> "$HOOK"; fi
fi

cat >> "$HOOK" <<EOF
$MARK
# Refreshes the machine layer and reports stale BEGIN.md sections.
# stdout is KEPT so the one-line notice actually reaches you; stderr is dropped
# and the whole thing is backgrounded so it can never slow or fail a commit.
( command -v node >/dev/null 2>&1 && node "$SCRIPTS/refresh.mjs" --root "\$(git rev-parse --show-toplevel)" 2>/dev/null & ) 2>/dev/null
$ENDMARK
EOF

# Only make it executable if we created it. A hook the user deliberately parked
# with chmod -x must stay parked — re-enabling someone else's disabled code is
# not ours to do.
if [ "$CREATED" = 1 ]; then
  chmod +x "$HOOK"
elif [ ! -x "$HOOK" ]; then
  echo "begin: note — $HOOK is not executable, so git will not run it (left as we found it)."
fi

echo "begin: installed $MODE hook -> $HOOK"
echo "begin: .begin/ ignores itself via .begin/.gitignore — your .gitignore is untouched."
