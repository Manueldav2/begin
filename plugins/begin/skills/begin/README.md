# begin

**Land in any codebase and know where to look.**

A Claude Code skill. You point it at a repo; it measures which files actually matter,
links each one to the user-facing surface it serves, reads your recent PRs so it knows
what *you* have been working on, and writes `BEGIN.md` — a map of the code joined to
the decisions behind it, which stays honest on every push.

It exists to kill one specific failure: an agent greps a plausible-sounding word, reads
three files that happen to match, and confidently describes 4% of the system.

```
/begin          orient in this repo, and write BEGIN.md
/begin update   refresh only the sections the code has outrun
```

## Install

**As a plugin** (recommended — updates with `/plugin`):

```
/plugin marketplace add Manueldav2/begin
/plugin install begin@begin
```

**One line:**

```bash
curl -fsSL https://raw.githubusercontent.com/Manueldav2/begin/main/install.sh | bash
```

**From a clone:**

```bash
git clone https://github.com/Manueldav2/begin && cd begin && ./install.sh
```

Add `--project` to install into `./.claude/skills` for one repo instead of user-wide.
The installer runs the skill's own test suites and refuses to report success if any
fail. Needs `node` 18+ and `git`; uses `gh` and `jq` when present and degrades around
them when absent.

## What it actually measures

Nothing here is recalled or guessed. Every number is derived from the repo in front of
it, and every limit is printed rather than implied.

| Signal | How | Honest limit |
|---|---|---|
| Importance | PageRank over the **value**-import graph, damped by file substance | static only — runtime wiring is invisible |
| Complexity | decision points per language + indentation depth | a proxy, and labelled as one |
| Focus | git churn, your commits, merged PRs **with their bodies** | bounded by `--since`; announced when dead |
| Surfaces | route / page / component / CLI / MCP / worker / public-API detection | heuristic; declare the rest in `.begin/surfaces.txt` |
| Surface → engine | BFS along real import edges | an HTTP or queue seam has no edge to follow |
| Cycles | Tarjan SCC over **static value** imports, with one real loop walked | type-only and `await import()` edges excluded |

Full JS/TS and Python resolution: tsconfig `paths` (every config in the tree, plus
`extends` and project `references`), NodeNext `./x.js` → `x.ts`, and Python absolute,
relative and submodule imports against inferred roots. Other languages get size, churn
and complexity but no edges — and the scan says so. ~3,400 files in under two seconds.

**It tells you when it is blind.** A shallow clone, a dropped file cap, or a language
whose imports failed to resolve each produce a `[!WARNING]` block above the table. That
block is the most important thing in the output: a ranking built on a broken graph looks
exactly like a good one.

## The two layers

- **`.begin/`** — machine output (`scan.json`, `scan.md`, `recon.md`, `stale.md`).
  Regenerated every run, and **self-ignoring**: it writes its own `.begin/.gitignore`,
  so your repo's `.gitignore` is never touched.
- **`BEGIN.md`** — prose the agent wrote, committed, each section stamped with the commit
  and files it was derived from.

A `post-commit` hook re-derives the machine layer and prints a one-line notice naming
how many sections the code has outrun. **Nothing in this skill ever edits a tracked
file.** The hook honours `core.hooksPath` (husky) and git worktrees, appends to an
existing hook without corrupting it, refuses to append to a non-shell hook, and
`--uninstall` strips only its own block.

```bash
~/.claude/skills/begin/scripts/install-hook.sh     # --pre-push, or --uninstall
```

## Tests

```bash
S=~/.claude/skills/begin/scripts
node $S/test-scan.mjs                    # graph, cycles, surfaces, reachability, Python
node $S/test-scan.mjs --mutate pyDotDot  # ...and prove the assertions can go red
bash $S/test-living.sh                   # staleness, hooks, tree cleanliness
node $S/redact.mjs --self-test           # secrets caught AND clean text unharmed
```

CI runs all of these on Linux and macOS and **fails if a mutation does not turn its
assertion red** — a test that cannot fail is worth less than no test.

Every assertion exists because that bug was real and shipped once. Among them:

- Python absolute imports resolved against nothing, giving **5.4% edge capture** on a
  real 878-file repo — the most depended-on module in the codebase reported fan-in 0
- `from ..models import x` string-replaced its dots into a **sibling** path, inventing
  edges to same-named files rather than merely missing them
- PageRank and the surface BFS ran on the all-imports graph while only cycles used
  value imports, so 1-line type barrels outranked engines and type-only chains were
  presented as runtime paths
- a tsconfig comment-stripper ate `"@/*": ["./*"]` — the `/*` inside the glob read as a
  block comment — and only the root config was read at all
- a runaway backtick regex erased 86% of a 284KB `.tsx`, reporting complexity 68 where
  the true count was 1042; a minified bundle then ranked #1 while the one genuinely
  complex file in the fixture ranked last
- a strongly-connected component was printed as `a ↔ b ↔ c`, asserting pairs that
  existed nowhere in the source
- a stamped section whose `files=` had a typo reported itself **healthy forever**
- the unclaimed-file check silently self-destructed the first time you followed the
  skill's own update advice
- the hook discarded its own output, so the living-doc loop was invisible in practice
- `git remote get-url` printed a live token into a file meant to be committed;
  redaction now runs in node, because BSD `sed` has no `\b` and silently matched
  nothing on macOS

## License

MIT
