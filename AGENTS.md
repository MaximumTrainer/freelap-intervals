# AGENTS.md

Instructions for any agent — human or otherwise — writing code in this repository.

Read this before your first edit. It describes how the system is put together, and the rules that
keep it that way: **outside-in test-driven development**, resulting in **clean, fluent code**.

`README.md` explains what the product does and how to run it. This file explains how to change it.

---

## 1. The loop

```bash
npm run check       # typecheck + lint + the whole suite. The gate. Must be green before you stop.
npx vitest          # watch mode, for the red-green-refactor cycle
npx vitest run test/acceptance/attach-to-watch-activity.test.ts   # one file
npm run typecheck   # types alone, when you want a faster signal
npm run lint        # the rules in this file, enforced
npm run lint:fix    # the mechanical half of them, applied
```

**The rules below are enforced by ESLint**, not left to memory: [eslint.config.js](eslint.config.js)
encodes them, and every block there cites the section of this file it comes from. If a rule ever
fights good code, change the rule and this document together — never silence it at the call site.

Two severities, deliberately: **errors** are rules the codebase already satisfies, so a new one is a
real regression. **Warnings** are pre-existing debt, listed and finite — line length, four type-only
import cycles in `src/web/`, three un-injected `new Date()` calls, one five-parameter helper, and
the deprecated `formData()` that issue #5 replaces. Do not add to them.

No Docker, no external services. Postgres runs in-process via PGlite; intervals.icu is a fake that
speaks the real wire shapes. If a change makes the suite need a running service, that is a design
problem — solve it, don't add the service.

---

## 2. Architecture

### 2.1 The shape

Ports and adapters, with a pure domain at the centre. Everything the outside world can change —
HTTP, Postgres, CSV dialects, OAuth, the FIT binary format — sits at the edge behind an interface,
and the interesting logic sits inside where it can be tested without any of it.

```
                 ┌─────────────────────────────────────────────┐
   driving  ──▶  │  web/  cli/  jobs/          (adapters in)    │
   adapters      ├─────────────────────────────────────────────┤
                 │  app/                    (use cases)         │
                 │    SyncApplication: import, plan, sync,      │
                 │    preview, verify                           │
                 ├─────────────────────────────────────────────┤
                 │  domain/  match/  write/  verify/            │
                 │    pure logic. No I/O. No clock. No env.     │
                 ├─────────────────────────────────────────────┤
   driven   ◀──  │  icu/  ingest/  ledger/  db/  security/      │
   adapters      │  auth/  audit/  storage/    (adapters out)   │
                 └─────────────────────────────────────────────┘
```

**The dependency rule: dependencies point inward.** `domain/` imports nothing from `web/`, `db/`,
`icu/` or `ingest/`. If you find yourself wanting that import, the logic is in the wrong place.

### 2.2 Where things live

| Directory | Role | Depends on |
| --- | --- | --- |
| `src/domain/` | The canonical model and the rules about it: `SprintSession`, interval naming, description block, durations, units, timezone maths | nothing |
| `src/app/` | Use cases. `SyncApplication` is the only orchestrator: import → plan → sync → verify | domain, ports |
| `src/match/` | Ranks candidate activities and explains each score | domain |
| `src/write/` | Lays reps on a timeline, plans intervals, encodes/decodes FIT | domain, the icu port |
| `src/verify/` | Reads an activity back and reports every difference from intent | domain, the icu port |
| `src/ingest/` | CSV normalisation and the flag-gated MyFreelap web adapter, behind `FreelapSource` | domain |
| `src/icu/` | The intervals.icu HTTP client behind `IntervalsIcuClient`, plus an auditing decorator | the port |
| `src/ledger/` | What was synced where, and the directory a webhook consults | the port |
| `src/security/` | Envelope encryption behind a KMS port; credentials never in the clear | — |
| `src/auth/` | OAuth: authorize, callback, refresh, reconnect; the state store | — |
| `src/jobs/` | The Postgres queue, the worker, the job handlers | app |
| `src/web/` | Server-rendered UI and JSON endpoints | app |
| `src/cli/` | The single-athlete, no-database path | app |
| `src/config.ts` | **The composition root.** The one place configuration becomes objects | everything |

### 2.3 The canonical model

`SprintSession` (`src/domain/sprint-session.ts`) is the spine. Every ingestion adapter produces the
same one for the same session — that equality is asserted by a test, not assumed. Everything
downstream — matching, writing, verifying — speaks `SprintSession` and knows nothing about CSVs or
web scraping.

When you add a source, you convert to `SprintSession` **at the edge**. Do not let a source's
vocabulary leak past `ingest/`.

### 2.4 Ports

A port is an `interface` in the layer that *needs* it, not the layer that implements it. Current
ports, each with at least two implementations (real + test double, or Postgres + in-memory):

`IntervalsIcuClient` · `FreelapSource` · `JobQueue` · `SyncLedger` · `SessionRepository` ·
`ConnectionStore`'s `KeyManagementService` · `AuditLog` · `OAuthStateStore` · `Database`

**Two implementations of a port must be interchangeable.** That is what `test/contract/` is for —
one test body, run against every implementation. If a contract test can't run against both, the
port is lying.

### 2.5 Composition

`buildRuntime()` in `src/config.ts` is the only place that wires concrete classes together. Nothing
else constructs an adapter it depends on.

- **No service locators, no globals, no singletons.** Dependencies arrive through the constructor.
- **No `process.env` in logic.** A class that reads the environment cannot be tested twice with
  different settings. Only two kinds of file may touch it, and lint enforces the list: the
  composition root and process entry points (`src/config.ts`, `src/cli/main.ts`,
  `src/db/migrate-cli.ts`), and the explicit factories that take it as an injectable default
  parameter — `featureFlagsFromEnvironment(env = process.env)` and
  `LocalKeyManagementService.fromEnvironment(env = process.env)`.
- **No `new Date()` in logic.** Take `now: () => Date` and default it at the composition root, the
  way `PgJobQueue` and `SyncApplication` already do. Time is a dependency.

### 2.6 The two processes

`npm run web` and `npm run worker` are separate processes sharing one Postgres. Anything slow or
failure-prone belongs in a job, so an athlete's browser never waits on intervals.icu. Both may run
several replicas; the queue's `for update skip locked` is what makes that safe.

---

## 3. Outside-in TDD

**No production code is written without a failing test that demanded it.** Not "tests alongside",
not "tests after". The test comes first and it fails first.

We work **outside-in**: start at the boundary the user touches, and let each failing test pull the
next piece into existence. This produces interfaces shaped by their callers rather than by their
implementations — which is why the ports above are as small as they are.

### 3.1 The double loop

```
 ┌─ OUTER LOOP ─ one acceptance test, written first, red for a while ────────────┐
 │                                                                              │
 │   1. Write the acceptance test. Watch it fail for the right reason.          │
 │                                                                              │
 │   ┌─ INNER LOOP ─ fast, many times per outer loop ──────────────────────┐    │
 │   │  2. Write the smallest failing unit test for the next piece.        │    │
 │   │  3. Write the least code that makes it pass. Green.                 │    │
 │   │  4. Refactor on green. Both test and production code.               │    │
 │   └─────────────────────────────────────────────────────────────────────┘    │
 │                                                                              │
 │   5. The acceptance test goes green on its own. Do not edit it to fit.       │
 │   6. Refactor the whole slice. `npm run check`.                              │
 └──────────────────────────────────────────────────────────────────────────────┘
```

Rules that make this real, not ceremonial:

- **Watch each test fail, and read the failure.** A test you never saw fail proves nothing. If it
  fails with the wrong error — a typo, a missing import — fix that first; you have not yet seen red.
- **Write the least code that passes.** Not the code you know you'll need. The next test earns it.
- **Refactor only on green**, and only with the suite passing before and after.
- **One reason to change per commit.** Behaviour change or refactor, never both at once.
- **Never edit an acceptance test to make it pass.** If it was right when you wrote it, it is right
  now. Change the code.
- **A bug fix starts with a failing test that reproduces the bug**, at the layer where the bug is
  observable. Then fix it.

### 3.2 Which layer do I start at?

Start at the **outermost layer where the change is observable**, and no further out.

| Change | Start here | Then drive inward with |
| --- | --- | --- |
| A new user-facing journey (a screen, a route, a CLI verb) | `test/e2e/` | acceptance, then unit |
| A new use case on `SyncApplication` | `test/acceptance/` | unit |
| New behaviour in a port implementation | `test/contract/` | unit |
| A rule inside the domain — naming, parsing, timeline, matching | `test/unit/` | — |
| A bug | wherever it is observable | a unit test at the root cause |

### 3.3 The four layers

| Layer | Location | Proves | Speed |
| --- | --- | --- | --- |
| **End-to-end** | `test/e2e/` | The whole app over real HTTP sockets, real Postgres, real queue, against a server speaking intervals.icu's shapes | slow, few |
| **Acceptance** | `test/acceptance/` | A use case through `SyncApplication` against in-memory doubles: create-new, attach, offset nudge, re-sync, drift, ownership refusal | medium |
| **Contract** | `test/contract/` | Wire shapes and auth for the HTTP client; **one test body run against every implementation of a port** | medium |
| **Unit** | `test/unit/` | One behaviour of one thing, no I/O | fast, many |

Most of your tests should be unit tests. Each acceptance test costs suite time forever — earn it.

### 3.4 Test doubles

**Prefer fakes over mocks.** A fake is a working implementation with a shortcut (in-memory instead
of Postgres). A mock asserts on calls, which couples the test to how the code works rather than
what it does.

Three rules keep our doubles honest, and they are not negotiable:

1. **`FakeIntervalsIcu` decodes every uploaded FIT file** rather than trusting it. A double that
   accepts anything proves nothing.
2. **The e2e suites run over real sockets**, not by calling handlers directly.
3. **The Postgres tests apply this project's own migrations** to a real Postgres compiled to
   WebAssembly. The schema under test is the schema that ships.

If you add a double, ask what it could accept that reality would reject, and close that gap.

Never mock a type you own without a contract test pinning the real implementation to the same
behaviour. Never mock a type you don't own at all — wrap it in a port first.

### 3.5 How tests read

Tests are documentation that fails when it goes stale. Write them to be read.

```ts
describe('syncing a Freelap session when there is no watch recording', () => {
  it('creates a new intervals.icu activity from a synthetic FIT and verifies it', async () => {
```

- `describe` names the situation; `it` completes the sentence with the behaviour. Together they read
  as prose. Not `describe('SyncApplication')` / `it('works')`.
- **Builders, named `aThing` / `anotherThing`:** `aSession()`, `aRep()`, `aTestApp()`, `anActivity()`.
  Every builder takes overrides and defaults the rest, so a test states **only what matters to it**.
  Put shared ones in `test/support/`.
- **Assert on whole values** — `toEqual`, `toMatchObject` — not on a scatter of individual fields.
- **No logic in tests.** No loops, no conditionals, no computing the expected value with the same
  arithmetic the production code uses. Write the literal you expect:
  `expect(session.summary).toEqual({ count: 6, bestS: 3.35, worstS: 3.61, avgS: 3.452 })`.
- **Arrange, act, assert**, separated by blank lines. One behaviour per `it`.
- **Fix the clock and the timezone.** `now: () => new Date('2026-08-29T12:00:00Z')`,
  `timezone: 'Europe/London'`. A test that passes only in August is a test that fails in September.
- **No sleeps.** Inject the clock and advance it.

### 3.6 Working from an issue

Issues #1–#38 carry numbered **Requirements** (R1…Rn) and **Acceptance criteria** written as
Given/When/Then. Use them:

- Each acceptance criterion is an acceptance or e2e test. Write it first, verbatim where you can.
- Each requirement is at least one unit test.
- Close the issue only when every checkbox is genuinely ticked, including `npm run check`.
- If a requirement turns out to be wrong, say so in the issue and get it changed. Do not silently
  implement something else.

---

## 4. Clean, fluent code

Fluent means it reads as prose, in the vocabulary of the problem — sprints, reps, splits,
activities, intervals — not in the vocabulary of the machine.

### 4.1 Naming

- Name after **intent**, never mechanism: `intervalNameFor`, `searchWindowFor`, `refuseIfOwnedByAnotherSession`,
  `theOnlySession`, `thinnedForDrawing`. Not `process`, `handle`, `doWork`, `data`, `temp`, `util`.
- Functions returning a boolean read as a predicate: `isFreelapInterval`, `claimsExternalId`.
- Domain terms come from the design document and never get abbreviated in code. `session`, not `sess`.
- Units belong in the name: `totalS`, `distanceM`, `avgSpeedMps`, `runAfterMs`, `startEpochMs`. A
  bare `duration` or `speed` is a bug waiting for its second reader.
- No Hungarian notation, no `I` prefix on interfaces, no `Impl` suffix. The Postgres implementation
  of `JobQueue` is `PgJobQueue`; the fake is `FakeIntervalsIcu`; the in-memory one is
  `InMemorySyncLedger`. The name says what it *is*.

### 4.2 Functions

- **One level of abstraction per function.** `ActivityWriter.write()` reads as four named steps;
  each step's detail lives one call down.
- Small enough to hold in your head. If you need a comment to separate two halves, they are two
  functions.
- **Guard clauses and early returns.** No `else` after a `return`. No nesting past two levels.
- **Exported APIs take an options object**, with a `readonly` interface — never a run of positional
  booleans. `write(request: WriteRequest)`, not `write(session, choice, athleteId, tz, offset)`.
  Private helpers may stay positional, but past four parameters they are saying they want an object
  (lint warns; `csv-adapter`'s five-parameter `readRow` is the one place still to tidy).
- **Command or query, not both.** A function that answers a question doesn't change the world.
- Exported functions first in the file, private helpers below them, in call order. Read top-down.

### 4.3 Types

- **`readonly` by default** on interface fields, and `readonly T[]` for collections you don't own.
- **Make illegal states unrepresentable.** Union types over booleans: `SyncChoice` is
  `{ mode: 'create-new' } | { mode: 'attach', activityId }`, so "attach with no activity" cannot be
  typed. `JobStatus` is a union of four strings, not `string`.
- The compiler is strict on purpose: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noUnusedLocals`, `verbatimModuleSyntax`. Two idioms follow from that, and both are house style:

  ```ts
  // exactOptionalPropertyTypes: spread the key in, don't pass undefined
  ...(options.offsetS === undefined ? {} : { offsetS: options.offsetS })

  // noUncheckedIndexedAccess: `!` only where presence is proven on the line above
  const row = rows[0]
  if (!row) return null
  ```

- **`!` needs the proof adjacent to it.** If you can't see why it's safe on the same screen, it isn't.
- **No `any`.** `unknown` at the boundary, narrowed immediately. No `as` casts to silence the
  compiler — a cast is a claim you owe the reader a reason for.
- **`import type`** for type-only imports. Import order: `node:` builtins, blank line, `~/` absolute,
  blank line, relative. Named exports only; no default exports.

### 4.4 Comments

The code says *what*. A comment earns its place by saying *why* — and this codebase's comments are
its best feature. Keep the standard:

```ts
/**
 * CSRF states for in-flight authorizations, kept in Postgres so any web node can finish the flow.
 */

/** Content-addressed, so the same session re-exported with different settings keeps its identity. */

/** A path router with `:name` parameters — no more than these routes need. */
```

- A doc comment on every exported type, class and non-obvious function, in prose, explaining the
  decision or the constraint behind it.
- **Never narrate the code.** `// increment the counter` is noise.
- **No commented-out code.** Git remembers.
- **No TODOs.** File an issue and reference it, or do it.

### 4.5 Errors

- **Typed error classes for expected failures**, carrying what the caller needs to act:
  `WriteStepError` (which step, which steps completed), `AdapterDegradedError`,
  `ReconnectRequiredError`, `PermanentJobFailure`. The web layer turns each into the right page in
  `asWebResponse`; add yours there.
- **Fail loudly at the boundary, degrade precisely inside.** A malformed MyFreelap field drops that
  field or skips that rep — it never becomes a `0` that looks like a measurement. Never fabricate
  data to keep a happy path happy.
- **No swallowed exceptions.** No empty `catch`. Catch to add context or to compensate, then rethrow.
- Error messages address the person who will read them: athlete-facing messages say what happened
  and what to do next; internal ones name the value that was wrong.

### 4.6 Non-negotiables

- **Never log or persist a secret in the clear.** Tokens, API keys, passwords, cookie values,
  credentials. They live sealed via `EnvelopeCipher`. If a new log line could carry one, it can't ship.
- **Never write to an athlete's activity without a way to identify and undo what we wrote.**
  Deterministic `FL #` names, the fenced description block, our own custom fields. Their intervals
  and their prose survive every re-sync untouched.
- **No background use of an athlete's credentials.** §4.2 of the design: fetch on user action only.
- **`console.*` is not logging.** It is allowed in `src/cli/` as CLI output, and in the three
  process entry points (`src/web/main.ts`, `src/worker/main.ts`, `src/db/migrate-cli.ts`) for
  startup and fatal messages. Nowhere else — and issue #25 removes even those in favour of a logger.
- **Migrations are append-only.** Add a file in `migrations/`; never edit one that has shipped.

---

## 5. Adding things

**A new use case** → an acceptance test in `test/acceptance/` first; a method on `SyncApplication`;
no orchestration in `web/`, `cli/` or `jobs/` — those adapters translate and delegate, nothing more.

**A new route** → an e2e test in `test/e2e/web-journey.test.ts` first; register in the relevant
`src/web/routes/*.ts`; a non-GET route needs its CSRF check (#1) and must be reachable only by a
signed-in athlete unless deliberately added to `PUBLIC_PATHS`.

**A new ingestion source** → implement `FreelapSource`; convert to `SprintSession` at the edge; add
it to the contract test that asserts every source produces the identical session; wire it in
`src/config.ts`; flag it off until it has met reality.

**A new job** → a handler in `src/jobs/`; make it **idempotent** (it will be retried) and give it a
sensible `maxAttempts`; throw `PermanentJobFailure` for what retrying cannot fix.

**A new port implementation** → make the existing contract test run against it. If it can't, fix the
port, not the test.

**A new configuration value** → `Config` in `src/config.ts`, read through `required()` or with an
explicit default, documented in `.env.example` and in the README's table.

---

## 6. Before you stop

- [ ] Every new behaviour was driven by a test that failed first.
- [ ] `npm run check` is green — typecheck, lint **and** the full suite.
- [ ] No new lint warnings; the counts in §1 did not grow.
- [ ] No `eslint-disable` added. If a rule was genuinely wrong, the rule changed, not the call site.
- [ ] No `any`, no unexplained `as`, no `!` without adjacent proof.
- [ ] No `console.*` outside `src/cli/`, no commented-out code, no TODOs.
- [ ] No secret, credential or athlete-identifying value in a log line, an error message or a fixture.
- [ ] New exported types and non-obvious functions carry a doc comment saying *why*.
- [ ] `src/config.ts` is still the only place that reads the environment and wires adapters.
- [ ] `README.md` and `.env.example` updated if behaviour or configuration changed.
- [ ] The issue's acceptance criteria are ticked because they are true, not because you're finished.

---

## 7. Deliberate decisions — do not "fix" these

`README.md` → *Decisions that differ from the design doc* records five choices that look like bugs
and are not: rep wall clocks read as rep **starts**; interval timing verified to ±1.0 s in both
modes; attaching to another session's activity refused up front; a Postgres queue rather than
Redis/BullMQ; email-only sign-in with a signed cookie standing in for real authentication.

`GAPS.md` records what is genuinely missing, with each item tracked as issue #1–#38. Known gaps are
not defects you discovered — check there before "fixing" something, and if you disagree with a
decision, argue it in the issue rather than changing it in passing.
