// Independent Opus QA regressions. Agent outputs are SIMULATED; Git worktrees,
// SQLite persistence, cherry-picks and acceptance commands are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCrew } from './crew.js';
import { docSet } from './db.js';
import { git } from './snapshots.js';

const delay = ms => new Promise(r => setTimeout(r, ms));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'crew-recovery-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); await mkdir(repo);
  for (const args of [['init'], ['config', 'user.email', 'qa@example.invalid'], ['config', 'user.name', 'QA']]) assert.equal((await git(repo, args)).ok, true);
  await writeFile(join(repo, 'base.txt'), 'base\n'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'base']);
  return { repo, home: join(root, 'home') };
}
const task = (id, kind = 'execute', dependencies = []) => ({ id, kind, backend: 'codex', outcome: `write ${id}`, dependencies, scope: ['.'], checks: ['test -f base.txt'] });
const config = (repo, tasks, mode = 'sequential') => ({ request: 'Complete assigned outcomes', cwd: repo, mode, concurrency: 2, tasks, reviewer: { backend: 'codex' } });
async function until(crew, id, predicate, label = '') { for (let n = 0; n < 3000; n++) { const r = crew.read(id); if (predicate(r)) return r; await delay(10); } assert.fail(`${label} ${JSON.stringify(crew.read(id))}`); }
const settled = (crew, id) => until(crew, id, r => ['done', 'blocked', 'awaiting_approval', 'paused', 'stopped'].includes(r.status));
async function worker(a) { if (!a.readOnly) await writeFile(join(a.cwd, /write (\w+)/.exec(a.prompt)[1] + '.txt'), 'done\n'); return 'CREW_VERDICT: PASS'; }

test('pause then resume continues in-flight work without spending repair attempts', async t => {
  const { repo, home } = await fixture(t); let calls = 0;
  const crew = createCrew({ home, execute: async a => {
    if (!a.readOnly && ++calls <= 3) { await new Promise(r => a.signal.addEventListener('abort', r, { once: true })); throw new Error('aborted'); }
    return worker(a);
  } });
  const r = crew.create('owner', config(repo, [task('build')]), 'pause-resume-budget');
  await crew.action('owner', r.id, 'start');
  for (let n = 1; n <= 3; n++) {
    await until(crew, r.id, () => calls === n, `worker dispatch ${n}`);
    await crew.action('owner', r.id, 'pause');
    const resumed = await crew.action('owner', r.id, 'resume');
    assert.notEqual(resumed.status, 'blocked', `Resume after pause ${n} blocked the run instead of resuming: ${JSON.stringify(resumed.tasks.map(t => [t.id, t.status, t.attempts]))}`);
  }
  const result = await settled(crew, r.id);
  assert.equal(result.status, 'done', JSON.stringify(result.tasks.map(t => [t.id, t.status, t.attempts, t.error])));
});

test('edited approved plan is authoritative: the unedited plan never reaches builder or reviewers', async t => {
  const { repo, home } = await fixture(t); const prompts = [];
  const crew = createCrew({ home, execute: async a => {
    if (a.prompt.startsWith('Crew assignment: write plan')) return 'Step 1: ORIGINAL_UNAPPROVED_STEP drop the users table';
    prompts.push(a.prompt); return worker(a);
  } });
  const r = crew.create('owner', config(repo, [task('plan', 'plan'), task('build')]), 'edited-plan-authority');
  await crew.action('owner', r.id, 'start'); assert.equal((await settled(crew, r.id)).status, 'awaiting_approval');
  await crew.action('owner', r.id, 'approve', { taskId: 'plan', plan: 'EDITED_SAFE_PLAN only add build.txt' });
  assert.equal((await settled(crew, r.id)).status, 'done');
  assert.ok(prompts.length >= 3 && prompts.every(p => p.includes('EDITED_SAFE_PLAN')));
  assert.equal(prompts.filter(p => p.includes('ORIGINAL_UNAPPROVED_STEP')).length, 0, 'Rejected plan text was handed to downstream agents alongside the approved edit');
});

test('a saved Review stage that fails blocks the run', async t => {
  const { repo, home } = await fixture(t);
  const crew = createCrew({ home, execute: async a => {
    if (a.prompt.startsWith('Crew assignment: write review')) return 'Build is missing the required tests.\nCREW_VERDICT: FAIL';
    return worker(a);
  } });
  const r = crew.create('owner', config(repo, [task('build'), task('review', 'review', ['build'])]), 'review-stage-fail');
  await crew.action('owner', r.id, 'start'); const result = await settled(crew, r.id);
  assert.notEqual(result.status, 'done', 'Route Review stage returned CREW_VERDICT: FAIL, yet the crew finished done');
});

test('restart after cherry-pick but before acceptance save has an in-product recovery path', async t => {
  const { repo, home } = await fixture(t);
  const crew = createCrew({ home, execute: worker });
  const r = crew.create('owner', config(repo, [task('build')]), 'restart-integration-window');
  await crew.action('owner', r.id, 'start'); const done = await settled(crew, r.id); assert.equal(done.status, 'done');
  // Reconstruct the persisted state of a crash between `git cherry-pick` and `status = accepted`.
  const crashed = structuredClone(done); const tk = crashed.tasks[0];
  crashed.status = 'running'; crashed.phase = undefined; crashed.diff = undefined; crashed.gate = undefined; crashed.finalHistory = []; crashed.finalReview = '';
  tk.status = 'reviewing'; delete tk.integratedCommit;
  assert.notEqual((await git(done.integration.path, ['rev-parse', 'HEAD'])).out, tk.integrationBefore, 'fixture: integration already advanced');
  docSet('crew', r.id, crashed, home);
  const restarted = createCrew({ home, execute: worker });
  assert.equal(restarted.read(r.id).status, 'paused');
  const errors = [];
  for (const op of ['resume', 'retry', 'accept-resolution']) {
    try { await restarted.action('owner', r.id, op, { taskId: 'build' }); } catch (e) { errors.push(`${op}: ${e.message}`); continue; }
    const now = await settled(restarted, r.id); if (now.status === 'done') return;
  }
  assert.fail(`No action completes the already-integrated candidate after restart:\n${errors.join('\n')}\n${JSON.stringify(restarted.read(r.id).tasks.map(t => [t.status, t.error]))}`);
});

test('a late Stop/Pause click cannot overwrite a finished run', async t => {
  const { repo, home } = await fixture(t);
  const crew = createCrew({ home, execute: worker });
  const r = crew.create('owner', config(repo, [task('build')]), 'late-stop-done');
  await crew.action('owner', r.id, 'start'); assert.equal((await settled(crew, r.id)).status, 'done');
  for (const op of ['stop', 'pause']) { try { await crew.action('owner', r.id, op); } catch {} }
  assert.equal(crew.read(r.id).status, 'done', 'Stop/Pause after completion replaced the done state');
});

test('Stop after worktree save cannot dispatch the worker', async t => {
  const { repo, home } = await fixture(t);
  const box = {};
  let stopPromise, once = false, dispatched = false;
  box.crew = createCrew({ home, publish() {
    if (once || !box.crew) return;
    const run = box.crew.read('stop-after-worktree');
    if (!run?.tasks?.some(task => task.status === 'running' && task.worktree && !(task.history || []).length)) return;
    once = true;
    stopPromise = box.crew.action('owner', run.id, 'stop');
  }, execute() { dispatched = true; return 'should not run'; } });
  const r = box.crew.create('owner', config(repo, [task('build')]), 'stop-after-worktree');
  const starting = box.crew.action('owner', r.id, 'start');
  for (let n = 0; n < 3000 && !stopPromise; n++) await delay(10);
  assert.ok(stopPromise, 'Stop did not run after the worktree was saved');
  await Promise.all([stopPromise, starting]);
  const stopped = box.crew.read(r.id);
  assert.equal(dispatched, false);
  assert.equal(stopped.status, 'stopped');
  assert.ok(stopped.tasks[0].worktree?.path);
  assert.equal(stopped.tasks[0].history.length, 0);
});

test('stale commit/integrationBefore lets accept-resolution accept an un-integrated task', async t => {
  const { repo, home } = await fixture(t);
  const crew = createCrew({ home, execute: worker });
  const r = crew.create('owner', config(repo, [task('a'), task('b')], 'parallel'), 'stale-probe-1');
  await crew.action('owner', r.id, 'start');
  const done = await settled(crew, r.id);
  assert.equal(done.status, 'done');
  // Roll integration back to before 'a' and re-apply only 'b': state = a's first accept was interrupted
  // pre-cherry-pick (HEAD == integrationBefore), resume reset it to pending, then b integrated and a
  // was interrupted again inside taskWork, keeping the stale commit/integrationBefore.
  const integ = done.integration.path;
  const b = done.tasks.find(task => task.id === 'b');
  assert.equal((await git(integ, ['reset', '--hard', done.baseline])).ok, true);
  assert.equal((await git(integ, ['cherry-pick', b.commit])).ok, true);
  const crashed = structuredClone(done);
  const ta = crashed.tasks.find(task => task.id === 'a');
  crashed.status = 'paused';
  ta.status = 'interrupted';
  delete ta.integratedCommit;
  ta.integrationBefore = done.baseline;
  docSet('crew', r.id, crashed, home);
  const again = createCrew({ home, execute: worker });
  const res = await again.action('owner', r.id, 'accept-resolution', { taskId: 'a' }).catch(e => ({ err: e.message }));
  const exists = await readFile(join(integ, 'a.txt')).then(() => true, () => false);
  assert.ok(res.err || exists, `accept-resolution marked 'a' ${again.read(r.id).tasks.find(task => task.id === 'a').status} but a.txt is NOT in integration HEAD`);
});
