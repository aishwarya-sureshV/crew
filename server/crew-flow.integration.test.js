import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, access, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCrew } from './crew.js';
import { createProsecutor } from './prosecutor.js';
import { crewSession } from './crew-agent.js';
import { git } from './snapshots.js';
import { docSet } from './db.js';

const connected = async () => [
  { id: 'codex', path: '/test/codex', auth: 'ok', enabled: true },
  { id: 'grok', path: '/test/grok', auth: 'ok', enabled: true },
  { id: 'pi', path: '/test/pi', auth: 'ok', enabled: true },
];
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'end_turn' });
const FAIL = 'FINDING R1 | AC1 | blocker | product.txt:1 | missing proof\nVERDICT AC1: FAIL\nVERDICT AC2: PASS\nCREW_VERDICT: FAIL';
const PASS = 'FINDING R1 | - | nit | product.txt:1 | rename the local\nVERDICT AC1: PASS\nVERDICT AC2: PASS\nCREW_VERDICT: PASS';
const GUILTY = 'FINDING F1 | AC1 | the proof fails | proofs/ac.txt:1\nVERDICT: GUILTY';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'crew-flow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  await mkdir(repo);
  for (const args of [['init'], ['config', 'user.email', 'crew@test.local'], ['config', 'user.name', 'Crew Test']]) assert.equal((await git(repo, args)).ok, true);
  await writeFile(join(repo, 'base.txt'), 'base\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'initial']);
  return { repo, home: join(root, 'home') };
}
async function until(crew, id, status, tries = 4000) {
  for (let i = 0; i < tries; i++) {
    const run = crew.read(id);
    if (run && status.includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const last = crew.read(id);
  assert.fail(`Timed out: ${JSON.stringify({ status: last?.status, phase: last?.phase, error: last?.error })}`);
}
function lead(checks) {
  return {
    summary: 'Add the product file.',
    criteria: [{ id: 'AC1', text: 'product.txt exists' }, { id: 'AC2', text: 'the change is reviewable' }],
    questions: [], assumptions: ['The change is small.'],
    investigate: 'none', investigateWhy: 'The request is small and clear.',
    prosecute: true, prosecuteWhy: 'Check the criteria.',
    review: true, reviewWhy: 'Look at the diff.',
    checks,
  };
}
function decisions(checks, review = true) {
  return {
    investigate: 'none', investigateWhy: 'The request is small and clear.',
    prosecute: true, prosecuteWhy: 'Check the criteria.',
    review, reviewWhy: review ? 'Look at the diff.' : 'Checks are enough.',
    checks,
  };
}
const models = {
  builder: { backend: 'codex', model: null },
  investigator: { backend: 'codex', model: null },
  prosecutor: { backend: 'codex', model: null },
  reviewer: { backend: 'codex', model: null },
};

/** One fake agent map for crewSession and the real Prosecutor. */
function harness(script) {
  const agents = new Map();
  const prosecutor = createProsecutor({
    poolFor: () => ({ stop() {}, get: key => make(key) }),
    publish() {},
    configFor: () => null,
  });
  function make(key) {
    const existing = agents.get(key);
    if (existing) return existing;
    const listeners = new Set();
    const agent = {
      sessionKey: key, cwd: '', alive: false, readOnly: false, prompts: [],
      isAlive() { return agent.alive; },
      async start(cwd, opts) {
        agent.alive = true;
        agent.cwd = cwd;
        agent.readOnly = opts?.accessMode === 'read-only';
        return { ok: true };
      },
      onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      async prompt(text) {
        const body = String(text);
        agent.prompts.push(body);
        const reply = await script(agent, body, listeners, prosecutor);
        const message = reply && typeof reply === 'object'
          ? { role: 'assistant', content: [{ type: 'text', text: String(reply.text || '') }], stopReason: reply.stopReason || 'end_turn', ...(reply.errorMessage ? { errorMessage: String(reply.errorMessage) } : {}) }
          : assistant(reply);
        for (const fn of [...listeners]) fn({ type: 'message_end', message });
        for (const fn of [...listeners]) fn({ type: 'agent_end' });
        if (key.includes('-integrator') && !key.endsWith(':prosecutor')) {
          prosecutor.onExecutorEvent(key, { type: 'message_end', message }, agent);
          prosecutor.onExecutorEvent(key, { type: 'agent_end' }, agent);
        }
        return { ok: true };
      },
      async abort() {},
    };
    agents.set(key, agent);
    return agent;
  }
  return {
    agents,
    prosecutor,
    openSession: () => crewSession({ getAgent: key => make(key), stopAgent: async () => {} }),
  };
}

test('real sessions diff snapshots, workspace config, prosecution, and review', async t => {
  const { repo, home } = await fixture(t);
  const command = 'test -f product.txt';
  docSet('prosecutor-config', repo, { testPatterns: ['proofs/**'], commands: [command] }, home);
  let reviewPasses = 0;
  const agents = harness(async (agent, body, listeners) => {
    if (body.startsWith('You are the INTEGRATOR') && !agent.handed) {
      agent.handed = true;
      for (const fn of [...listeners]) fn({ type: 'approval_request', requestId: 'perm-1', title: 'Write', detail: 'edit product', options: [{ id: 'allow', label: 'Allow' }] });
      const path = join(agent.cwd, 'product.txt');
      const current = await readFile(path, 'utf8').catch(() => '');
      await writeFile(path, current.includes('extra') ? current : `${current}extra\n`);
    }
    if (body.includes('Fix these review')) await writeFile(join(agent.cwd, 'fixed.txt'), 'fixed\n');
    if (agent.sessionKey.endsWith(':prosecutor')) {
      if (!agent.guilty) {
        agent.guilty = true;
        await mkdir(join(agent.cwd, 'proofs'), { recursive: true });
        await writeFile(join(agent.cwd, 'proofs', 'ac.txt'), 'proof\n');
        return GUILTY;
      }
      return 'VERDICT: ACQUITTED';
    }
    if (agent.readOnly) {
      reviewPasses += 1;
      return reviewPasses === 1 ? FAIL : PASS;
    }
    return 'OK';
  });
  const crew = createCrew({
    home, availableBackends: connected, openSession: agents.openSession, prosecutor: agents.prosecutor, pollMs: 20,
    execute: async args => {
      if (args.prompt.startsWith('You are the LEAD')) return JSON.stringify(lead([command]));
      await writeFile(join(args.cwd, 'product.txt'), 'product\n');
      return 'implemented';
    },
  });
  const run = crew.auto('owner', { request: 'Add product.txt', cwd: repo, backend: 'codex' }, 'flow-snapshots');
  await until(crew, run.id, ['awaiting_input']);
  await crew.action('owner', run.id, 'approve-criteria', { decisions: decisions([command]), models });
  const gate = await until(crew, run.id, ['awaiting_input', 'blocked', 'done'], 8000);
  assert.equal(gate.phase, 'review_gate', JSON.stringify({ phase: gate.phase, error: gate.error, prosecution: gate.prosecution?.status }));
  assert.notEqual(gate.prosecution.pendingRepair, true);
  await writeFile(join(gate.integration.path, 'kept.txt'), 'kept\n');
  await crew.action('owner', run.id, 'resume');
  const recovered = await until(crew, run.id, ['awaiting_input', 'blocked', 'done'], 8000);
  assert.equal(recovered.phase, 'review_gate', JSON.stringify({ phase: recovered.phase, status: recovered.status, error: recovered.error }));
  assert.equal(await readFile(join(recovered.integration.path, 'kept.txt'), 'utf8'), 'kept\n');
  assert.equal(await readFile(join(recovered.integration.path, 'proofs', 'ac.txt'), 'utf8'), 'proof\n');
  assert.doesNotMatch(recovered.events.map(event => event.text).join('\n'), /restored the interrupted repair boundary/);
  await crew.action('owner', run.id, 'send-findings', { ids: ['R1'], note: 'fix the proof' });
  const done = await until(crew, run.id, ['done', 'blocked'], 8000);
  assert.equal(done.status, 'done', JSON.stringify({ phase: done.phase, error: done.error, prosecution: done.prosecution?.status }));
  assert.equal(done.prosecution.status, 'verified');
  assert.equal(done.gate.ok, true);
  assert.match(done.gate.results.map(item => item.command).join('\n'), /test -f product.txt/);
  assert.equal(await readFile(join(done.integration.path, 'proofs', 'ac.txt'), 'utf8'), 'proof\n');
  const head = (await git(done.integration.path, ['rev-parse', 'HEAD'])).out;
  assert.notEqual(done.result, head);
  const headDiff = await git(done.integration.path, ['diff', done.baseline, head]);
  const resultDiff = await git(done.integration.path, ['diff', done.baseline, done.result]);
  assert.doesNotMatch(headDiff.out, /\n\+extra\n/);
  assert.match(resultDiff.out, /\n\+extra\n/);
  assert.equal(done.reviews.length, 2);
  assert.equal(done.reviews[1].fromCommit, done.reviews[0].toCommit);
  assert.notEqual(done.reviews[0].toCommit, head);
  assert.notEqual(done.reviews[1].toCommit, head);
  const delta = await git(done.integration.path, ['diff', '--name-only', done.reviews[0].toCommit, done.reviews[1].toCommit]);
  assert.match(delta.out, /fixed\.txt/);
  const integrators = [...agents.agents.values()].filter(agent => agent.sessionKey.includes('-integrator') && !agent.sessionKey.endsWith(':prosecutor'));
  assert.equal(integrators.length, 1);
  const prompts = integrators[0].prompts.join('\n');
  assert.match(prompts, /You are the INTEGRATOR/);
  assert.match(prompts, /Prosecution starts now/);
  assert.match(prompts, /The prosecutor's report:/);
  assert.match(prompts, /Fix these review/);
  assert.equal(done.integrator.history.some(record => record.events?.some(event => event.type === 'approval_request' && event.requestId === 'perm-1')), true);
  const reviewers = [...agents.agents.values()].filter(agent => agent.readOnly);
  assert.equal(reviewers.length, 2);
  assert.match(reviewers[0].prompts[0], /Do not use git diff HEAD/);
  const handoff = reviewers[1].prompts[0];
  assert.match(handoff, /R1 \| AC1 \| blocker \| product\.txt:1 \| missing proof/);
  assert.match(handoff, /VERDICT AC1: FAIL/);
  assert.match(handoff, /VERDICT AC2: PASS/);
  assert.match(handoff, /Note: fix the proof/);
});

test('restart adopts prosecution ownership before the replacement writes', async t => {
  const { repo, home } = await fixture(t);
  const command = 'test -f product.txt';
  docSet('prosecutor-config', repo, { testPatterns: ['proofs/**'], commands: [command] }, home);
  let releaseRepair = () => {};
  const repairHung = new Promise(resolve => { releaseRepair = resolve; });
  const firstAgents = harness(async (agent, body) => {
    if (body.includes("The prosecutor's report:")) {
      await repairHung;
      return 'FIXED';
    }
    if (agent.sessionKey.endsWith(':prosecutor')) {
      if (!agent.guilty) {
        agent.guilty = true;
        await mkdir(join(agent.cwd, 'proofs'), { recursive: true });
        await writeFile(join(agent.cwd, 'proofs', 'ac.txt'), 'proof\n');
        return GUILTY;
      }
      return 'VERDICT: ACQUITTED';
    }
    return 'OK';
  });
  const crew = createCrew({
    home, availableBackends: connected, openSession: firstAgents.openSession, prosecutor: firstAgents.prosecutor, pollMs: 20,
    execute: async args => {
      if (args.prompt.startsWith('You are the LEAD')) return JSON.stringify({ ...lead([command]), review: false, reviewWhy: 'Checks are enough.' });
      await writeFile(join(args.cwd, 'product.txt'), 'product\n');
      return 'implemented';
    },
  });
  const run = crew.auto('owner', { request: 'Add product.txt', cwd: repo, backend: 'codex' }, 'flow-restart');
  await until(crew, run.id, ['awaiting_input']);
  await crew.action('owner', run.id, 'approve-criteria', { decisions: decisions([command], false), models });
  let checkpoint = null;
  for (let i = 0; i < 4000 && !checkpoint; i++) {
    const current = crew.read(run.id);
    if (current?.status === 'blocked' || current?.status === 'done') assert.fail(JSON.stringify({ status: current.status, error: current.error }));
    if (current?.prosecution?.owned?.includes('proofs/ac.txt') && current.prosecution.baselineCommit) checkpoint = current;
    else await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(checkpoint, 'prosecution ownership was not checkpointed');
  const stopped = await crew.action('owner', run.id, 'stop');
  assert.equal(stopped.status, 'stopped');
  releaseRepair();
  await new Promise(resolve => setTimeout(resolve, 30));
  const saved = crew.read(run.id);
  saved.status = 'awaiting_input';
  saved.phase = 'prosecuting';
  saved.prosecution = { ...saved.prosecution, cap: true };
  docSet('crew', run.id, saved, home);

  let sawOwned = false;
  const nextAgents = harness(async (agent, body, _listeners, prosecutor) => {
    if (body.startsWith('You are the INTEGRATOR')) {
      sawOwned = Boolean(prosecutor.armed(agent.sessionKey)?.owned?.includes('proofs/ac.txt'));
      const path = join(agent.cwd, 'proofs', 'ac.txt');
      await writeFile(path, `${await readFile(path, 'utf8')}tamper\n`);
    }
    return 'OK';
  });
  const recovered = createCrew({
    home, availableBackends: connected, openSession: nextAgents.openSession, prosecutor: nextAgents.prosecutor, pollMs: 20,
    execute: async () => 'replacement',
  });
  assert.equal(recovered.read(run.id).status, 'paused');
  assert.match(recovered.read(run.id).error, /Prosecution is waiting/);
  await recovered.action('owner', run.id, 'resume');
  const waiting = await until(recovered, run.id, ['awaiting_input', 'blocked', 'done'], 8000);
  assert.equal(waiting.status, 'awaiting_input', JSON.stringify({ phase: waiting.phase, error: waiting.error }));
  assert.equal(sawOwned, true);
  assert.match(waiting.integrator.sessionKey, /-r1$/);
  const text = waiting.events.map(event => event.text).join('\n');
  assert.match(text, /restored prosecution ownership before the replacement wrote/);
  assert.match(text, /reverted prosecutor test edits: proofs\/ac.txt/);
  assert.equal(await readFile(join(waiting.integration.path, 'proofs', 'ac.txt'), 'utf8'), 'proof\n');
  assert.doesNotMatch(text, /starting again from the current HEAD/);
});

async function untilSaved(crew, id, pred, tries = 8000) {
  for (let i = 0; i < tries; i++) {
    const run = crew.read(id);
    if (pred(run)) return run;
    if (run?.status === 'blocked' || run?.status === 'done') assert.fail(JSON.stringify({ status: run.status, phase: run.phase, error: run.error }));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(JSON.stringify(crew.read(id)));
}
function ask(listeners, requestId) {
  for (const fn of [...listeners]) fn({ type: 'approval_request', requestId, title: 'Write', detail: 'edit', options: [{ id: 'allow', label: 'Allow' }] });
}
const planDecisions = {
  investigate: 'plan', investigateWhy: 'Two files.',
  prosecute: false, prosecuteWhy: 'Not this run.',
  review: false, reviewWhy: 'Not this run.',
  checks: ['git diff --check'],
};
const twoWorkers = {
  findings: 'two files', approach: 'separate files', contract: 'no shared writes', concerns: [],
  workers: [
    { id: 'W1', outcome: 'write a', scope: ['a.txt'], dependsOn: [], covers: ['AC1'] },
    { id: 'W2', outcome: 'write b', scope: ['b.txt'], dependsOn: [], covers: ['AC2'] },
  ],
};

async function outsideEditRun(t, id) {
  const { repo, home } = await fixture(t);
  let thrown = false;
  const agents = harness(async (agent, body) => {
    if (body.startsWith('You are the INTEGRATOR')) {
      if (!thrown) {
        thrown = true;
        await writeFile(join(agent.cwd, 'evil.txt'), 'no\n');
        throw new Error('integrator exploded');
      }
      return 'OK';
    }
    return 'OK';
  });
  const crew = createCrew({
    home, availableBackends: connected, openSession: agents.openSession, pollMs: 20,
    execute: async args => {
      if (args.prompt.startsWith('You are the LEAD')) return JSON.stringify({ ...lead(planDecisions.checks), ...planDecisions });
      if (args.prompt.includes('End with a JSON block')) return JSON.stringify(twoWorkers);
      const scope = JSON.parse(/Scope: (\[[^\]]*\])/.exec(args.prompt)?.[1] || '[]');
      if (scope[0] && scope[0] !== '.') await writeFile(join(args.cwd, scope[0]), 'x\n');
      return 'implemented';
    },
  });
  const run = crew.auto('owner', { request: 'Add two files', cwd: repo, backend: 'codex' }, id);
  await until(crew, run.id, ['awaiting_input']);
  await crew.action('owner', run.id, 'approve-criteria', {
    decisions: planDecisions,
    models: { ...models, builder: { backend: 'codex', model: { provider: 'openai', id: 'gpt-5.1' } } },
  });
  const splitGate = await until(crew, run.id, ['awaiting_input', 'blocked']);
  assert.equal(splitGate.phase, 'split', JSON.stringify({ phase: splitGate.phase, error: splitGate.error }));
  await crew.action('owner', run.id, 'approve-split', {
    workers: [{ id: 'W1', model: { backend: 'codex', model: { provider: 'openai', id: 'gpt-5.1' } } }],
  });
  const blocked = await until(crew, run.id, ['blocked', 'done'], 8000);
  return { crew, run, blocked, agents };
}

test('permission requests stay on the run while the turn is still waiting', async t => {
  const { repo, home } = await fixture(t);
  const command = 'test -f product.txt';
  docSet('prosecutor-config', repo, { testPatterns: ['proofs/**'], commands: [command] }, home);
  let releaseIntegrator = () => {};
  let releaseRepair = () => {};
  let releaseReview = () => {};
  const holdIntegrator = new Promise(resolve => { releaseIntegrator = resolve; });
  const holdRepair = new Promise(resolve => { releaseRepair = resolve; });
  const holdReview = new Promise(resolve => { releaseReview = resolve; });
  t.after(() => { releaseIntegrator(); releaseRepair(); releaseReview(); });
  const picked = {
    ...models,
    builder: { backend: 'codex', model: { provider: 'openai', id: 'gpt-5.1' } },
    prosecutor: { backend: 'codex', model: { provider: 'openai', id: 'gpt-5.1' } },
    reviewer: { backend: 'codex', model: { provider: 'openai', id: 'gpt-5.1' } },
  };
  const agents = harness(async (agent, body, listeners) => {
    if (body.startsWith('You are the INTEGRATOR') && !agent.handed) {
      agent.handed = true;
      ask(listeners, 'hold-integrator');
      await holdIntegrator;
    }
    if (body.includes("The prosecutor's report:")) {
      ask(listeners, 'hold-repair');
      await holdRepair;
    }
    if (agent.sessionKey.endsWith(':prosecutor')) {
      if (!agent.guilty) {
        agent.guilty = true;
        await mkdir(join(agent.cwd, 'proofs'), { recursive: true });
        await writeFile(join(agent.cwd, 'proofs', 'ac.txt'), 'proof\n');
        return GUILTY;
      }
      return 'VERDICT: ACQUITTED';
    }
    if (agent.readOnly) {
      ask(listeners, 'hold-review');
      await holdReview;
      return PASS;
    }
    return 'OK';
  });
  const crew = createCrew({
    home, availableBackends: connected, openSession: agents.openSession, prosecutor: agents.prosecutor, pollMs: 20,
    execute: async args => {
      if (args.prompt.startsWith('You are the LEAD')) return JSON.stringify(lead([command]));
      await writeFile(join(args.cwd, 'product.txt'), 'product\n');
      return 'implemented';
    },
  });
  const run = crew.auto('owner', { request: 'Add product.txt', cwd: repo, backend: 'codex' }, 'flow-held-permission');
  await until(crew, run.id, ['awaiting_input']);
  await crew.action('owner', run.id, 'approve-criteria', { decisions: decisions([command]), models: picked });
  const heldIntegrator = await untilSaved(crew, run.id, current => current?.integrator?.history?.some(record => record.events?.some(event => event.requestId === 'hold-integrator')));
  assert.equal(heldIntegrator.integrator.history.at(-1).report, '');
  releaseIntegrator();
  const heldRepair = await untilSaved(crew, run.id, current => current?.integrator?.history?.some(record => record.events?.some(event => event.requestId === 'hold-repair')));
  assert.equal(heldRepair.integrator.history.find(record => record.events?.some(event => event.requestId === 'hold-repair')).report, '');
  releaseRepair();
  const heldReview = await untilSaved(crew, run.id, current => current?.reviewTranscripts?.some(record => record.events?.some(event => event.requestId === 'hold-review')));
  assert.equal(heldReview.reviewTranscripts.at(-1).report, '');
  releaseReview();
  const done = await until(crew, run.id, ['done', 'blocked'], 8000);
  assert.equal(done.status, 'done', JSON.stringify({ phase: done.phase, error: done.error }));
  const approved = done.events.find(event => event.kind === 'criteria_approved');
  assert.match(approved.text, /builder codex openai\/gpt-5\.1/);
  assert.match(approved.text, /reviewer codex openai\/gpt-5\.1/);
});

test('seedCase restores the pending repair report and cap allowance', () => {
  const prosecutor = createProsecutor({
    poolFor: () => ({ stop() {}, get: () => ({}) }),
    publish() {},
    configFor: () => null,
  });
  const key = 'crew-seed-integrator';
  prosecutor.arm(key, { backend: 'codex', model: null, effort: 'high' });
  prosecutor.noteTask(key, 'Add product.txt', Promise.resolve({ ok: true, commit: 'abc' }));
  assert.equal(prosecutor.seedCase(key, {
    round: 6,
    lastReport: 'FINDING F1 | AC1 | the proof fails',
    capAt: 8,
    owned: ['proofs/ac.txt'],
    log: [{ round: 6, by: 'codex', report: 'FINDING F1 | AC1 | the proof fails' }],
    baselineCommit: 'abc',
    cap: true,
    redesign: 4,
  }), true);
  const armed = prosecutor.armed(key);
  assert.equal(armed.lastReport, 'FINDING F1 | AC1 | the proof fails');
  assert.equal(armed.capAt, 8);
  assert.equal(armed.round, 6);
  assert.equal(armed.paused.cap, true);
  assert.equal(armed.phase, 'paused');
  assert.deepEqual(armed.owned, ['proofs/ac.txt']);
  assert.equal(armed.redesign, 4);
  assert.equal(armed.baselineCommit, 'abc');
});

test('cap accept snapshots the capped round and marks it accepted-open', async t => {
  const { repo, home } = await fixture(t);
  const command = 'test -f product.txt';
  docSet('prosecutor-config', repo, { testPatterns: ['proofs/**'], commands: [command] }, home);
  const agents = harness(async (agent, _body, _listeners, prosecutor) => {
    if (agent.sessionKey.endsWith(':prosecutor')) {
      const armed = prosecutor.armed(agent.sessionKey.replace(/:prosecutor$/, ''));
      if (armed) armed.capAt = 1;
      await mkdir(join(agent.cwd, 'proofs'), { recursive: true });
      await writeFile(join(agent.cwd, 'proofs', 'ac.txt'), 'proof\ncapped-round\n');
      return GUILTY;
    }
    return 'OK';
  });
  const crew = createCrew({
    home, availableBackends: connected, openSession: agents.openSession, prosecutor: agents.prosecutor, pollMs: 20,
    execute: async args => {
      if (args.prompt.startsWith('You are the LEAD')) return JSON.stringify({ ...lead([command]), review: false, reviewWhy: 'Checks are enough.' });
      await writeFile(join(args.cwd, 'product.txt'), 'product\n');
      return 'implemented';
    },
  });
  const run = crew.auto('owner', { request: 'Add product.txt', cwd: repo, backend: 'codex' }, 'flow-cap-accept');
  await until(crew, run.id, ['awaiting_input']);
  await crew.action('owner', run.id, 'approve-criteria', { decisions: decisions([command], false), models });
  const waiting = await untilSaved(crew, run.id, current => current?.phase === 'prosecuting' && current?.status === 'awaiting_input' && current?.prosecution?.cap);
  const beforeDiff = await git(waiting.integration.path, ['diff', waiting.baseline, waiting.result]);
  assert.equal(beforeDiff.ok, true);
  assert.doesNotMatch(beforeDiff.out, /capped-round/);
  await crew.action('owner', run.id, 'prosecution-choice', { choice: 'accept' });
  const done = await until(crew, run.id, ['done', 'blocked'], 8000);
  assert.equal(done.status, 'done', JSON.stringify({ phase: done.phase, error: done.error, verification: done.prosecution?.verification }));
  assert.equal(done.prosecution.verification, 'accepted-open');
  assert.notEqual(done.result, waiting.result);
  const head = (await git(done.integration.path, ['rev-parse', 'HEAD'])).out;
  assert.notEqual(done.result, head);
  const afterDiff = await git(done.integration.path, ['diff', done.baseline, done.result]);
  assert.match(afterDiff.out, /capped-round/);
  assert.match(afterDiff.out, /proofs\/ac\.txt/);
});

test('a real cap keeps every owned test across restart, resume, and accept', async t => {
  const { repo, home } = await fixture(t);
  const command = 'test -f product.txt';
  docSet('prosecutor-config', repo, { testPatterns: ['proofs/**'], commands: [command] }, home);
  const agents = harness(async (agent, _body, _listeners, prosecutor) => {
    if (agent.sessionKey.endsWith(':prosecutor')) {
      const armed = prosecutor.armed(agent.sessionKey.replace(/:prosecutor$/, ''));
      if (armed) armed.capAt = 1;
      await mkdir(join(agent.cwd, 'proofs'), { recursive: true });
      await writeFile(join(agent.cwd, 'proofs', 'ac.txt'), 'proof\n');
      await writeFile(join(agent.cwd, 'proofs', 'edge.txt'), 'edge\n');
      return GUILTY;
    }
    return 'OK';
  });
  const crew = createCrew({
    home, availableBackends: connected, openSession: agents.openSession, prosecutor: agents.prosecutor, pollMs: 20,
    execute: async args => {
      if (args.prompt.startsWith('You are the LEAD')) return JSON.stringify({ ...lead([command]), review: false, reviewWhy: 'Checks are enough.' });
      await writeFile(join(args.cwd, 'product.txt'), 'product\n');
      return 'implemented';
    },
  });
  const run = crew.auto('owner', { request: 'Add product.txt', cwd: repo, backend: 'codex' }, 'flow-cap-restart');
  await until(crew, run.id, ['awaiting_input']);
  await crew.action('owner', run.id, 'approve-criteria', { decisions: decisions([command], false), models });
  const capped = await untilSaved(crew, run.id, current => current?.phase === 'prosecuting' && current?.status === 'awaiting_input' && current?.prosecution?.cap);
  assert.notEqual(capped.prosecution.pendingRepair, true);
  assert.equal(capped.integrator.boundaryCommit, capped.prosecution.baselineCommit);
  assert.ok(capped.prosecution.owned.includes('proofs/ac.txt'));
  assert.ok(capped.prosecution.owned.includes('proofs/edge.txt'));
  assert.equal(await readFile(join(capped.integration.path, 'proofs', 'ac.txt'), 'utf8'), 'proof\n');
  assert.equal(await readFile(join(capped.integration.path, 'proofs', 'edge.txt'), 'utf8'), 'edge\n');

  const next = harness(async () => 'OK');
  const recovered = createCrew({
    home, availableBackends: connected, openSession: next.openSession, prosecutor: next.prosecutor, pollMs: 20,
    execute: async () => 'replacement',
  });
  assert.equal(recovered.read(run.id).status, 'paused');
  await recovered.action('owner', run.id, 'resume');
  const waiting = await until(recovered, run.id, ['awaiting_input', 'blocked', 'done'], 8000);
  assert.equal(waiting.status, 'awaiting_input', JSON.stringify({ phase: waiting.phase, status: waiting.status, error: waiting.error }));
  assert.equal(waiting.phase, 'prosecuting');
  assert.doesNotMatch(waiting.events.map(event => event.text).join('\n'), /reverted prosecutor test edits/);
  assert.equal(await readFile(join(waiting.integration.path, 'proofs', 'ac.txt'), 'utf8'), 'proof\n');
  assert.equal(await readFile(join(waiting.integration.path, 'proofs', 'edge.txt'), 'utf8'), 'edge\n');
  await recovered.action('owner', run.id, 'prosecution-choice', { choice: 'accept' });
  const done = await until(recovered, run.id, ['done', 'blocked'], 8000);
  assert.equal(done.status, 'done', JSON.stringify({ phase: done.phase, error: done.error, verification: done.prosecution?.verification }));
  assert.equal(done.prosecution.verification, 'accepted-open');
  assert.equal(await readFile(join(done.integration.path, 'proofs', 'ac.txt'), 'utf8'), 'proof\n');
  assert.equal(await readFile(join(done.integration.path, 'proofs', 'edge.txt'), 'utf8'), 'edge\n');
  const exported = await git(done.integration.path, ['diff', done.baseline, done.result]);
  assert.match(exported.out, /proofs\/ac\.txt/);
  assert.match(exported.out, /proofs\/edge\.txt/);
  assert.match(exported.out, /\n\+proof\n/);
  assert.match(exported.out, /\n\+edge(?:\n|$)/);
});

test('continue after the cap rebinds the driver and keeps the failing report', async t => {
  const { repo, home } = await fixture(t);
  const command = 'test -f product.txt';
  docSet('prosecutor-config', repo, { testPatterns: ['proofs/**'], commands: [command] }, home);
  const agents = harness(async (agent, body, _listeners, prosecutor) => {
    if (agent.sessionKey.endsWith(':prosecutor')) {
      if (!agent.guilty) {
        agent.guilty = true;
        const armed = prosecutor.armed(agent.sessionKey.replace(/:prosecutor$/, ''));
        if (armed) armed.capAt = 1;
        await mkdir(join(agent.cwd, 'proofs'), { recursive: true });
        await writeFile(join(agent.cwd, 'proofs', 'ac.txt'), 'proof\n');
        return GUILTY;
      }
      return 'VERDICT: ACQUITTED';
    }
    if (body.includes("The prosecutor's report:")) return 'FIXED';
    return 'OK';
  });
  const crew = createCrew({
    home, availableBackends: connected, openSession: agents.openSession, prosecutor: agents.prosecutor, pollMs: 20,
    execute: async args => {
      if (args.prompt.startsWith('You are the LEAD')) return JSON.stringify({ ...lead([command]), review: false, reviewWhy: 'Checks are enough.' });
      await writeFile(join(args.cwd, 'product.txt'), 'product\n');
      return 'implemented';
    },
  });
  const run = crew.auto('owner', { request: 'Add product.txt', cwd: repo, backend: 'codex' }, 'flow-cap-continue');
  await until(crew, run.id, ['awaiting_input']);
  await crew.action('owner', run.id, 'approve-criteria', { decisions: decisions([command], false), models });
  await untilSaved(crew, run.id, current => current?.phase === 'prosecuting' && current?.status === 'awaiting_input' && current?.prosecution?.cap);
  await crew.action('owner', run.id, 'prosecution-choice', { choice: 'continue' });
  const done = await until(crew, run.id, ['done', 'blocked'], 8000);
  assert.equal(done.status, 'done', JSON.stringify({ phase: done.phase, error: done.error }));
  assert.doesNotMatch(done.error || '', /Crew interrupted/);
  const integrator = [...agents.agents.values()].find(agent => agent.sessionKey.includes('-integrator') && !agent.sessionKey.endsWith(':prosecutor'));
  const repair = integrator.prompts.find(prompt => prompt.includes("The prosecutor's report:"));
  assert.match(repair, /the proof fails/);
});

test('a restored cap keeps the report and allowance, and redesign can continue', async t => {
  const { repo, home } = await fixture(t);
  const command = 'test -f product.txt';
  docSet('prosecutor-config', repo, { testPatterns: ['proofs/**'], commands: [command] }, home);
  let releaseRepair = () => {};
  const repairHung = new Promise(resolve => { releaseRepair = resolve; });
  const firstAgents = harness(async (agent, body) => {
    if (body.includes("The prosecutor's report:")) {
      await writeFile(join(agent.cwd, 'partial.txt'), 'partial\n');
      await repairHung;
      return 'FIXED';
    }
    if (agent.sessionKey.endsWith(':prosecutor')) {
      if (!agent.guilty) {
        agent.guilty = true;
        await mkdir(join(agent.cwd, 'proofs'), { recursive: true });
        await writeFile(join(agent.cwd, 'proofs', 'ac.txt'), 'proof\n');
        return GUILTY;
      }
      return 'VERDICT: ACQUITTED';
    }
    return 'OK';
  });
  const crew = createCrew({
    home, availableBackends: connected, openSession: firstAgents.openSession, prosecutor: firstAgents.prosecutor, pollMs: 20,
    execute: async args => {
      if (args.prompt.startsWith('You are the LEAD')) return JSON.stringify({ ...lead([command]), review: false, reviewWhy: 'Checks are enough.' });
      await writeFile(join(args.cwd, 'product.txt'), 'product\n');
      return 'implemented';
    },
  });
  const run = crew.auto('owner', { request: 'Add product.txt', cwd: repo, backend: 'codex' }, 'flow-cap-restore');
  await until(crew, run.id, ['awaiting_input']);
  await crew.action('owner', run.id, 'approve-criteria', { decisions: decisions([command], false), models });
  let checkpoint = null;
  for (let i = 0; i < 8000 && !checkpoint; i++) {
    const current = crew.read(run.id);
    if (current?.status === 'blocked' || current?.status === 'done') assert.fail(JSON.stringify({ status: current.status, error: current.error }));
    const partial = current?.integration?.path
      ? await readFile(join(current.integration.path, 'partial.txt'), 'utf8').then(text => text === 'partial\n', () => false)
      : false;
    if (current?.prosecution?.owned?.includes('proofs/ac.txt') && current.prosecution.baselineCommit && /the proof fails/.test(current.prosecution.lastReport || '') && partial) checkpoint = current;
    else await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(checkpoint, 'the pending report was not checkpointed before the repair');
  const stopped = await crew.action('owner', run.id, 'stop');
  assert.equal(stopped.status, 'stopped');
  releaseRepair();
  await new Promise(resolve => setTimeout(resolve, 30));
  const saved = crew.read(run.id);
  saved.status = 'awaiting_input';
  saved.phase = 'prosecuting';
  saved.prosecution = { ...saved.prosecution, cap: true, capAt: 8 };
  docSet('crew', run.id, saved, home);

  let seen = null;
  let repair = '';
  const nextAgents = harness(async (agent, body, _listeners, prosecutor) => {
    if (body.startsWith('You are the INTEGRATOR')) {
      const armed = prosecutor.armed(agent.sessionKey);
      seen = {
        capAt: armed?.capAt,
        report: armed?.lastReport || '',
        partial: await readFile(join(agent.cwd, 'partial.txt'), 'utf8').then(() => true, () => false),
        proof: await readFile(join(agent.cwd, 'proofs', 'ac.txt'), 'utf8').catch(() => ''),
      };
      return 'OK';
    }
    if (body.includes("The prosecutor's report:")) {
      repair = body;
      return 'FIXED';
    }
    if (agent.sessionKey.endsWith(':prosecutor')) return 'VERDICT: ACQUITTED';
    return 'OK';
  });
  const recovered = createCrew({
    home, availableBackends: connected, openSession: nextAgents.openSession, prosecutor: nextAgents.prosecutor, pollMs: 20,
    execute: async () => 'replacement',
  });
  assert.equal(recovered.read(run.id).status, 'paused');
  await recovered.action('owner', run.id, 'resume');
  const waiting = await until(recovered, run.id, ['awaiting_input', 'blocked', 'done'], 8000);
  assert.equal(waiting.status, 'awaiting_input', JSON.stringify({ phase: waiting.phase, error: waiting.error }));
  assert.equal(seen?.capAt, 8);
  assert.match(seen?.report || '', /the proof fails/);
  assert.equal(seen?.partial, false);
  assert.equal(seen?.proof, 'proof\n');
  assert.match(waiting.events.map(event => event.text).join('\n'), /restored the interrupted repair boundary: partial\.txt/);
  await recovered.action('owner', run.id, 'prosecution-choice', { choice: 'redesign' });
  const done = await until(recovered, run.id, ['done', 'blocked'], 8000);
  assert.equal(done.status, 'done', JSON.stringify({ phase: done.phase, error: done.error }));
  assert.doesNotMatch(done.error || '', /Crew interrupted/);
  assert.match(repair, /the proof fails/);
  assert.match(repair, /source of truth/);
});

test('acceptance checks that edit the tree are reverted and do not verify', async t => {
  const { repo, home } = await fixture(t);
  const flag = join(home, 'mutate-flag');
  const command = `test -f product.txt && { test ! -f '${flag}' || echo mutated >> product.txt; }`;
  docSet('prosecutor-config', repo, { commands: [command] }, home);
  const agents = harness(async (agent) => {
    if (agent.sessionKey.endsWith(':prosecutor')) {
      await writeFile(flag, '1\n');
      return 'VERDICT: ACQUITTED';
    }
    return 'OK';
  });
  const crew = createCrew({
    home, availableBackends: connected, openSession: agents.openSession, prosecutor: agents.prosecutor, pollMs: 20,
    execute: async args => {
      if (args.prompt.startsWith('You are the LEAD')) return JSON.stringify({ ...lead([command]), review: false, reviewWhy: 'Checks are enough.' });
      await writeFile(join(args.cwd, 'product.txt'), 'product\n');
      return 'implemented';
    },
  });
  const run = crew.auto('owner', { request: 'Add product.txt', cwd: repo, backend: 'codex' }, 'flow-gate-mutation');
  await until(crew, run.id, ['awaiting_input']);
  await crew.action('owner', run.id, 'approve-criteria', { decisions: decisions([command], false), models });
  const blocked = await until(crew, run.id, ['blocked', 'done'], 8000);
  assert.equal(blocked.status, 'blocked', JSON.stringify({ phase: blocked.phase, error: blocked.error, prosecution: blocked.prosecution?.status }));
  assert.match(blocked.error, /Acceptance checks changed the worktree/);
  assert.equal(await readFile(join(blocked.integration.path, 'product.txt'), 'utf8'), 'product\n');
  assert.notEqual(blocked.prosecution?.status, 'verified');
});

test('a failed executor repair does not start another prosecutor round', async t => {
  const { repo, home } = await fixture(t);
  const command = 'test -f product.txt';
  docSet('prosecutor-config', repo, { testPatterns: ['proofs/**'], commands: [command] }, home);
  const agents = harness(async (agent, body) => {
    if (body.includes("The prosecutor's report:")) return { text: '', stopReason: 'failed', errorMessage: 'quota' };
    if (agent.sessionKey.endsWith(':prosecutor')) {
      if (!agent.guilty) {
        agent.guilty = true;
        await mkdir(join(agent.cwd, 'proofs'), { recursive: true });
        await writeFile(join(agent.cwd, 'proofs', 'ac.txt'), 'proof\n');
        return GUILTY;
      }
      return 'VERDICT: ACQUITTED';
    }
    return 'OK';
  });
  const crew = createCrew({
    home, availableBackends: connected, openSession: agents.openSession, prosecutor: agents.prosecutor, pollMs: 20,
    execute: async args => {
      if (args.prompt.startsWith('You are the LEAD')) return JSON.stringify({ ...lead([command]), review: false, reviewWhy: 'Checks are enough.' });
      await writeFile(join(args.cwd, 'product.txt'), 'product\n');
      return 'implemented';
    },
  });
  const run = crew.auto('owner', { request: 'Add product.txt', cwd: repo, backend: 'codex' }, 'flow-quota-repair');
  await until(crew, run.id, ['awaiting_input']);
  await crew.action('owner', run.id, 'approve-criteria', { decisions: decisions([command], false), models });
  const blocked = await until(crew, run.id, ['blocked', 'done'], 8000);
  assert.equal(blocked.status, 'blocked', JSON.stringify({ phase: blocked.phase, error: blocked.error }));
  assert.match(blocked.error, /quota/);
  const prosecutor = [...agents.agents.values()].filter(agent => agent.sessionKey.endsWith(':prosecutor'));
  assert.equal(prosecutor.length, 1);
  assert.equal(prosecutor[0].prompts.length, 1);
});

test('a thrown integrator turn reverts edits outside scope before resume', async t => {
  const { crew, run, blocked } = await outsideEditRun(t, 'flow-outside-throw');
  assert.equal(blocked.status, 'blocked', JSON.stringify({ phase: blocked.phase, error: blocked.error }));
  assert.match(blocked.error, /integrator exploded/);
  assert.match(blocked.events.map(event => event.text).join('\n'), /reverted edits outside worker scope: evil\.txt/);
  await assert.rejects(access(join(blocked.integration.path, 'evil.txt')));
  assert.match(blocked.events.find(event => event.kind === 'criteria_approved').text, /builder codex openai\/gpt-5\.1/);
  const workers = blocked.events.find(event => event.kind === 'split_approved').detail.workers;
  assert.deepEqual(workers.map(worker => worker.id), ['W1', 'W2']);
  assert.equal(workers[0].model.id, 'gpt-5.1');
  await crew.action('owner', run.id, 'resume');
  const done = await until(crew, run.id, ['done', 'blocked'], 8000);
  assert.equal(done.status, 'done', JSON.stringify({ phase: done.phase, error: done.error }));
  await assert.rejects(access(join(done.integration.path, 'evil.txt')));
  const diff = await git(done.integration.path, ['diff', done.baseline, done.result]);
  assert.doesNotMatch(diff.out, /evil\.txt/);
});

test('stop cancels a resume that was already queued', async t => {
  const { crew, run, blocked, agents } = await outsideEditRun(t, 'flow-queued-stop');
  assert.equal(blocked.status, 'blocked');
  const integrator = [...agents.agents.values()].find(agent => agent.sessionKey.includes('-integrator'));
  const before = integrator.prompts.length;
  const stopped = await Promise.all([
    crew.action('owner', run.id, 'resume'),
    crew.action('owner', run.id, 'stop'),
  ]).then(([, result]) => result);
  assert.equal(stopped.status, 'stopped');
  assert.equal(crew.read(run.id).status, 'stopped');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(crew.read(run.id).status, 'stopped');
  assert.equal(integrator.prompts.length, before);
});

test('stop during accept-review does not mark the run done', async t => {
  const { repo, home } = await fixture(t);
  await mkdir(home);
  await writeFile(join(repo, 'more.txt'), 'more\n');
  assert.equal((await git(repo, ['add', '.'])).ok, true);
  assert.equal((await git(repo, ['commit', '-m', 'more'])).ok, true);
  const script = join(home, 'slow-diff');
  await writeFile(script, '#!/bin/sh\nsleep 2\nexit 0\n');
  await chmod(script, 0o755);
  assert.equal((await git(repo, ['config', 'diff.external', script])).ok, true);
  const head = (await git(repo, ['rev-parse', 'HEAD'])).out;
  const parent = (await git(repo, ['rev-parse', 'HEAD^'])).out;
  docSet('crew', 'accept-stop', {
    id: 'accept-stop', owner: 'owner', autonomous: true,
    request: 'Add more', cwd: repo, baseline: parent, result: head,
    phase: 'review_gate', status: 'awaiting_input',
    integration: { path: repo },
    gate: { configured: true, ok: true },
    reviews: [{ pass: 1, findings: [{ id: 'R1', severity: 'blocker', text: 'missing' }], verdict: 'FAIL' }],
    criteria: [{ id: 'AC1', text: 'more exists' }],
    tasks: [], events: [],
  }, home);
  const crew = createCrew({ home, execute: async () => 'unused' });
  const accepting = crew.action('owner', 'accept-stop', 'accept-review');
  await new Promise(resolve => setTimeout(resolve, 150));
  const stopped = await crew.action('owner', 'accept-stop', 'stop');
  assert.equal(stopped.status, 'stopped');
  const settled = await accepting;
  assert.equal(settled.status, 'stopped');
  assert.equal(crew.read('accept-stop').status, 'stopped');
  assert.equal(crew.read('accept-stop').phase, 'review_gate');
});

test('a cancelled crew round does not start the prosecutor', async t => {
  const { repo } = await fixture(t);
  let started = 0;
  let prompted = 0;
  let release = () => {};
  const hung = new Promise(resolve => { release = resolve; });
  const agent = {
    isAlive() { return false; },
    async start() { started += 1; return { ok: true }; },
    async prompt() { prompted += 1; return { ok: true }; },
    onEvent() { return () => {}; },
    setThinkingLevel() {},
  };
  const prosecutor = createProsecutor({
    poolFor: () => ({ stop() {}, get: () => agent }),
    publish() {},
    configFor: () => null,
  });
  const key = 'crew-round-cancel-integrator';
  const abort = new AbortController();
  prosecutor.arm(key, { backend: 'codex', model: null, effort: 'high' });
  prosecutor.bindCrew(key, {
    checkAbort: abort,
    config: { commands: ['true'], testPatterns: [] },
    crewGate: async () => true,
  });
  const head = (await git(repo, ['rev-parse', 'HEAD'])).out;
  prosecutor.noteTask(key, 'Add product.txt\n1. AC1: product.txt exists', Promise.resolve({ ok: true, commit: head }));
  prosecutor.onExecutorEvent(key, { type: 'agent_end' }, {
    cwd: repo,
    getMessages() { return hung; },
    prompt() { return { ok: true }; },
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  const pending = prosecutor.cancelChecks(key);
  prosecutor.disarm(key);
  release();
  await pending;
  assert.equal(started, 0);
  assert.equal(prompted, 0);
});

test('stop settles an acknowledged prosecutor turn without a completion event', async t => {
  const { repo } = await fixture(t);
  let prompted = 0;
  const agent = {
    isAlive() { return true; },
    async prompt() { prompted += 1; return { ok: true }; },
    onEvent() { return () => {}; },
    setThinkingLevel() {},
  };
  const prosecutor = createProsecutor({
    poolFor: () => ({ stop() {}, get: () => agent }),
    publish() {},
    configFor: () => null,
  });
  const key = 'crew-round-ack-integrator';
  const abort = new AbortController();
  prosecutor.arm(key, { backend: 'codex', model: null, effort: 'high' });
  prosecutor.bindCrew(key, {
    checkAbort: abort,
    config: { commands: ['true'], testPatterns: [] },
    crewGate: async () => true,
  });
  const head = (await git(repo, ['rev-parse', 'HEAD'])).out;
  prosecutor.noteTask(key, 'Add product.txt\n1. AC1: product.txt exists', Promise.resolve({ ok: true, commit: head }));
  prosecutor.onExecutorEvent(key, { type: 'agent_end' }, { cwd: repo, prompt() { return { ok: true }; } });
  for (let i = 0; i < 200 && prompted === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(prompted, 1);
  const pending = prosecutor.cancelChecks(key);
  prosecutor.disarm(key);
  const winner = await Promise.race([
    pending.then(() => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 1000)),
  ]);
  assert.equal(winner, 'settled');
});

test('stop settles a prosecutor start that never finishes', async t => {
  const { repo } = await fixture(t);
  let started = 0;
  const agent = {
    isAlive() { return false; },
    start() { started += 1; return new Promise(() => {}); },
    async prompt() { throw new Error('prompt should not run'); },
    onEvent() { return () => {}; },
    getMessages() { return []; },
    setThinkingLevel() {},
  };
  const prosecutor = createProsecutor({
    poolFor: () => ({ stop() {}, get: () => agent }),
    publish() {},
    configFor: () => null,
  });
  const key = 'crew-round-start-integrator';
  const abort = new AbortController();
  prosecutor.arm(key, { backend: 'codex', model: null, effort: 'high' });
  prosecutor.bindCrew(key, {
    checkAbort: abort,
    config: { commands: ['true'], testPatterns: [] },
    crewGate: async () => true,
  });
  const head = (await git(repo, ['rev-parse', 'HEAD'])).out;
  prosecutor.noteTask(key, 'Add product.txt\n1. AC1: product.txt exists', Promise.resolve({ ok: true, commit: head }));
  prosecutor.onExecutorEvent(key, { type: 'agent_end' }, { cwd: repo, getMessages() { return []; }, prompt() { return { ok: true }; } });
  for (let i = 0; i < 200 && started === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(started, 1);
  const pending = prosecutor.cancelChecks(key);
  prosecutor.disarm(key);
  const winner = await Promise.race([
    pending.then(() => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 1000)),
  ]);
  assert.equal(winner, 'settled');
});

/** Cap while the run is still `running`, before the poll sets awaiting_input. */
async function capCheckpointRun(t, id) {
  const { repo, home } = await fixture(t);
  const command = 'test -f product.txt';
  docSet('prosecutor-config', repo, { testPatterns: ['proofs/**'], commands: [command] }, home);
  let previousBoundary = null;
  const agents = harness(async (agent, _body, _listeners, prosecutor) => {
    if (agent.sessionKey.endsWith(':prosecutor')) {
      // The round starts from the integrator's agent_end and is not awaited.
      // Hold the verdict so the crew poll is already asleep when the cap saves.
      await new Promise(resolve => setTimeout(resolve, 500));
      const armed = prosecutor.armed(agent.sessionKey.replace(/:prosecutor$/, ''));
      if (armed) armed.capAt = 1;
      await mkdir(join(agent.cwd, 'proofs'), { recursive: true });
      await writeFile(join(agent.cwd, 'proofs', 'ac.txt'), 'proof\n');
      await writeFile(join(agent.cwd, 'proofs', 'edge.txt'), 'edge\n');
      return GUILTY;
    }
    return 'OK';
  });
  const crew = createCrew({
    home, availableBackends: connected, openSession: agents.openSession, prosecutor: agents.prosecutor, pollMs: 60000,
    execute: async args => {
      if (args.prompt.startsWith('You are the LEAD')) return JSON.stringify({ ...lead([command]), review: false, reviewWhy: 'Checks are enough.' });
      await writeFile(join(args.cwd, 'product.txt'), 'product\n');
      return 'implemented';
    },
  });
  const run = crew.auto('owner', { request: 'Add product.txt', cwd: repo, backend: 'codex' }, id);
  await until(crew, run.id, ['awaiting_input']);
  await crew.action('owner', run.id, 'approve-criteria', { decisions: decisions([command], false), models });
  let checkpoint = null;
  for (let i = 0; i < 4000 && !checkpoint; i++) {
    const current = crew.read(run.id);
    if (current?.status === 'blocked' || current?.status === 'done') assert.fail(JSON.stringify({ status: current.status, phase: current.phase, error: current.error }));
    if (current?.status === 'awaiting_input' && current.phase === 'prosecuting') assert.fail('poll left the cap checkpoint window');
    if (current?.integrator?.boundaryCommit && !current.prosecution?.cap) previousBoundary = current.integrator.boundaryCommit;
    const ready = current?.status === 'running'
      && current.phase === 'prosecuting'
      && current.prosecution?.cap
      && current.prosecution.pendingRepair !== true
      && current.prosecution.baselineCommit
      && current.integrator?.boundaryCommit === current.prosecution.baselineCommit;
    if (ready) checkpoint = current;
    else await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(checkpoint, JSON.stringify(crew.read(run.id)));
  assert.ok(previousBoundary);
  assert.notEqual(previousBoundary, checkpoint.prosecution.baselineCommit);
  assert.ok(checkpoint.prosecution.owned.includes('proofs/ac.txt'));
  assert.ok(checkpoint.prosecution.owned.includes('proofs/edge.txt'));
  assert.equal(await readFile(join(checkpoint.integration.path, 'proofs', 'ac.txt'), 'utf8'), 'proof\n');
  assert.equal(await readFile(join(checkpoint.integration.path, 'proofs', 'edge.txt'), 'utf8'), 'edge\n');
  await crew.action('owner', run.id, 'stop');
  checkpoint.status = 'running';
  checkpoint.error = '';
  return { home, id: run.id, checkpoint, previousBoundary };
}

async function resumeEditedCap(found) {
  docSet('crew', found.id, found.checkpoint, found.home);
  const next = harness(async () => 'OK');
  const recovered = createCrew({
    home: found.home, availableBackends: connected, openSession: next.openSession, prosecutor: next.prosecutor, pollMs: 20,
    execute: async () => 'replacement',
  });
  assert.equal(recovered.read(found.id).status, 'paused');
  const path = found.checkpoint.integration.path;
  await writeFile(join(path, 'proofs', 'edge.txt'), 'tampered\n');
  await recovered.action('owner', found.id, 'resume');
  const waiting = await until(recovered, found.id, ['awaiting_input', 'blocked', 'done'], 8000);
  assert.equal(waiting.status, 'awaiting_input', JSON.stringify({ phase: waiting.phase, status: waiting.status, error: waiting.error }));
  assert.equal(waiting.phase, 'prosecuting');
  assert.equal(await readFile(join(path, 'proofs', 'ac.txt'), 'utf8'), 'proof\n');
  assert.equal(await readFile(join(path, 'proofs', 'edge.txt'), 'utf8'), 'edge\n');
  await recovered.action('owner', found.id, 'prosecution-choice', { choice: 'accept' });
  const done = await until(recovered, found.id, ['done', 'blocked'], 8000);
  assert.equal(done.status, 'done', JSON.stringify({ phase: done.phase, error: done.error, verification: done.prosecution?.verification }));
  assert.equal(done.prosecution.verification, 'accepted-open');
  assert.equal(await readFile(join(path, 'proofs', 'ac.txt'), 'utf8'), 'proof\n');
  assert.equal(await readFile(join(path, 'proofs', 'edge.txt'), 'utf8'), 'edge\n');
  const exported = await git(path, ['diff', done.baseline, done.result]);
  assert.match(exported.out, /proofs\/ac\.txt/);
  assert.match(exported.out, /proofs\/edge\.txt/);
  assert.match(exported.out, /\n\+proof\n/);
  assert.match(exported.out, /\n\+edge(?:\n|$)/);
  assert.doesNotMatch(exported.out, /tampered/);
}

test('a cap checkpoint keeps both owned tests when one is edited before resume', async t => {
  const found = await capCheckpointRun(t, 'flow-cap-window');
  await resumeEditedCap(found);
});

test('resume adopts the cap snapshot when the boundary is still older and one owned test changed', async t => {
  const found = await capCheckpointRun(t, 'flow-cap-stranded');
  found.checkpoint.integrator.boundaryCommit = found.previousBoundary;
  await resumeEditedCap(found);
});

async function exitWithEdits(t, { failTurn }) {
  const { repo } = await fixture(t);
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(join(repo, 'proofs'), { recursive: true });
  let prompted = 0;
  let checkpoint = null;
  const agent = {
    isAlive() { return true; },
    async prompt() {
      await writeFile(join(repo, 'src', 'evil.js'), 'evil\n');
      await writeFile(join(repo, 'proofs', 'kept.txt'), 'kept\n');
      prompted += 1;
      if (failTurn) return { ok: false, error: 'quota' };
      return { ok: true };
    },
    onEvent() { return () => {}; },
    setThinkingLevel() {},
  };
  const prosecutor = createProsecutor({
    poolFor: () => ({ stop() {}, get: () => agent }),
    publish() {},
    configFor: () => null,
  });
  const key = failTurn ? 'crew-round-fail-edit' : 'crew-round-cancel-edit';
  const abort = new AbortController();
  prosecutor.arm(key, { backend: 'codex', model: null, effort: 'high' });
  prosecutor.bindCrew(key, {
    checkAbort: abort,
    config: { commands: ['true'], testPatterns: ['proofs/**'] },
    crewGate: async () => true,
    onCheckpoint(current) { checkpoint = [...(current.owned || [])]; },
  });
  const head = (await git(repo, ['rev-parse', 'HEAD'])).out;
  prosecutor.noteTask(key, 'Add product.txt\n1. AC1: product.txt exists', Promise.resolve({ ok: true, commit: head }));
  prosecutor.onExecutorEvent(key, { type: 'agent_end' }, { cwd: repo, prompt() { return { ok: true }; } });
  const early = prosecutor.pendingWork(key);
  for (let i = 0; i < 200 && prompted === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(prompted, 1);
  const pending = failTurn ? early : prosecutor.cancelChecks(key);
  const winner = await Promise.race([
    pending.then(() => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 1000)),
  ]);
  assert.equal(winner, 'settled');
  await assert.rejects(access(join(repo, 'src', 'evil.js')));
  assert.equal(await readFile(join(repo, 'proofs', 'kept.txt'), 'utf8'), 'kept\n');
  const armed = prosecutor.armed(key);
  assert.ok(armed);
  assert.ok(armed.owned.includes('proofs/kept.txt'));
  assert.equal(armed.owned.includes('src/evil.js'), false);
  assert.ok(checkpoint?.includes('proofs/kept.txt'));
  assert.equal(checkpoint.includes('src/evil.js'), false);
  const reason = prosecutor.state(key).paused?.reason || '';
  assert.match(reason, failTurn ? /quota/ : /Crew interrupted/);
  prosecutor.disarm(key);
}

test('a cancelled crew round reverts source edits and keeps the new test', async t => {
  await exitWithEdits(t, { failTurn: false });
});

test('a failed prosecutor turn reverts source edits and keeps the new test', async t => {
  await exitWithEdits(t, { failTurn: true });
});

async function retainedAfterRestart(t, { cancel, breach = false, noverdict = false }) {
  const { repo, home } = await fixture(t);
  const command = 'test -f product.txt';
  docSet('prosecutor-config', repo, { testPatterns: ['proofs/**'], commands: [command] }, home);
  let openGate = () => {};
  const gate = new Promise(resolve => { openGate = resolve; });
  t.after(() => openGate());
  const id = cancel ? 'flow-cancel-resume-tests' : breach ? 'flow-breach-resume-tests' : noverdict ? 'flow-noverdict-resume-tests' : 'flow-fail-resume-tests';
  const agents = harness(async (agent) => {
    if (!agent.sessionKey.endsWith(':prosecutor')) return 'OK';
    await mkdir(join(agent.cwd, 'proofs'), { recursive: true });
    await mkdir(join(agent.cwd, 'src'), { recursive: true });
    await writeFile(join(agent.cwd, 'proofs', 'kept.txt'), 'kept\n');
    await writeFile(join(agent.cwd, 'src', 'evil.js'), 'evil\n');
    if (cancel) await gate;
    // noverdict: no verdict line even when asked again -> inconclusive close.
    if (noverdict) {
      await rm(join(agent.cwd, 'src', 'evil.js'), { force: true });
      return 'still looking';
    }
    // breach: a normal, successful turn whose verdict passes, but that also
    // edited a source file. The boundary voids the round.
    return cancel || breach
      ? 'VERDICT: ACQUITTED'
      : { text: '', stopReason: 'failed', errorMessage: 'quota' };
  });
  const crew = createCrew({
    home, availableBackends: connected, openSession: agents.openSession, prosecutor: agents.prosecutor, pollMs: 20,
    execute: async args => {
      if (args.prompt.startsWith('You are the LEAD')) return JSON.stringify({ ...lead([command]), review: false, reviewWhy: 'Checks are enough.' });
      await writeFile(join(args.cwd, 'product.txt'), 'product\n');
      return 'implemented';
    },
  });
  const run = crew.auto('owner', { request: 'Add product.txt', cwd: repo, backend: 'codex' }, id);
  await until(crew, run.id, ['awaiting_input']);
  await crew.action('owner', run.id, 'approve-criteria', { decisions: decisions([command], false), models });
  let settled;
  if (cancel) {
    let saw = false;
    for (let i = 0; i < 8000 && !saw; i++) {
      const current = crew.read(run.id);
      if (current?.status === 'blocked' || current?.status === 'done') assert.fail(JSON.stringify({ status: current.status, phase: current.phase, error: current.error }));
      const work = current?.integration?.path;
      if (work) {
        try { await access(join(work, 'proofs', 'kept.txt')); saw = true; break; } catch { /* prosecutor has not written yet */ }
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(saw, JSON.stringify(crew.read(run.id)));
    await crew.action('owner', run.id, 'stop');
    openGate();
    settled = crew.read(run.id);
  } else {
    settled = await until(crew, run.id, ['blocked', 'done'], 8000);
  }
  assert.equal(settled.status, cancel ? 'stopped' : 'blocked', JSON.stringify({ status: settled.status, phase: settled.phase, error: settled.error }));
  if (!cancel) assert.match(settled.error || '', breach ? /outside the test patterns/ : noverdict ? /inconclusive|verdict/i : /quota/);
  const path = settled.integration.path;
  await assert.rejects(access(join(path, 'src', 'evil.js')));
  assert.equal(await readFile(join(path, 'proofs', 'kept.txt'), 'utf8'), 'kept\n');
  assert.ok(settled.prosecution.owned.includes('proofs/kept.txt'));
  assert.equal(settled.prosecution.owned.includes('src/evil.js'), false);
  assert.notEqual(settled.prosecution.pendingRepair, true);
  assert.ok(settled.prosecution.baselineCommit);
  assert.equal(settled.integrator.boundaryCommit, settled.prosecution.baselineCommit);
  const keptAtBoundary = await git(path, ['show', `${settled.integrator.boundaryCommit}:proofs/kept.txt`]);
  assert.equal(keptAtBoundary.ok, true, keptAtBoundary.error);
  assert.equal(keptAtBoundary.out.trim(), 'kept');
  assert.equal((await git(path, ['cat-file', '-e', `${settled.integrator.boundaryCommit}:src/evil.js`])).ok, false);
  const next = harness(async (agent) => agent.sessionKey.endsWith(':prosecutor') ? 'VERDICT: ACQUITTED' : 'OK');
  const recovered = createCrew({
    home, availableBackends: connected, openSession: next.openSession, prosecutor: next.prosecutor, pollMs: 20,
    execute: async () => 'replacement',
  });
  assert.equal(recovered.read(run.id).status, cancel ? 'stopped' : 'blocked');
  await recovered.action('owner', run.id, 'resume');
  assert.equal(await readFile(join(path, 'proofs', 'kept.txt'), 'utf8'), 'kept\n');
  await assert.rejects(access(join(path, 'src', 'evil.js')));
  const after = await until(recovered, run.id, ['done', 'blocked', 'awaiting_input'], 8000);
  assert.equal(await readFile(join(path, 'proofs', 'kept.txt'), 'utf8'), 'kept\n');
  await assert.rejects(access(join(path, 'src', 'evil.js')));
  assert.notEqual(after.status, 'blocked', JSON.stringify({ phase: after.phase, status: after.status, error: after.error }));
}

test('cancellation then restart then Resume keeps the prosecutor test', async t => {
  await retainedAfterRestart(t, { cancel: true });
});

test('failure then restart then Resume keeps the prosecutor test', async t => {
  await retainedAfterRestart(t, { cancel: false });
});

test('a scope breach then restart then Resume keeps the prosecutor test', async t => {
  await retainedAfterRestart(t, { cancel: false, breach: true });
});

test('a no-verdict close then restart then Resume keeps the prosecutor test', async t => {
  await retainedAfterRestart(t, { cancel: false, noverdict: true });
});

test('an abort that settles only at process shutdown does not hang Stop and its write is reverted', async t => {
  const { repo } = await fixture(t);
  await mkdir(join(repo, 'src'), { recursive: true });
  let prompted = 0;
  let stopped = false;
  let shutdown = () => {};
  const exited = new Promise(resolve => { shutdown = resolve; });
  const listeners = new Set();
  const agent = {
    isAlive() { return true; },
    async prompt() { prompted += 1; return { ok: true }; },
    // Never settles by itself: only the process exit resolves it. A write
    // lands while Stop is waiting on the graceful abort.
    abort() {
      setTimeout(() => { writeFile(join(repo, 'src', 'late.js'), 'late\n').catch(() => {}); }, 10);
      return exited;
    },
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setThinkingLevel() {},
  };
  const pool = {
    stop() { stopped = true; shutdown(); },
    get() { return agent; },
  };
  const prosecutor = createProsecutor({ poolFor: () => pool, publish() {}, configFor: () => null, abortGraceMs: 80 });
  const key = 'crew-abort-shutdown';
  const abort = new AbortController();
  prosecutor.arm(key, { backend: 'codex', model: null, effort: 'high' });
  prosecutor.bindCrew(key, {
    checkAbort: abort,
    config: { commands: ['true'], testPatterns: ['proofs/**'] },
    crewGate: async () => true,
  });
  const head = (await git(repo, ['rev-parse', 'HEAD'])).out;
  prosecutor.noteTask(key, 'Add product.txt\n1. AC1: product.txt exists', Promise.resolve({ ok: true, commit: head }));
  prosecutor.onExecutorEvent(key, { type: 'agent_end' }, { cwd: repo, prompt() { return { ok: true }; } });
  for (let i = 0; i < 200 && prompted === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(prompted, 1);
  const pending = prosecutor.cancelChecks(key);
  const winner = await Promise.race([
    pending.then(() => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 2000)),
  ]);
  assert.equal(winner, 'settled');
  assert.equal(stopped, true);
  await assert.rejects(access(join(repo, 'src', 'late.js')));
  prosecutor.disarm(key);
});

test('an acknowledged abort that writes after a delay does not survive cleanup', async t => {
  const { repo } = await fixture(t);
  await mkdir(join(repo, 'src'), { recursive: true });
  let prompted = 0;
  let wrote = false;
  let stoppedEarly = false;
  let aborting = null;
  const listeners = new Set();
  const agent = {
    isAlive() { return true; },
    async prompt() {
      prompted += 1;
      return { ok: true };
    },
    abort() {
      if (aborting) return aborting;
      aborting = (async () => {
        await new Promise(resolve => setTimeout(resolve, 40));
        wrote = true;
        await writeFile(join(repo, 'src', 'late.js'), 'late\n');
      })();
      return aborting;
    },
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setThinkingLevel() {},
  };
  const pool = {
    stop() { if (!wrote) stoppedEarly = true; },
    get() { return agent; },
  };
  const prosecutor = createProsecutor({
    poolFor: () => pool,
    publish() {},
    configFor: () => null,
  });
  const key = 'crew-abort-late-write';
  const abort = new AbortController();
  prosecutor.arm(key, { backend: 'codex', model: null, effort: 'high' });
  prosecutor.bindCrew(key, {
    checkAbort: abort,
    config: { commands: ['true'], testPatterns: ['proofs/**'] },
    crewGate: async () => true,
  });
  const head = (await git(repo, ['rev-parse', 'HEAD'])).out;
  prosecutor.noteTask(key, 'Add product.txt\n1. AC1: product.txt exists', Promise.resolve({ ok: true, commit: head }));
  prosecutor.onExecutorEvent(key, { type: 'agent_end' }, { cwd: repo, prompt() { return { ok: true }; } });
  for (let i = 0; i < 200 && prompted === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(prompted, 1);
  assert.equal(listeners.size > 0, true);
  const pending = prosecutor.cancelChecks(key);
  const winner = await Promise.race([
    pending.then(() => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 1000)),
  ]);
  assert.equal(winner, 'settled');
  assert.equal(wrote, true);
  assert.equal(stoppedEarly, false);
  await assert.rejects(access(join(repo, 'src', 'late.js')));
  await new Promise(resolve => setTimeout(resolve, 80));
  await assert.rejects(access(join(repo, 'src', 'late.js')));
  prosecutor.disarm(key);
});

async function followupEdits(t, mode) {
  const { repo } = await fixture(t);
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(join(repo, 'proofs'), { recursive: true });
  const listeners = new Set();
  const prompts = [];
  let repairs = 0;
  const emit = (text) => {
    const message = { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'end_turn' };
    for (const fn of [...listeners]) fn({ type: 'message_end', message });
    for (const fn of [...listeners]) fn({ type: 'agent_end' });
  };
  const agent = {
    isAlive() { return true; },
    async prompt(text) {
      prompts.push(String(text));
      if (prompts.length === 1) {
        await writeFile(join(repo, 'proofs', 'kept.txt'), 'kept\n');
        emit('still looking');
        return { ok: true };
      }
      await writeFile(join(repo, 'src', 'evil.js'), 'evil\n');
      if (mode === 'fail') return { ok: false, error: 'quota' };
      if (mode === 'cancel') return { ok: true };
      emit('FINDING F1 | AC1 | breaks | proofs/kept.txt:1\nVERDICT: GUILTY');
      return { ok: true };
    },
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setThinkingLevel() {},
  };
  const prosecutor = createProsecutor({
    poolFor: () => ({ stop() {}, get: () => agent }),
    publish() {},
    configFor: () => null,
  });
  const key = `crew-followup-${mode}`;
  const abort = new AbortController();
  const checkpoints = [];
  prosecutor.arm(key, { backend: 'codex', model: null, effort: 'high' });
  prosecutor.bindCrew(key, {
    checkAbort: abort,
    config: { commands: ['true'], testPatterns: ['proofs/**'] },
    crewGate: async () => true,
    onCheckpoint: (c) => checkpoints.push({ baselineCommit: c.baselineCommit, owned: [...(c.owned || [])], adoptBoundary: c.adoptBoundary, pendingRepair: c.pendingRepair }),
  });
  const head = (await git(repo, ['rev-parse', 'HEAD'])).out;
  prosecutor.noteTask(key, 'Add product.txt\n1. AC1: product.txt exists', Promise.resolve({ ok: true, commit: head }));
  prosecutor.onExecutorEvent(key, { type: 'agent_end' }, { cwd: repo, prompt() { repairs += 1; return { ok: true }; } });
  const early = prosecutor.pendingWork(key);
  if (mode === 'cancel') {
    for (let i = 0; i < 200; i++) {
      try { await access(join(repo, 'src', 'evil.js')); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    await access(join(repo, 'src', 'evil.js'));
    const pending = prosecutor.cancelChecks(key);
    const winner = await Promise.race([
      pending.then(() => 'settled'),
      new Promise(resolve => setTimeout(() => resolve('hung'), 1000)),
    ]);
    assert.equal(winner, 'settled');
  } else {
    await early;
  }
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /did not end with a verdict line/);
  await assert.rejects(access(join(repo, 'src', 'evil.js')));
  assert.equal(await readFile(join(repo, 'proofs', 'kept.txt'), 'utf8'), 'kept\n');
  const state = prosecutor.state(key);
  assert.match(state.paused?.reason || '', /reverted, round void/);
  assert.notEqual(state.paused?.cap, true);
  assert.equal(repairs, 0);
  // The voided round still saved its kept test with a recovery boundary
  // that contains it, so a later Resume cannot delete it.
  const saved = checkpoints.at(-1);
  assert.ok(saved, 'exit cleanup published a checkpoint');
  assert.equal(saved.pendingRepair, false);
  assert.equal(saved.adoptBoundary, true);
  assert.ok(saved.owned.includes('proofs/kept.txt'));
  const kept = await git(repo, ['show', `${saved.baselineCommit}:proofs/kept.txt`]);
  assert.equal(kept.ok, true, kept.error);
  assert.equal((await git(repo, ['cat-file', '-e', `${saved.baselineCommit}:src/evil.js`])).ok, false);
  prosecutor.disarm(key);
}

test('a verdict follow-up that edits a non-test file is reverted', async t => {
  await followupEdits(t, 'success');
});

test('a failed verdict follow-up that edits a non-test file is reverted', async t => {
  await followupEdits(t, 'fail');
});

test('a cancelled verdict follow-up that edits a non-test file is reverted', async t => {
  await followupEdits(t, 'cancel');
});

async function terminalClose(t, mode) {
  const { repo } = await fixture(t);
  await mkdir(join(repo, 'proofs'), { recursive: true });
  const listeners = new Set();
  const events = [];
  const emit = (text) => {
    const message = { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'end_turn' };
    for (const fn of [...listeners]) fn({ type: 'message_end', message });
    for (const fn of [...listeners]) fn({ type: 'agent_end' });
  };
  const agent = {
    isAlive() { return true; },
    async prompt() {
      await writeFile(join(repo, 'proofs', 'kept.txt'), 'kept\n');
      setTimeout(() => emit(mode === 'noverdict' ? 'still looking' : 'VERDICT: ACQUITTED'), 0);
      return { ok: true };
    },
    // Slow exit cleanup: the crew poll gets time to see a premature status.
    abort() { return new Promise(resolve => setTimeout(resolve, 60)); },
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setThinkingLevel() {},
  };
  const prosecutor = createProsecutor({
    poolFor: () => ({ stop() {}, get: () => agent }),
    publish() {},
    configFor: () => null,
  });
  const key = `crew-close-${mode}`;
  prosecutor.arm(key, { backend: 'codex', model: null, effort: 'high' });
  prosecutor.bindCrew(key, {
    checkAbort: new AbortController(),
    // cleanupFails: the gate edits the tree and also makes git's object store
    // read-only, so the exit cleanup cannot save its snapshot.
    config: { commands: mode === 'unconfigured' ? [] : mode === 'mutating' ? ['touch gate-made.txt'] : mode === 'cleanupFails' ? ['touch gate-made.txt && chmod -R a-w .git/objects'] : ['true'], testPatterns: ['proofs/**'] },
    crewGate: async () => true,
    onCheckpoint: (c) => events.push({ kind: 'checkpoint', baselineCommit: c.baselineCommit, owned: [...(c.owned || [])], adoptBoundary: c.adoptBoundary }),
  });
  const head = (await git(repo, ['rev-parse', 'HEAD'])).out;
  prosecutor.noteTask(key, 'Add product.txt\n1. AC1: product.txt exists', Promise.resolve({ ok: true, commit: head }));
  // The crew poll, with production's predicate (crew.js waitProsecution):
  // inconclusive, stopped, or any non-cap pause ends the wait and the crew
  // disarms the case at once.
  let seen = '';
  const poll = setInterval(() => {
    const state = prosecutor.state(key);
    const status = state?.status;
    const ended = status === 'inconclusive' || status === 'stopped' || (state?.paused && !state.paused.cap);
    if (!seen && ended) {
      seen = status || 'paused';
      events.push({ kind: 'terminal', status, reason: state?.paused?.reason || '' });
      prosecutor.disarm(key);
    }
  }, 2);
  t.after(() => clearInterval(poll));
  prosecutor.onExecutorEvent(key, { type: 'agent_end' }, { cwd: repo, prompt() { return { ok: true }; } });
  await prosecutor.pendingWork(key);
  for (let i = 0; i < 100 && !seen; i++) await new Promise(resolve => setTimeout(resolve, 5));
  clearInterval(poll);
  // Give the fixture's cleanup back a writable object store.
  if (mode === 'cleanupFails') (await import('node:child_process')).execSync('chmod -R u+w .git/objects', { cwd: repo });
  if (mode === 'cleanupFails') {
    // No checkpoint could be saved: the crew must see the cleanup's own
    // failure, not the gate's close message that would hide it.
    const terminal = events.find(e => e.kind === 'terminal');
    assert.ok(terminal, 'the crew saw the round end');
    assert.equal(events.some(e => e.kind === 'checkpoint'), false);
    assert.match(terminal.reason, /Could not check the prosecutor edit boundary/);
    assert.doesNotMatch(terminal.reason, /Acceptance checks changed the worktree/);
    return;
  }
  assert.equal(seen, mode === 'mutating' ? 'stopped' : 'inconclusive');
  const checkpoint = events.findIndex(e => e.kind === 'checkpoint');
  const terminal = events.findIndex(e => e.kind === 'terminal');
  assert.ok(checkpoint >= 0, 'the closing round saved a checkpoint');
  assert.ok(checkpoint < terminal, 'the checkpoint is saved before the crew sees the terminal status');
  const saved = events[checkpoint];
  assert.equal(saved.adoptBoundary, true);
  assert.ok(saved.owned.includes('proofs/kept.txt'));
  const kept = await git(repo, ['show', `${saved.baselineCommit}:proofs/kept.txt`]);
  assert.equal(kept.ok, true, kept.error);
}

test('a no-verdict close saves the kept test before the crew sees it', async t => {
  await terminalClose(t, 'noverdict');
});

test('an unconfigured-gate close saves the kept test before the crew sees it', async t => {
  await terminalClose(t, 'unconfigured');
});

test('a gate that edits the tree closes only after the kept test is saved', async t => {
  await terminalClose(t, 'mutating');
});

test('a failed exit cleanup keeps its own pause instead of the deferred close', async t => {
  await terminalClose(t, 'cleanupFails');
});
