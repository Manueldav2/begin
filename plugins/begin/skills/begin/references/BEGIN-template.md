# BEGIN — <repo name>

> The living map of this codebase. Machine layer in `.begin/` (regenerated, gitignored);
> this file is the prose layer (committed, stamped). Refresh with `/begin update`.
>
> _Derived at `<short sha>` on `<date>`. Every claim below cites a file:line, a commit,
> or a PR. Anything uncited is a question, not a fact._

---

## 1. What this does

<!-- begin:section id="overview" sha="<sha>" files="README.md,<main entry>" -->

One paragraph, in the language of the person who uses the system — not the language of
the code. What goes in, what comes out, who asks for it.

---

## 2. The fundamental mechanism

<!-- begin:section id="mechanism" sha="<sha>" files="<the 2-4 files the core idea lives in>" -->

First principles. The core transformation this system performs, stated so that the rest
of the codebase becomes predictable once you have it.

- **The one idea:** …
- **Why it is shaped this way:** … (cite the PR or commit where that was decided)
- **What breaks without it:** …

See also [[complex-parts]].

---

## 3. Surfaces → engine

<!-- begin:section id="surfaces" sha="<sha>" files="<entry files>" -->

Every user-visible thing, and the path from it to the code that does the work.
Rows come from `.begin/scan.md`'s surface→engine paths; each one verified by opening
the import.

| What the user does | Entry point | Path inward | Where the work happens |
|---|---|---|---|
| … | `path:line` | `a.ts` → `b.ts` | `path:line` |

Surfaces with **no** path to a hotspot, and hotspots reachable from **no** surface, are
listed here too — each labelled either _dead_ or _runtime-wired_ (the static graph
cannot tell them apart; a human decided).

---

## 4. The complex parts, ranked

<!-- begin:section id="complex-parts" sha="<sha>" files="<top hotspots>" -->

Finding first, measurement last. Writing the metric first makes every entry look
complete before it says anything, because the metric always exists.

### 1. `path/to/file.ts` — <one-line role>

- **The trap:** what someone new gets wrong, citing a `file:line` that does **not**
  appear in the Measured line below. If you cannot write this line, you did not read
  the file — delete the entry rather than softening it. This is the most valuable
  sentence in the document.
- **Why it is actually complex:** the real reason, in prose.
- **Reached from:** `<surface>` in `n` hops · **depended on by:** …
- **Measured:** importance `x` (ranked on `<why>`), fan-in `n`, `n` commits, complexity
  proxy `n`, max nesting `n`.

_(repeat for the top 5–8. Fewer real entries beats more padded ones.)_

### Files the tool ranked high that do not belong here

Name them and say why — a 4-line re-export with huge fan-in, a vendored bundle, a churn
spike from a rename. Correcting the ranking is a finding, not a failure.

---

## 5. Decisions and why

<!-- begin:section id="decisions" sha="<sha>" files="<files the decisions touch>" -->

What was chosen, why, and where it lives. This is the join between the code and the
thinking — pulled from PR bodies and commit messages in `.begin/recon.md`.

| Decision | Why | Where it lives | Evidence |
|---|---|---|---|
| … | … | `path:line` | PR #N / `sha` |

Reversed or superseded decisions belong here too, marked as such. A map that only shows
the current state cannot explain why the code resists a change.

---

## 6. Where you left off

<!-- begin:section id="wip" sha="<sha>" files="<branch files>" -->

**If this is your repo:**

- **Branch:** `<branch>` — `n` commits ahead of `<default>`
- **Uncommitted:** … (or "tooling noise only", if recon said so)
- **Open PRs:** #N — …
- **The obvious next step:** …

**If it is not your repo** — the usual case on a first run — write this instead, which
is more useful anyway:

- **Who owns this:** the active authors, per area.
- **Where it is growing:** what the newest open PRs add. Four of five open PRs doing
  the same kind of thing is a real finding about the project's direction.
- **Which PRs to read first**, and why.
- **Whether your checkout is current:** recon warns when merged PRs are newer than HEAD.

This section is expected to go stale fastest. That is correct; `/begin update`
rewrites it first.

---

## 6b. How to run and verify it

<!-- begin:section id="howto" sha="<sha>" files="package.json,Makefile" -->

The commands, from `recon.md`'s script list — install, run, test, lint, and the one
command that proves the thing works. This is the first thing a newcomer needs and the
first thing every code tour forgets.

---

## 6c. Glossary

<!-- begin:section id="glossary" sha="<sha>" files="-" -->

Only words this repo **overloads**. If "commit" means an app-level edit here as well as
a git commit, or "space" means three different things, say so. A newcomer loses an hour
to each of these and no amount of reading the code fixes it.

---

## 7. What the machine layer could not see, and what I did not check

<!-- begin:section id="unverified" sha="<sha>" files="-" -->

- **What the scan could not see on THIS repo:** the warnings it printed, plus every
  seam that is not an import — HTTP and WebSocket calls, queues, DI, string-keyed
  registries, dynamic dispatch. Name them concretely; "static analysis has limits" is
  not a finding.
- **Where the scan was wrong and I corrected it:** files it called dead that are live,
  files it ranked high that do not matter.
- **Not checked:** …
- **The load-bearing assumption:** the single assumption that, if wrong, invalidates
  the most of the above.
- **Invisible to the scan:** runtime-wired code, dynamic imports, string-keyed
  registries — name them if this repo uses them.

Never delete this section. A map with no stated edges is being read as more complete
than it is.
