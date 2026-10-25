# crew

A multi-agent coding workflow. You give it one request. A read-only lead turns it into acceptance criteria and a plan, builders work in parallel git worktrees, the results are merged and checked, and a reviewer grades the outcome against the criteria. Nothing writes to your files until you approve the plan.

## How a run goes

```
crew <request>
   │
① LEAD (read-only)          acceptance criteria, questions, which steps to run
   │
🛑 Gate: criteria            answer questions, edit criteria, pick models → Approve
   │
② INVESTIGATE (optional)    plan or diagnose, read-only → findings + work split
   │
🛑 Gate: split               only when the split has more than one worker
   │
③ BUILD  W1 ‖ W2 ‖ …        parallel, one worktree each, checks run per worker
   │
④ MERGE                     cherry-pick each worker into an integration worktree
   │
⑤ COMBINED CHECKS           the chosen check commands run on the merge
   │
⑥ INTEGRATOR                one builder session that fixes failing checks
   │
⑦ PROSECUTION (optional)    adversarial check of the result against the criteria
   │
⑧ FINAL REVIEW (optional)   fresh read-only reviewer, verdict per criterion
   │
🛑 Gate: review              blocker findings → send them back to the integrator
```

Safety rules the engine enforces, not the models:

- Read-only stages are verified read-only with git snapshots.
- Work is scoped to repository-relative paths.
- Check commands come only from a server-built menu, never from model output.
- A restart leaves a run `paused`, never half-applied.

## Layout

| Path | What it is |
| --- | --- |
| `server/crew.js` | Run engine: validation, lead parsing, gates, parallel build, merge, checks, review loop. Runs persist in the host database. |
| `server/crew-agent.js` | Adapts an agent pool to the engine: one-shot executor and long-lived sessions. |
| `server/crew-review.js` | Parses the reviewer's verdicts and findings. |
| `server/*.test.js` | Unit, flow, recovery, HTTP and UI validation tests. |
| `src/lib/crew.ts` | Shared run, task, gate and review types. |
| `src/lib/crewTimeline.ts` | Places run cards in a chat timeline. |
| `src/components/CrewPanel.tsx` | Plan editor, run cards, gate controls, run history. |
| `src/styles/crew.css` | Styles for the panel and cards. |
| `scripts/crew-native-smoke.mjs` | End-to-end smoke run against a real Codex agent. |

## Host interface

crew is the workflow layer. It runs inside a host app that provides:

- **Agents:** pools for `pi`, `claude`, `codex` and `grok` with `getAgent(key, backend)` / `stopAgent(key, backend)`
- **Storage:** `db.js` (`db`, `docGet`, `docSet`)
- **Git:** `worktrees.js` (`createWorktree`) and `snapshots.js` (`git`, `takeSnapshot`)
- **Checks:** `prosecutor.js` and `prosecutor-checks.js`, which provide the gate runner, integrity checks and the prosecution loop
- **Client:** `lib/api.ts`, `lib/store.tsx` and `lib/route.ts` for the panel

Create the engine with `createCrew({ execute, openSession, prosecutor, availableBackends, publish })` and expose its `list`, `create`, `auto` and `action` operations. The actions are `approve`, `approve-criteria`, `approve-split`, `answer`, `repair`, `retry`, `resume`, `stop`, `send-findings`, `accept-review`, `accept-resolution` and `prosecution-choice`. Open the panel by dispatching a `crew-open` window event with `{ key, request }`.
