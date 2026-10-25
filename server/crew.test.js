import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCrew, previewCrew, validateCrew } from './crew.js';
import { git } from './snapshots.js';
import { crewExecutor, crewSession } from './crew-agent.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'crew-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  await import('node:fs/promises').then(fs => fs.mkdir(repo));
  for (const args of [['init'], ['config', 'user.email', 'crew@test.local'], ['config', 'user.name', 'Crew Test']]) assert.equal((await git(repo, args)).ok, true);
  await writeFile(join(repo, 'base.txt'), 'base\n');
  await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'initial']);
  return { repo, home: join(root, 'home') };
}
const task = (id, dependencies = []) => ({ id, kind: 'execute', backend: 'codex', outcome: `write ${id}`, scope: [`${id}.txt`], dependencies, checks: [`test -f ${id}.txt`] });
const config = (repo, mode = 'parallel', tasks = [task('a'), task('b')]) => ({ request: 'Add the assigned files', cwd: repo, mode, concurrency: 2, tasks, reviewer: { backend: 'codex' }, agreement: 'One file per task' });
async function until(crew, id, status) {
  for (let i = 0; i < 3000; i++) { const run = crew.read(id); if (status.includes(run.status)) return run; await new Promise(r => setTimeout(r, 10)); }
  assert.fail(`Timed out: ${JSON.stringify(crew.read(id))}`);
}
function fake(stats = {}, custom = async () => {}, overlap = 0) {
  let entered = 0;
  let open = () => {};
  const gate = overlap > 1 ? new Promise(resolve => { open = resolve; }) : null;
  return async args => {
    stats.calls = (stats.calls || 0) + 1;
    if (args.readOnly) { await custom(args); return 'Actual review\nCREW_VERDICT: PASS'; }
    stats.running = (stats.running || 0) + 1; stats.max = Math.max(stats.max || 0, stats.running);
    try {
      if (gate) { entered += 1; if (entered >= overlap) open(); await gate; }
      await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 40); args.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true }); });
      await custom(args);
      const id = /write (\w+)/.exec(args.prompt)?.[1];
      await writeFile(join(args.cwd, `${id}.txt`), `${id}\n`);
      return 'Implemented; server checks provide evidence.';
    } finally { stats.running--; }
  };
}
test('a foreign owner is refused before a queued action can return the run', async t => {
  const { repo, home } = await fixture(t);
  const crew = createCrew({ home, execute: async () => 'nope' });
  const run = crew.create('owner', config(repo, 'sequential', [task('a')]), 'foreign-owner');
  await assert.rejects(crew.action('intruder', run.id, 'start'), /Crew not found in this conversation/);
  await assert.rejects(crew.action('intruder', run.id, 'resume'), /Crew not found in this conversation/);
  assert.equal(crew.read(run.id).owner, 'owner');
});

for (const mode of ['sequential', 'parallel']) test(`${mode}: actual worktrees, scheduling, checks and serial integration`, async t => {
  const { repo, home } = await fixture(t); const stats = {};
  await writeFile(join(repo, 'user.txt'), 'uncommitted user change');
  const crew = createCrew({ home, execute: fake(stats, async () => {}, mode === 'parallel' ? 2 : 0) });
  const run = crew.create('owner', config(repo, mode), `success-${mode}`);
  assert.equal(crew.create('owner', config(repo, mode), run.id).id, run.id);
  await Promise.all([crew.action('owner', run.id, 'start'), crew.action('owner', run.id, 'start')]);
  const done = await until(crew, run.id, ['done', 'blocked']);
  assert.equal(done.status, 'done', JSON.stringify(done));
  assert.equal(stats.max, mode === 'parallel' ? 2 : 1);
  assert.equal(stats.calls, 5); assert.equal(done.gate.ok, true);
  assert.equal(await readFile(join(done.integration.path, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(await readFile(join(done.integration.path, 'b.txt'), 'utf8'), 'b\n');
  assert.equal(await readFile(join(done.integration.path, 'user.txt'), 'utf8'), 'uncommitted user change');
  assert.equal(await readFile(join(repo, 'user.txt'), 'utf8'), 'uncommitted user change');
  assert.match(done.diff, /a.txt/); assert.match(done.diff, /b.txt/);
  assert.equal((await git(repo, ['status', '--porcelain'])).out, '?? user.txt');
});
test('plan approval persists exact handoff and gates builders', async t => {
  const { repo, home } = await fixture(t); const stats = {};
  const plan = { ...task('plan'), kind: 'plan', scope: ['.'] };
  const crew = createCrew({ home, execute: fake(stats, async args => { if (!args.readOnly) assert.match(args.prompt, /approved exact plan/); }) });
  const r = crew.create('owner', config(repo, 'parallel', [plan, task('a')]), 'plan-approval');
  await crew.action('owner', r.id, 'start');
  let waiting = await until(crew, r.id, ['awaiting_approval']); assert.equal(stats.calls, 1);
  assert.equal(waiting.tasks[1].status, 'pending');
  await crew.action('owner', r.id, 'approve', { taskId: 'plan', plan: 'approved exact plan' });
  const done = await until(crew, r.id, ['done', 'blocked']); assert.equal(done.status, 'done', JSON.stringify(done));
  assert.equal(done.tasks[0].approvedPlan, 'approved exact plan');
});
test('failed checks block dependent dispatch; retries bounded; owner isolation', async t => {
  const { repo, home } = await fixture(t); const a = task('a'); a.checks = ['exit 7'];
  const crew = createCrew({ home, execute: fake() }); const r = crew.create('owner', config(repo, 'parallel', [a, task('b', ['a'])]), 'failure-run');
  await crew.action('owner', r.id, 'start');
  const blocked = await until(crew, r.id, ['blocked']); assert.equal(blocked.tasks[0].gate.ok, false); assert.equal(blocked.tasks[1].history.length, 0);
  await assert.rejects(crew.action('other', r.id, 'resume'), /not found/);
  for (let i = 0; i < 2; i++) { await crew.action('owner', r.id, 'retry', { taskId: 'a' }); await until(crew, r.id, ['blocked']); }
  await assert.rejects(crew.action('owner', r.id, 'retry', { taskId: 'a' }), /limit reached/);
});
test('pause and stop propagate abort; refresh does not dispatch; restart pauses', async t => {
  const { repo, home } = await fixture(t); let entered = false, aborted = 0;
  const crew = createCrew({ home, execute: async args => { entered = true; await new Promise(resolve => args.signal.addEventListener('abort', () => { aborted++; resolve(); }, { once: true })); throw new Error('aborted'); } });
  const r = crew.create('owner', config(repo), 'pause-stop'); await crew.action('owner', r.id, 'start');
  while (!entered) await new Promise(r => setTimeout(r, 5));
  await crew.action('owner', r.id, 'stop'); assert.equal(crew.read(r.id).status, 'stopped'); assert.ok(aborted > 0);
  assert.equal(crew.list('owner').length, 1); assert.equal(crew.list('else').length, 0);
  const raw = crew.read(r.id); raw.status = 'running'; raw.tasks[0].status = 'running';
  const { docSet } = await import('./db.js'); docSet('crew', r.id, raw, home);
  const recovered = createCrew({ home, execute: () => assert.fail('recovery must not dispatch') });
  assert.equal(recovered.read(r.id).status, 'paused'); assert.equal(recovered.read(r.id).tasks[0].status, 'interrupted');
});
test('parallel conflicting changes are retained and never marked done', async t => {
  const { repo, home } = await fixture(t);
  const tasks = [task('a'), task('b')].map(t => ({ ...t, scope: ['base.txt'], checks: ['test -f base.txt'] }));
  const crew = createCrew({ home, execute: async args => { if (!args.readOnly) { const id = /write (\w+)/.exec(args.prompt)[1]; await new Promise(r => setTimeout(r, 40)); await writeFile(join(args.cwd, 'base.txt'), id + '\n'); return 'changed'; } return 'CREW_VERDICT: PASS'; } });
  const r = crew.create('owner', config(repo, 'parallel', tasks), 'conflict-run'); await crew.action('owner', r.id, 'start');
  const blocked = await until(crew, r.id, ['blocked']); assert.equal(blocked.tasks.filter(t => t.status === 'conflict').length, 1);
  assert.equal(await readFile(join(repo, 'base.txt'), 'utf8'), 'base\n');
  assert.equal((await git(blocked.integration.path, ['rev-parse', '--verify', 'CHERRY_PICK_HEAD'])).ok, true);
  await assert.rejects(crew.action('owner', r.id, 'accept-resolution', { taskId: blocked.tasks.find(t => t.status === 'conflict').id }), /Finish resolving/);
});
test('preview lists the field message under its assignment', () => {
  const raw = config('/tmp');
  const cycle = previewCrew({ ...raw, tasks: [task('a4', ['a5']), task('a5', ['a4'])] });
  assert.match(cycle.join('\n'), /a4\.dependencies: cycle a4 → a5 → a4/);
  const checks = previewCrew({ ...raw, tasks: [{ ...task('a3'), checks: [] }] });
  assert.match(checks.join('\n'), /a3\.checks: execute assignments need at least one acceptance check/);
  const reader = previewCrew({ ...raw, tasks: [{ ...task('a2'), kind: 'diagnose', backend: 'grok', checks: ['look'] }] });
  assert.match(reader.join('\n'), /a2\.backend: grok cannot run diagnose assignments read-only/);
  assert.deepEqual(previewCrew(raw), []);
});
test('boundary validation rejects cycles, duplicate IDs, unsupported read-only backend and unsafe scope', () => {
  const raw = config('/tmp');
  assert.throws(() => validateCrew({ ...raw, tasks: [task('a', ['b']), task('b', ['a'])] }), /cycle/);
  assert.throws(() => validateCrew({ ...raw, tasks: [task('a'), task('a')] }), /unique/);
  assert.throws(() => validateCrew({ ...raw, reviewer: { backend: 'grok' } }), /read-only/);
  assert.throws(() => validateCrew({ ...raw, tasks: [{ ...task('a'), scope: ['../escape'] }] }), /relative/);
});
test('native adapter enforces permissions, completion errors and aborts without another prompt', async () => {
  let options, listener, stopped = 0, prompted = 0;
  const agent = { async start(cwd, opts) { options = opts; return { ok: true }; }, onEvent(fn) { listener = fn; return () => {}; }, async prompt() { prompted++; listener({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'report' }] } }); listener({ type: 'agent_end' }); return { ok: true }; }, async abort() {} };
  const execute = crewExecutor({ getAgent: () => agent, stopAgent: () => { stopped++; } });
  const args = { backend: 'codex', sessionKey: 'worker', cwd: '/tmp', prompt: 'do work', signal: new AbortController().signal, onEvent() {}, onSession() {} };
  assert.equal(await execute({ ...args, readOnly: true }), 'report'); assert.equal(options.accessMode, 'read-only'); assert.equal(options.agentMode, 'plan');
  await execute({ ...args, readOnly: false }); assert.equal(options.agentMode, 'manual'); assert.equal(stopped, 2);
  const controller = new AbortController(); controller.abort(); await assert.rejects(execute({ ...args, signal: controller.signal }), /interrupted/); assert.equal(prompted, 2);
  const session = crewSession({ getAgent: () => agent, stopAgent: () => { stopped++; } });
  await session.open({ backend: 'codex', sessionKey: 'kept', cwd: '/tmp', readOnly: false });
  assert.equal(await session.turn('first', { signal: new AbortController().signal }), 'report');
  assert.equal(await session.turn('second', { signal: new AbortController().signal }), 'report');
  assert.equal(stopped, 2, 'two turns do not stop the session');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(session.turn('third', { signal: aborted.signal }), /interrupted/);
  assert.equal(stopped, 3, 'an aborted turn stops the session');
});
test('session startup stops a starting agent on close, abort, and timeout', async () => {
  const hang = () => new Promise(() => {});
  let closed = 0;
  const closing = crewSession({ timeoutMs: 60_000, getAgent: () => ({ start: hang }), stopAgent: async () => { closed += 1; } });
  const opening = closing.open({ backend: 'codex', sessionKey: 'hung', cwd: '/tmp', readOnly: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  await closing.close();
  await assert.rejects(opening, /interrupted/);
  assert.equal(closed, 1, 'close() stops an agent that has not finished starting');

  let abortedStops = 0;
  const controller = new AbortController();
  const aborting = crewSession({ timeoutMs: 60_000, getAgent: () => ({ start: hang }), stopAgent: async () => { abortedStops += 1; } });
  const abortedOpen = aborting.open({ backend: 'codex', sessionKey: 'abort', cwd: '/tmp', readOnly: true, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(abortedOpen, /interrupted/);
  assert.equal(abortedStops, 1, 'abort during start stops the agent');

  let timedStops = 0;
  const timing = crewSession({ timeoutMs: 30, getAgent: () => ({ start: hang }), stopAgent: async () => { timedStops += 1; } });
  await assert.rejects(timing.open({ backend: 'codex', sessionKey: 'time', cwd: '/tmp', readOnly: true }), /timed out/);
  assert.equal(timedStops, 1, 'startup timeout stops the agent without waiting for start()');
});
test('a rejected start stops the agent and the next open can start', async () => {
  let stopped = 0;
  let starts = 0;
  const session = crewSession({
    getAgent: () => ({
      async start() {
        starts += 1;
        if (starts === 1) throw new Error('backend refused');
        return { ok: true };
      },
    }),
    stopAgent: async () => { stopped += 1; },
  });
  await assert.rejects(session.open({ backend: 'codex', sessionKey: 'reject', cwd: '/tmp', readOnly: true }), /backend refused/);
  assert.equal(stopped, 1);
  assert.equal(starts, 1);
  await session.open({ backend: 'codex', sessionKey: 'reject', cwd: '/tmp', readOnly: true });
  assert.equal(starts, 2);
  assert.equal(stopped, 1, 'a later successful open does not stop again');

  let refusedStops = 0;
  const refused = crewSession({
    getAgent: () => ({ async start() { return { ok: false, error: 'nope' }; } }),
    stopAgent: async () => { refusedStops += 1; },
  });
  await assert.rejects(refused.open({ backend: 'codex', sessionKey: 'nope', cwd: '/tmp', readOnly: true }), /nope/);
  assert.equal(refusedStops, 1, 'a refused start stops the agent once');

  let preStops = 0;
  let preStarts = 0;
  const aborted = new AbortController();
  aborted.abort();
  const pre = crewSession({
    getAgent: () => ({ async start() { preStarts += 1; return { ok: true }; } }),
    stopAgent: async () => { preStops += 1; },
  });
  await assert.rejects(pre.open({ backend: 'codex', sessionKey: 'pre', cwd: '/tmp', readOnly: true, signal: aborted.signal }), /interrupted/);
  assert.equal(preStarts, 0, 'an already-aborted open does not start the agent');
  assert.equal(preStops, 0, 'an already-aborted open does not stop the agent');

  let syncStops = 0;
  const sync = crewSession({
    getAgent: () => ({ async start() { throw new Error('backend refused'); } }),
    stopAgent() { syncStops += 1; },
  });
  await assert.rejects(sync.open({ backend: 'codex', sessionKey: 'sync', cwd: '/tmp', readOnly: true }), /backend refused/);
  assert.equal(syncStops, 1, 'a synchronous stopAgent still runs and the start error is kept');
});

