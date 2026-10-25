/** Opt-in actual Codex check: node scripts/crew-native-smoke.mjs. Uses scratch repos/data only. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCrew } from '../server/crew.js';
import { crewExecutor } from '../server/crew-agent.js';
import { CodexAgentPool } from '../server/codex-agent.js';
import { closeSharedCodex } from '../server/codex-app-server.js';
import { git } from '../server/snapshots.js';
const root = await mkdtemp(join(tmpdir(), 'crew-native-'));
const pool = new CodexAgentPool();
let approvals = 0;
const native = crewExecutor({ getAgent: key => pool.get(key), stopAgent: key => pool.stop(key), timeoutMs: 90_000 });
const model = { provider: 'codex', id: 'gpt-6.1-sol' };
try {
  for (const mode of ['sequential', 'parallel']) {
    const cwd = join(root, mode); await mkdir(cwd);
    for (const args of [['init', '-q'], ['config', 'user.email', 'crew@test.local'], ['config', 'user.name', 'Crew smoke']]) assert.equal((await git(cwd, args)).ok, true);
    await writeFile(join(cwd, 'README.md'), 'Scratch native crew smoke check.\n'); await git(cwd, ['add', '.']); await git(cwd, ['commit', '-qm', 'baseline']);
    const crew = createCrew({ home: join(root, `${mode}-data`), execute: args => native({ ...args, onEvent: event => {
      args.onEvent(event);
      if (event.type === 'approval_request') { approvals++; pool.get(args.sessionKey).resolveApproval(event.requestId, event.options.find(o => o.id === 'allow' || o.id === 'allow_once')?.id || 'deny'); }
    } }) });
    const run = crew.create('native-smoke', { mode, cwd, request: 'Create a.txt containing a and b.txt containing b. These are scratch test files.', concurrency: 2, agreement: 'Each assignment owns its named file. Do not modify other files.', reviewer: { backend: 'codex', model }, tasks: ['a', 'b'].map(id => ({ id, kind: 'execute', backend: 'codex', model, outcome: `Create ${id}.txt containing exactly ${id} followed by a newline. This is the entire assignment.`, scope: [`${id}.txt`], dependencies: [], checks: [`test "$(cat ${id}.txt)" = ${id}`] })) }, `native-${mode}`);
    await crew.action('native-smoke', run.id, 'start');
    let result;
    for (let i = 0; i < 600; i++) { result = crew.read(run.id); if (['done', 'blocked'].includes(result.status)) break; await new Promise(resolve => setTimeout(resolve, 1000)); }
    assert.equal(result.status, 'done', JSON.stringify(result));
    for (const id of ['a', 'b']) assert.equal(await readFile(join(result.integration.path, `${id}.txt`), 'utf8'), `${id}\n`);
    assert.equal((await git(cwd, ['status', '--porcelain'])).out, '');
    console.log(JSON.stringify({ mode, status: result.status, tasks: result.tasks.map(t => ({ id: t.id, status: t.status, checks: t.gate.ok })), combinedChecks: result.gate.ok, finalReview: result.finalReview, approvals }));
  }
} finally { pool.stop(); closeSharedCodex(); await rm(root, { recursive: true, force: true }); }
