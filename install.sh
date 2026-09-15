#!/usr/bin/env bash
# begin — one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Manueldav2/begin/main/install.sh | bash
#
# Installs the skill into ~/.claude/skills/begin (all projects), or into
# ./.claude/skills/begin with --project. Downloads a tarball of the repo when run
# via curl; copies from disk when run from a clone.
#
#   --project   install into ./.claude/skills (this repo only)
#   --to DIR    install into DIR/begin
#   --ref REF   install a specific branch or tag (default: main)

set -euo pipefail

REPO="Manueldav2/begin"
REF="main"
DEST_ROOT="$HOME/.claude/skills"

while [ $# -gt 0 ]; do
  case "$1" in
    --project) DEST_ROOT="$PWD/.claude/skills"; shift ;;
    --to) DEST_ROOT="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) shift ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "begin: needs node 18+ on PATH" >&2; exit 1; }
command -v git  >/dev/null 2>&1 || { echo "begin: needs git on PATH" >&2; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 18 ] || { echo "begin: needs node 18+, found $(node -v)" >&2; exit 1; }

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
SRC=""
if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/plugins/begin/skills/begin/SKILL.md" ]; then
  SRC="$SELF_DIR/plugins/begin/skills/begin"          # running from a clone
fi

TMP=""
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; }
trap cleanup EXIT

if [ -z "$SRC" ]; then
  # piped from curl: fetch a tarball of the ref
  TMP="$(mktemp -d)"
  URL="https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF"
  echo "begin: downloading $REPO@$REF"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$URL" | tar -xz -C "$TMP" || { echo "begin: download failed ($URL)" >&2; exit 1; }
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$URL" | tar -xz -C "$TMP" || { echo "begin: download failed ($URL)" >&2; exit 1; }
  else
    echo "begin: needs curl or wget" >&2; exit 1
  fi
  SRC="$(find "$TMP" -type d -path '*/plugins/begin/skills/begin' | head -1)"
  [ -n "$SRC" ] || { echo "begin: tarball did not contain the skill" >&2; exit 1; }
fi

DEST="$DEST_ROOT/begin"
mkdir -p "$DEST_ROOT"
if [ -d "$DEST" ]; then
  echo "begin: replacing existing install at $DEST"
  rm -rf "$DEST"
fi
mkdir -p "$DEST"
cp -R "$SRC/." "$DEST/"
rm -rf "$DEST/.begin"
chmod +x "$DEST"/scripts/*.sh "$DEST"/scripts/*.mjs 2>/dev/null || true

echo "begin: installed -> $DEST"
echo
echo "begin: verifying the install by running its own test suites"
FAIL=0
run() { printf '  %s  %s\n' "$($1 >/dev/null 2>&1 && echo 'ok  ' || { FAIL=1; echo 'FAIL'; })" "$2"; }
run "node $DEST/scripts/test-scan.mjs"        "test-scan.mjs  (import graph, cycles, surfaces)"
run "bash $DEST/scripts/test-living.sh"       "test-living.sh (staleness, hooks, tree cleanliness)"
run "node $DEST/scripts/redact.mjs --self-test" "redact.mjs     (secret scrubbing)"

echo
if [ "$FAIL" = 0 ]; then
  cat <<'DONE'
begin: ready.

  In Claude Code, inside any git repo:

    /begin          orient, and write BEGIN.md
    /begin update   refresh only the sections the code has outrun

DONE
else
  echo "begin: installed, but a self-test failed. Run the suites by hand before trusting its output." >&2
  exit 1
fi
