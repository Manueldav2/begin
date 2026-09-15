---
name: begin
description: Use at the START of work in an unfamiliar or half-remembered codebase, or when the user says "understand this codebase", "get up to speed", "where do I start", "what is this repo", "/begin", or asks what they were last working on. Derives the important and complex parts from the import graph, git churn and recent PRs, links every hot file to the user-facing surface it serves, and writes BEGIN.md — a living knowledge graph of the code that stays honest on every push.
---

# begin

Orient in a codebase in one pass, from evidence, without wandering.

The failure this exists to prevent: an agent opens a repo, greps a plausible-sounding
word, reads three files that happen to match, and reports a confident architecture
summary that describes 4% of the system. `begin` replaces guessing about where the
important code is with **measuring** where it is, then reads only what the
measurement pointed at.

## The contract

1. **Nothing is recalled. Everything is derived.** Importance comes from a PageRank
   over the real import graph; complexity from counted decision points; focus from
   git and the PR log. If you cannot point at a file:line or a commit, you do not
   say it.
2. **Every claim is anchored.** Each statement in BEGIN.md cites `path:line`, a
   commit, or a PR number. An unanchored sentence is a guess, and guesses are what
   this skill exists to kill.
3. **Two layers, one of them living.** `.begin/` is machine output, regenerated and
   self-ignoring. `BEGIN.md` is prose you wrote, committed, and stamped with the
   commit it was derived from. A post-commit hook re-derives the machine layer and
   reports which prose sections the code has outrun. **Nothing in this skill ever
   edits a tracked file** — `.begin/` carries its own `.gitignore`, so the repo's is
   untouched.
4. **Proxies are named as proxies.** `complexityProxy` is a decision-point count, not
   a parse. Nesting is measured from indentation. Say so; do not launder a proxy into
   a fact.
5. **A degraded measurement is announced, never quietly used.** The scan prints a
   `[!WARNING]` block when churn is dead, when files were dropped, or when import
   resolution failed for a language. **Read that block before the table.** A ranking
   built on a broken graph looks exactly like a good one.

## Run it

```bash
S=~/.claude/skills/begin/scripts

bash  $S/recon.sh      # who/what/when: PRs, your commits, live edits, docs
node  $S/scan.mjs      # structure: import graph, hotspots, surface->engine
```

Both write to `.begin/` and print a digest. Run them from anywhere in the repo — the
scan anchors itself to the repo root. `recon.sh` degrades cleanly with no `gh`, no
network and no remote, but it **requires `node`** (redaction is mandatory). ~3,400
source files scan in under two seconds; a 1,800-file polyglot repo in about three.

Flags worth knowing:

- `--since "90 days ago"` — churn window (both scripts default to 90).
- `--top 40` — how many hotspots to print (default 25).
- `--author "..."` — a regex. **You rarely need it**: it defaults to the repo's
  `user.name`, and `recon.sh` falls back to the repo's most active author and says so
  when you have no commits there. That is the normal case in a repo you just cloned.
- `--exclude 'examples/**,site/**'` — keep vendored trees and docs sites out of the
  surface count.
- `--root DIR` — scan a different repo.

## The order of operations — follow it exactly

Doing these out of order is how an agent ends up reading the wrong files.

### 1. Recon before structure

Run `recon.sh` **first**. It answers "what has this person been doing?" — uncommitted
edits, branch-vs-main commits, the last ~20 merged PRs with **their bodies**, and what
each changed. That is the focus prior. Read `.begin/recon.md` fully; it is short.

The uncommitted diff is usually the most informative thing in the repo — it is the
question the user is currently holding. Two caveats recon now flags for you: if the
diff is only lockfiles and build output it says so (do not spend your first read
there), and if the newest merged PR is much newer than HEAD it warns you, because
those PRs are **not in the working tree** and reading them as current is a mistake.

### 2. Structure second

Run `scan.mjs` and read `.begin/scan.md`, **starting with any `[!WARNING]` block**.
You then have, measured rather than assumed:

- **Surfaces** — every place a human or caller actually touches the system, grouped by
  kind (`web-page`, `ui-component`, `http-route`, `cli-command`, `mcp-tool`, `worker`,
  `public-api`, `migration`, plus `example`, `config` and `test` which are surfaces but
  not product). This is the UI end of the map.
- **Hotspots** — ranked, with a `why` column naming the term that put each file there:
  `depended-on`, `churn`, `complex` or `recent`. A file at the top for `churn` is a
  different animal from one at the top for `depended-on`; the column tells you which
  conversation to have.
- **Surface → engine paths** — the literal import chain from an endpoint or a button
  down to the hard part, computed by BFS.
- **Import cycle groups** — strongly-connected sets over *static value* edges, with one
  real directed loop walked out. Type-only and lazy (`await import(...)`) edges are
  excluded, because neither forms a real initialisation cycle.
- **Unreachable files** — dead code, or a surface the heuristics missed. Decide which,
  and say which.

### 2.5. Read the map the repo already wrote for you

Before opening any hotspot, check for `AGENTS.md`, `CLAUDE.md`, `ARCHITECTURE.md` or
per-directory `README`s — `recon.md` lists them. A repo that ships a subsystem map
hands you in thirty lines what the scan infers in two seconds and prose takes an hour
to reconstruct. Read those first, then use the scan to *check* them: docs go stale,
the graph does not.

### 3. Read only what the measurement pointed at

Read, in this order, and stop:

1. The uncommitted diff and the current branch's commits (what they are doing now).
2. The files changed by the 3–5 newest merged PRs (what they just decided).
3. The top 8–15 hotspots from `scan.md`.
4. For each of the top 3, walk its `reachedVia` surface inward, so you can state the
   full path from user action to engine.
5. `README`, the agent-facing docs from 2.5, and any doc whose heading matches a hotspot.

Do **not** open files outside this set on a first pass. If something seems missing,
that is a finding to report, not a licence to browse.

### 4. Verify before you write

The table is a set of leads, not a conclusion. Before each claim goes in BEGIN.md:

- Open the file and confirm the line you are about to cite says what you think.
- For a surface → engine path, confirm the import actually exists in the source.
- For anything about behaviour, prefer a test that demonstrates it over a function
  that looks like it.
- `grep` the hot paths for swallowed failures — `catch {}`, `.catch(() => {})`,
  `as any`, `as never`, discarded returns. Bugs live where errors are thrown away,
  and these are the highest-value thing you can hand back on day one.
- **Spend at least one pass trying to falsify your main claim**, not confirm it. The
  most valuable sentences in a good BEGIN.md are the ones that contradict the scan.

If the scan is wrong about something, say so *in* BEGIN.md and correct it. A file the
graph calls dead that is actually reached over HTTP or a queue is the single most
useful thing you can record, because nobody else will find it again either. Declare
such entry points in `.begin/surfaces.txt` (one path per line, optionally
`path<TAB>kind`) and the next run will treat them as surfaces.

### 5. Write BEGIN.md

Use `references/BEGIN-template.md`, and read `references/EXAMPLE-BEGIN.md` first to
calibrate — it is a real one, not a mock-up. Structure, in order:

1. **What this system does in one paragraph** — in the user's terms, not the code's.
2. **The fundamental mechanism** — first principles. What is the core transformation?
   What is the one idea that makes the rest obvious? What breaks without it?
3. **Surfaces → engine** — a table from `scan.md`'s paths, each row verified. If no row
   crosses a process or network boundary, say so explicitly: in a split-language repo
   the real seam is usually an HTTP or queue call that **no import graph can see**.
4. **The complex parts, ranked** — finding first, measurement last. Each entry needs a
   trap that cites a `file:line` **not** already in its measurement line. An entry you
   cannot give that to is one you did not actually read: delete it.
5. **Decisions and why** — each linked to its PR or commit, with the reasoning from the
   PR body. This is what makes the doc a knowledge graph rather than a code tour.
6. **Where you left off** — or, in a repo you do not own, **who owns this and where it
   is growing**: the active authors, what the newest open PRs are adding, which to read
   first.
7. **What the machine layer could not see here** — and **open questions**, including the
   single assumption doing the most load-bearing work. Never omit this.

Also record **how to run and verify it** (the scripts `recon.md` extracted from
`package.json`) and a **glossary** for any word this repo overloads. Both are what a
newcomer needs first and what every code tour forgets.

Cross-link with `[[wiki-style]]` anchors. **Stamp every section:**

```markdown
<!-- begin:section id="ingestion" sha="0055f01" files="src/adapter.ts,src/identity.ts" -->
```

`sha` = `git rev-parse --short HEAD` at the moment you derived the section (not the
commit that later adds BEGIN.md). `files` = the files the section's claims rest on;
globs like `src/engine/**` work. A section with **no** `files=`, or a `files=` naming a
path that does not exist, can never go stale and is reported as unverifiable — which is
the failure this skill exists to prevent, so get the paths right.

### 6. Make it living

```bash
bash $S/install-hook.sh          # post-commit; --pre-push for the other trigger
```

The hook re-runs the scan and prints a one-line notice naming how many sections went
stale, with detail in `.begin/stale.md`. It honours `core.hooksPath` (husky) and git
worktrees, appends to an existing hook without corrupting it, refuses to append to a
non-shell hook, and never touches a tracked file. Remove it with `--uninstall`, which
strips only its own block.

## `/begin update`

When the user returns to a repo that already has a `BEGIN.md`:

```bash
node $S/refresh.mjs && cat .begin/stale.md
```

Rewrite **only** the stale sections, re-run `recon.sh` to refresh section 6, and
re-stamp each rewritten section with the new HEAD sha. Leave current sections
byte-identical — an update that rewrites everything destroys both the reader's sense of
what changed and the git history's usefulness.

If there is no `BEGIN.md` yet, `/begin update` is just `/begin`: write one.

## Reporting back

One short paragraph: the fundamental mechanism, the one or two files that matter most
and why, where the user left off, and the single thing you could not verify. Detail
lives in BEGIN.md, not in the reply.

Close with what you did **not** check. A `begin` pass that claims full coverage is
lying.

## Known limits — state these, do not paper over them

- The import graph is **static**. A literal `import('./x')` *is* resolved (and marked
  lazy); a computed `import(expr)`, a DI container, or a registry keyed by string
  produces no edge at all, so such a file can look unreachable while being
  load-bearing. In a split-language repo the frontend↔backend seam is an HTTP or
  WebSocket call and is invisible by construction. The scan flags unreachable files
  precisely so a human can judge.
- Full JS/TS and Python resolution — tsconfig `paths` (every config in the tree, not
  just the root), `extends`, NodeNext `./x.js` → `x.ts`, and Python absolute, relative
  and submodule imports against inferred roots. Go, Rust, Ruby, Java, Swift and PHP get
  size, churn and complexity but **no edges**, so importance is understated for them.
  Say so when scanning such a repo.
- `complexityProxy` counts decision points per language, in code with comments and
  single-line strings removed. Markup and schema files score 0 by design; vendored,
  minified and generated files are detected and ranked separately. Multi-line template
  literals are still counted, so a template-heavy file reads a little hot.
- Churn is bounded by `--since`, and a shallow or fresh clone has none — the scan says
  so loudly. A file rewritten once two years ago still scores near zero and can still
  be the most important file in the repo.

## Tests

```bash
node $S/test-scan.mjs                   # graph, cycles, surfaces, reachability, Python
node $S/test-scan.mjs --mutate pyDotDot # ...and prove the assertions can go red
bash  $S/test-living.sh                 # staleness, hooks, tree cleanliness
node  $S/redact.mjs --self-test         # secrets caught AND clean text unharmed
```

Every assertion exists because that bug was real and shipped once. Mutations:
`alias`, `jsToTs`, `valueCycle`, `typeCycle`, `pyAbsolute`, `pyDotDot` — each must turn
its assertion red, and CI fails if one does not.
