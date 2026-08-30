# CLAUDE.md

**The instructions for working in this repository are in [AGENTS.md](AGENTS.md). Read it before
your first edit and follow it as written.** This file only points at it and repeats the handful of
rules most easily lost in a long session.

@AGENTS.md

---

## What this is

Takes a timed sprint session from a Freelap system and writes it into intervals.icu — as structured
intervals, summary custom fields and a rep table — then reads the activity back and reports every
way it differs from what was intended. Ports and adapters, pure domain at the centre.

`README.md` is the product and how to run it. `AGENTS.md` is how to change it.

## The gate

```bash
npm run check    # typecheck + lint + 246 tests. Green before you stop, no exceptions.
```

## The five that matter most

1. **No production code without a failing test that demanded it.** Outside-in: start at the
   outermost layer where the change is observable, watch it fail, then drive inward.
   AGENTS.md §3.
2. **Never edit an acceptance test to make it pass.** If it was right when you wrote it, it is
   right now. Change the code.
3. **Never add an `eslint-disable`.** The rules in `eslint.config.js` encode AGENTS.md and the
   codebase already satisfies every one of them. If a rule is genuinely wrong, change the rule and
   AGENTS.md together, and say so — do not silence it at the call site.
4. **Don't grow the warning count.** Lint runs at 0 errors and ~40 known warnings, each one listed
   in AGENTS.md §1 as finite debt. New warnings are new debt.
5. **Check before you "fix".** GitHub issues #1–#38 record what is knowingly missing, each with
   numbered requirements and Given/When/Then acceptance criteria. `README.md` records five
   decisions that differ from the design doc on purpose. A known gap is not a bug you discovered.

## Scope

Do the task asked. If you find a real problem outside it, say so and file or reference an issue —
don't fold an unrelated refactor into the diff. One reason to change per commit: behaviour or
refactor, never both.
