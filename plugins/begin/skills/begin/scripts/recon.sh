#!/usr/bin/env bash
# begin/recon.sh — the human layer: what this repo is, and what YOU have been
# doing in it lately. Pairs with scan.mjs (the structural layer).
#
# Writes .begin/recon.md and prints it. Degrades gracefully with no `gh`,
# no network, and no GitHub remote.
#
# Usage: recon.sh [--root DIR] [--since "90 days ago"] [--prs N] [--author PATTERN]

set -uo pipefail

ROOT="$PWD"; SINCE="90 days ago"; PRS=20; AUTHOR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --since) SINCE="$2"; shift 2 ;;
    --prs) PRS="$2"; shift 2 ;;
    --author) AUTHOR="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Everything this script writes is meant to be read by an agent and possibly
# committed, so every byte goes through here first. A git remote URL routinely
# carries a live token (git remote get-url printed a working gho_… on the repo
# this was built in) and recon output must never become the place it leaks from.
redact() {
  # Delegated to node: BSD sed has no \b, so a sed version of these rules
  # matches nothing on macOS and the secret ships anyway. Proven by
  # `node redact.mjs --self-test`.
  node "$(dirname "${BASH_SOURCE[0]}")/redact.mjs"
}

command -v node >/dev/null 2>&1 || {
  echo "begin: recon.sh needs node on PATH — redaction is mandatory and must not be skipped" >&2
  exit 2
}

cd "$ROOT" || exit 2
git rev-parse --git-dir >/dev/null 2>&1 || { echo "begin: $ROOT is not a git repo" >&2; exit 2; }

# Captured BEFORE .begin/ exists, so the tool never reports its own output
# directory as "the live edit".
DIRTY_RAW="$(git -c core.quotepath=false status --porcelain | grep -v '^?? \.begin/' || true)"

OUT_DIR="$ROOT/.begin"; mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/recon.md"

# Fall back to the committer identity if no author filter was given, so
# "what have I been working on" means something on a first run.
[ -z "$AUTHOR" ] && AUTHOR="$(git config user.name 2>/dev/null || true)"
# In a repo you did not write, your own name matches nothing and every "your
# recent work" section comes back empty with no explanation. Fall back to the
# repo's most prolific author and SAY that is what happened.
AUTHOR_NOTE=""
if [ -n "$AUTHOR" ] && [ -z "$(git log --since="$SINCE" --author="$AUTHOR" --oneline 2>/dev/null | head -1)" ]; then
  TOPAUTHOR="$(git shortlog -sn --no-merges --since="$SINCE" 2>/dev/null | head -1 | sed 's/^[[:space:]]*[0-9]*[[:space:]]*//')"
  if [ -n "$TOPAUTHOR" ]; then
    AUTHOR_NOTE="you (\"$AUTHOR\") have no commits in this window — showing the repo's most active author instead"
    AUTHOR="$TOPAUTHOR"
  fi
fi

{
echo "# begin recon — $(basename "$ROOT")"
echo
echo "_generated $(date -u +%Y-%m-%dT%H:%M:%SZ) · window \"$SINCE\" · author = \"${AUTHOR:-unknown}\"_"
[ -n "$AUTHOR_NOTE" ] && { echo; echo "> [!NOTE]"; echo "> $AUTHOR_NOTE"; }
echo

echo "## Repo identity"
echo
echo "- remote: \`$(git remote get-url origin 2>/dev/null || echo 'none')\`"
DEFAULT_BRANCH="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|origin/||')"
[ -z "$DEFAULT_BRANCH" ] && DEFAULT_BRANCH="$(git branch -rl 'origin/main' 'origin/master' 2>/dev/null | head -1 | sed 's|.*origin/||' | tr -d ' ')"
[ -z "$DEFAULT_BRANCH" ] && DEFAULT_BRANCH=main
echo "- default branch: \`$DEFAULT_BRANCH\` · current: \`$(git rev-parse --abbrev-ref HEAD)\` · HEAD \`$(git rev-parse --short HEAD)\`"
echo "- tracked files: $(git ls-files | wc -l | tr -d ' ')"
for f in CLAUDE.md AGENTS.md CONTRIBUTING.md README.md CHANGELOG.md; do
  [ -f "$f" ] && echo "- has \`$f\`"
done
echo

DIRTY="$(printf '%s\n' "$DIRTY_RAW" | head -40)"
if [ -n "$DIRTY" ]; then
  # An uncommitted diff made only of lockfiles and build output is npm noise,
  # not "the question the user is holding". Saying so stops the agent burning
  # its first and most valuable read on nothing.
  SIGNAL="$(printf '%s\n' "$DIRTY_RAW" | grep -vE '(node_modules/|dist/|build/|\.next/|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.DS_Store)' || true)"
  if [ -z "$SIGNAL" ]; then
    echo "## Uncommitted right now — looks like tooling noise, not a live edit"
    echo
    echo "_Only lockfiles / build output / node_modules changed. Do not spend your first read here._"
    echo
  else
    echo "## Uncommitted right now (this is the live edit — read it first)"
  fi
  echo
  echo '```'
  echo "$DIRTY"
  echo '```'
  echo
  echo "Diffstat vs HEAD:"
  echo
  echo '```'
  git diff --stat HEAD 2>/dev/null | tail -25
  echo '```'
  echo
fi

AHEAD="$(git log --oneline "origin/$DEFAULT_BRANCH..HEAD" 2>/dev/null | head -30)"
if [ -n "$AHEAD" ]; then
  echo "## On this branch, not yet on $DEFAULT_BRANCH"
  echo
  echo '```'
  echo "$AHEAD"
  echo '```'
  echo
  echo "Files this branch touches:"
  echo
  echo '```'
  git diff --name-only "origin/$DEFAULT_BRANCH...HEAD" 2>/dev/null | head -40
  echo '```'
  echo
fi

echo "## Your recent commits (window: $SINCE)"
echo
if [ -n "$AUTHOR" ]; then
  git log --since="$SINCE" --author="$AUTHOR" --no-merges --date=short \
    --pretty='- %ad `%h` %s' 2>/dev/null | head -30
else
  git log --since="$SINCE" --no-merges --date=short --pretty='- %ad `%h` %s' | head -30
fi
echo

echo "## Files you touched most (window: $SINCE)"
echo
if [ -n "$AUTHOR" ]; then
  git log --since="$SINCE" --author="$AUTHOR" --no-merges --name-only --pretty=format: 2>/dev/null \
    | sed '/^$/d' | sort | uniq -c | sort -rn | head -20 \
    | awk '{c=$1; $1=""; sub(/^[ \t]+/,""); printf "- `%s` — %s of your commits\n", $0, c}'
fi
echo

echo "## Branches with recent activity"
echo
git for-each-ref --sort=-committerdate refs/heads refs/remotes/origin \
  --format='- `%(refname:short)` — %(committerdate:short) — %(subject)' 2>/dev/null \
  | grep -v 'origin/HEAD' | head -15
echo

echo "## Pull requests"
echo
GH_OK=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  # `gh` being installed and authenticated is GLOBAL state; it says nothing about
  # whether THIS repo is on GitHub. Probe the repo itself before trusting it.
  gh repo view --json name >/dev/null 2>&1 && GH_OK=1
fi
if [ "$GH_OK" = 1 ]; then
  echo "### Open"
  echo
  gh pr list --state open --limit 15 \
    --json number,title,author,updatedAt,headRefName \
    --jq '.[] | "- #\(.number) **\(.title)** — @\(.author.login) · \(.updatedAt[0:10]) · `\(.headRefName)`"' 2>/dev/null \
    || echo "_none, or gh could not read this repo_"
  echo
  echo "### Recently merged (newest first)"
  echo
  gh pr list --state merged --limit "$PRS" \
    --json number,title,author,mergedAt,headRefName \
    --jq '.[] | "- #\(.number) **\(.title)** — @\(.author.login) · merged \(.mergedAt[0:10])"' 2>/dev/null \
    || echo "_none_"
  echo
  echo "### What the 5 newest merged PRs changed"
  echo
  for n in $(gh pr list --state merged --limit 5 --json number --jq '.[].number' 2>/dev/null); do
    TITLE="$(gh pr view "$n" --json title --jq .title 2>/dev/null)"
    echo "**#$n — $TITLE**"
    echo
    gh pr view "$n" --json files --jq '.files[] | "  - \(.path) (+\(.additions)/-\(.deletions))"' 2>/dev/null | head -12
    echo
    # The WHY lives in the body, not the title. The BEGIN.md "Decisions" table
    # asks for reasoning, so recon has to actually supply it.
    BODY="$(gh pr view "$n" --json body --jq '.body // ""' 2>/dev/null | sed '/^[[:space:]]*$/d' | head -12)"
    if [ -n "$BODY" ]; then
      echo "  > why (from the PR body):"
      printf '%s\n' "$BODY" | sed 's/^/  > /'
      echo
    fi
  done
else
  echo "_No GitHub PR data (gh missing, unauthenticated, or this repo is not on GitHub) — falling back to merge commits._"
  echo
  git log --since="$SINCE" --merges --date=short --pretty='- %ad `%h` %s' | head -20
  echo
fi

# A clone can sit months behind while `gh` happily reports PRs merged yesterday.
# Following "read what the newest PRs changed" then sends you to code that is
# not in your working tree at all.
if [ "$GH_OK" = 1 ]; then
  HEAD_TS="$(git log -1 --format=%ct 2>/dev/null || echo 0)"
  NEWEST_PR_DATE="$(gh pr list --state merged --limit 1 --json mergedAt --jq '.[0].mergedAt // ""' 2>/dev/null)"
  if [ -n "$NEWEST_PR_DATE" ] && [ "$HEAD_TS" != 0 ]; then
    PR_TS="$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$NEWEST_PR_DATE" +%s 2>/dev/null || date -d "$NEWEST_PR_DATE" +%s 2>/dev/null || echo 0)"
    if [ "$PR_TS" != 0 ]; then
      DAYS=$(( (PR_TS - HEAD_TS) / 86400 ))
      if [ "$DAYS" -gt 7 ]; then
        echo "> [!WARNING]"
        echo "> The newest merged PR is **$DAYS days newer than your HEAD**. These PRs are NOT in your"
        echo "> working tree — do not read them as \"what the code now does\". Run \`git pull\` first."
        echo
      fi
    fi
  fi
fi

echo "## Docs on disk"
echo
find . -maxdepth 3 \( -name node_modules -o -name .git -o -name dist -o -name .next \) -prune -o \
  -name '*.md' -print 2>/dev/null | grep -v '^./.begin/' | head -30 | while read -r f; do
  H="$(grep -m1 '^#' "$f" 2>/dev/null | sed 's/^#\+ *//' | cut -c1-90)"
  echo "- \`${f#./}\` — ${H:-_no heading_}"
done
echo

if [ -f package.json ]; then
  echo "## How this project is run (package.json scripts)"
  echo
  if command -v jq >/dev/null 2>&1; then
    jq -r '.scripts // {} | to_entries[] | "- `\(.key)` → `\(.value)`"' package.json 2>/dev/null | head -20
  else
    grep -A20 '"scripts"' package.json | head -20
  fi
  echo
fi
} | redact > "$OUT.$$" || {
  echo "begin: recon failed — .begin/recon.md NOT written" >&2
  rm -f "$OUT.$$"; exit 2
}
[ -s "$OUT.$$" ] || {
  echo "begin: recon produced no output — .begin/recon.md NOT written" >&2
  rm -f "$OUT.$$"; exit 2
}
mv "$OUT.$$" "$OUT"

cat "$OUT"
echo "begin: wrote .begin/recon.md" >&2
