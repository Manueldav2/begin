<!--
  A REAL worked example, not a mock-up: this is the BEGIN.md that `begin` produced for
  configure-spectrum-ts (9 source files, 8 import edges), written by following SKILL.md
  literally. Read it to calibrate what "good" looks like before writing your own.

  Note especially what it does NOT do: it does not summarise every file, it does not
  praise the codebase, and section 7 names the one assumption that would invalidate the
  rest. The "trap" lines under each complex part are the highest-value sentences in the
  document — they are what a reader cannot get from the code alone.
-->

# BEGIN — configure-spectrum-ts

> The living map of this codebase. Machine layer in `.begin/` (regenerated, gitignored);
> this file is the prose layer (committed, stamped). Refresh with `/begin update`.
>
> _Derived at `0055f01` on 2026-09-15. Every claim below cites a file:line, a commit, or
> a PR. Anything uncited is a question, not a fact._
>
> Measured: 9 source files, 8 import edges, 0 import cycles, 1 public surface.
> This is a small, dense library — one file holds 68% of the code.

---

## 1. What this does

<!-- begin:section id="overview" sha="0055f01" files="README.md,src/index.ts,package.json" -->

Wraps a Photon Spectrum message agent so that a person texting it is recognised as a
Configure user, and the agent gets their profile context. The developer changes one
thing — they wrap their agent in `withConfigure(...)` — and every inbound message
arrives already carrying an identity, a token, and whatever Configure knows about that
person. If the person is not linked yet, the adapter mints a sign-in link and sends it
back through the same message channel they wrote in on.

It ships as an ESM-only library (`package.json`) whose entire public value surface is a
single export, `withConfigure` (`src/index.ts:1`); everything else exported is a type.

---

## 2. The fundamental mechanism

<!-- begin:section id="mechanism" sha="0055f01" files="src/identity.ts,src/adapter.ts,src/store.ts" -->

**The one idea: a stable `subjectKey` derived from the message itself, with the phone
number preferred over everything else.**

`deriveIdentity` (`src/identity.ts:14`) hashes one piece of material into
`sp_<hash>` (`src/identity.ts:23`). That material is the sender's phone number if any
candidate can be found, and only otherwise a `platform:senderId` fallback
(`src/identity.ts:18-22`). Phone candidates are gathered in priority order from the
sender's `phone`, `address`, and — on phone-backed platforms — the sender `id` itself
(`src/identity.ts:32-40`).

Once you have that, the rest of the library is predictable. The `subjectKey` is the
primary key into the store (`src/store.ts:8`), so the same human texting from the same
number is the same subject across restarts and across spaces. `threadKey` is
deliberately separate — `platform:spaceId` (`src/identity.ts:24`) — so conversation
scope and person scope never get confused.

**What breaks without it:** identity would have to come from the platform's own account
system, which differs per platform and does not exist for SMS at all. Hashing a
canonicalised phone number is what lets one Configure user be recognised across iMessage,
SMS and anything else Spectrum speaks. Remove it and the adapter cannot answer its only
real question: *who is this?*

The second idea, layered on top: **trust is cached, not re-proven.** `resolve`
(`src/adapter.ts:169`) reads a stored token and validates it under a policy that
defaults to `"on-first-use"` (`src/adapter.ts:173`), with `validatedTokens` and
`registeredMessageLines` held as module-level `Set`s in the closure
(`src/adapter.ts:107-108`). Those sets are **per-process, not per-store** — see
[[unverified]].

See also [[complex-parts]].

---

## 3. Surfaces → engine

<!-- begin:section id="surfaces" sha="0055f01" files="src/index.ts,src/adapter.ts,src/identity.ts,src/store.ts" -->

There is exactly one surface: the package's public API. There is no UI, no HTTP route,
and no CLI in this repo — the "user" is a developer calling a function, and the path
inward is four files deep.

| What the user does | Entry point | Path inward | Where the work happens |
|---|---|---|---|
| `withConfigure({...})` to wrap an agent | `src/index.ts:1` | → `adapter.ts` | `src/adapter.ts:95` (option validation, factory) |
| A message arrives; agent asks who sent it | `src/index.ts:1` | → `adapter.ts` → `identity.ts` | `src/identity.ts:14` (`deriveIdentity`) |
| Agent persists/reads that person | `src/index.ts:1` | → `adapter.ts` → `store.ts` | `src/store.ts:8` (`localStore`) |
| Unlinked person gets a sign-in link back | `src/index.ts:1` | → `adapter.ts` | `src/adapter.ts:689` (`createMessageUrl`) |

**Reported unreachable, and what each one actually is** — the static graph cannot tell
dead code from a deliberate entry point, so a human decided:

- `examples/stream-imessage/agent.ts`, `examples/express-webhook/server.ts` — **not
  dead.** Standalone runnable examples; they import the package by name, not by relative
  path, so no edge exists. They are a real (documentation) surface the scanner has no
  rule for.
- `vitest.config.ts` — **not dead.** Config, executed by the test runner, never imported.

---

## 4. The complex parts, ranked

<!-- begin:section id="complex-parts" sha="0055f01" files="src/adapter.ts,src/types.ts,src/identity.ts,src/store.ts" -->

### 1. `src/adapter.ts` — the whole state machine

- **Measured:** 1028 LOC (68% of all source), complexity proxy 218, max nesting 7,
  19 commits in the window, 1 hop from the surface. Top-ranked on every axis but one.
- **Why it is actually complex:** it is not one job, it is five, all sharing closure
  state — identity resolution (`:169`), message handling (`:302`), completion (`:346`),
  sign-in URL minting (`:689`), and message-line registration (`:716`). Four mutable
  caches live in the factory closure (`:106-109`), two of them `WeakMap`s keyed by
  context object.
- **Depended on by:** `src/index.ts` only — but it is where every behaviour lives.
- **The trap:** `validatedTokens` and `registeredMessageLines` (`:107-108`) are plain
  in-memory `Set`s in the closure. They are **not** in the store. Two processes, or a
  restart, and every token gets re-validated and every line re-registered. That is
  probably intended as a cache, but nothing in the types says so.

### 2. `src/types.ts` — the contract everything else obeys

- **Measured:** importance 0.313 (by far the highest PageRank in the repo), fan-in 4,
  224 LOC, complexity proxy 1.
- **Why it matters despite being trivial code:** it is pure interface. Every other file
  imports it, which is exactly why PageRank floats it to the top. Read this file first
  if you want the shape of the system in one pass.
- **The trap:** complexity 1 makes it look unimportant on the hotspot table. Importance
  and complexity disagree here, and importance is right.

### 3. `src/identity.ts` — the hashing rules

- **Measured:** 146 LOC, complexity proxy 29 (highest per-line density in the repo),
  2 hops from surface.
- **Why it is complex:** phone canonicalisation and candidate selection is a pile of
  special cases (`:32-40`), and getting it wrong silently splits one human into two
  subjects, or worse, merges two humans into one.
- **The trap:** `subjectKey` is a hash of the *canonicalised* phone. Change the
  canonicalisation and every existing stored subject becomes unreachable. This is a
  migration hazard with no migration path in the repo.

### 4. `src/store.ts` — the persistence seam

- **Measured:** 69 LOC, complexity proxy 13, 2 hops from surface.
- **Why it matters:** `localStore()` (`:8`) is three in-memory `Map`s. It is the default
  and it is **not** durable. Anyone shipping this to production must supply their own
  `ConfigureSpectrumStore`.
- **The trap, verified:** in `saveSubject`, the object literal sets `externalId`,
  `createdAt` and `updatedAt` (`:22-27`) and then spreads `...existing` *after* them
  (`:28`), which overwrites all three. It is not a bug — `applyPatch` (`:58`) re-sets
  `externalId` and line `:31` re-sets `updatedAt` — but the initializers are dead, and
  a reader will burn twenty minutes deciding whether they found a bug. (I did.)

---

## 5. Decisions and why

<!-- begin:section id="decisions" sha="0055f01" files="src/adapter.ts,docs/message-auth-handoff.md" -->

| Decision | Why | Where it lives | Evidence |
|---|---|---|---|
| Never log a raw error object | Error bodies from the auth path can carry tokens and phone numbers; only the error *kind* is logged | `src/adapter.ts:90` (`safeErrorFields`), used at `:135`, `:280`, `:441` | `6c29397` |
| Register the return line **before** minting a URL | A URL minted for an unregistered line is undeliverable | `src/adapter.ts:708` | `1e30d5d` |
| Fail **closed** when line registration fails | Strips `messageLinePhone` and `messageBody` from the payload rather than sending a link that cannot come back | `src/adapter.ts:712-713` | `1e30d5d` |
| Route managed completion through message URLs | One return path instead of two | `src/adapter.ts:346` | `d465765` |
| Let the host override URL minting | `options.signIn.mintUrl` short-circuits the whole minting path | `src/adapter.ts:699-701` | `2aee7fe` |
| Validate a stored token on first use, not every message | Latency; the policy is configurable | `src/adapter.ts:173` | — |
| Docs must describe only what is live | Photon provisioning was documented before it shipped and got corrected | `docs/photon-provisioning.md` | `85574f1`, PR #7 |

---

## 6. Where you left off

<!-- begin:section id="wip" sha="0055f01" files="docs/coding-agent-quickstart.md,docs/photon-provisioning.md,package.json" -->

- **Branch:** `feat/configure-spaces-spec`, 30 commits ahead of `main`.
- **Last commit:** `0055f01` — "docs(spec): Configure Spaces — cross-account shared
  context design".
- **Uncommitted:** a version bump in `package.json` plus matching one-line edits in
  `docs/coding-agent-quickstart.md` and `docs/photon-provisioning.md`, and a large
  `package-lock.json` shrink (−56 lines). A dependency-tightening pass, not a feature.
- **The shape of recent work:** this branch is almost entirely **docs and spec**, not
  `src/`. The last `src/` change was `6c29397` (error redaction). The design work has run
  ahead of the implementation.
- **The obvious next step:** land the version bump, or reconcile the Spaces spec
  (`0055f01`) against the adapter, which has no Spaces concept in it yet.

---

## 7. Open questions and unverified assumptions

<!-- begin:section id="unverified" sha="0055f01" files="-" -->

- **The load-bearing assumption:** that `validatedTokens` and `registeredMessageLines`
  (`src/adapter.ts:107-108`) are *intended* as per-process caches rather than a
  correctness mechanism. If they are load-bearing for correctness, this library is not
  safe to run in more than one process, and nothing in the types or docs says so. This
  is the single thing most worth confirming with the author.
- **Not checked:** I did not run the test suite. `test/adapter.test.ts` is 939 LOC with
  18 commits, and I read none of it — behaviour here is inferred from source, not from a
  demonstrated pass.
- **Not checked:** whether the Spaces spec in `0055f01` has any implementation anywhere.
- **Clean, and worth stating:** `grep` for swallowed failures across `src/` — `catch {}`,
  `.catch(() => {})`, `as any`, `as never` — returns **nothing**. Errors here are
  redacted, not discarded.
- **Invisible to the scan:** nothing significant. This repo has no DI container, no
  dynamic `import(expr)`, and no string-keyed registry, so the static graph is unusually
  close to the whole truth — which is *not* typical, and is why this repo is a weak test
  of the tool.
