import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';

test('crew HTTP persists drafts across server restart and retains API authorization', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'crew-http-')); let server;
  t.after(async () => { if (server?.exitCode === null) { process.kill(-server.pid, 'SIGKILL'); await once(server, 'exit'); } await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await mkdir(join(scratch, 'home'));
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening'); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  let boot = '';
  const start = async () => {
    server = spawn(process.execPath, [join(import.meta.dirname, 'index.js')], { cwd: scratch, detached: true, env: { ...process.env, HOME: join(scratch, 'home'), APP_HOME: join(scratch, 'data'), APP_PORT: String(port), APP_TOKEN: 'crew-test-token' }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', chunk => { boot += chunk; });
    server.stdout.on('data', chunk => { boot += chunk; });
    for (let i = 0; i < 150; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Authorization: 'Bearer crew-test-token' } }); if (r.ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
    assert.fail(boot);
  };
  const api = async (method, body, authorized = true) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/parent/crew?sessionFile=durable-file`, { method, headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer crew-test-token' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  await start(); assert.equal((await api('GET', null, false)).status, 401);
  const config = { request: 'HTTP draft test', cwd: scratch, mode: 'parallel', tasks: [{ id: 'a', kind: 'execute', backend: 'codex', scope: ['.'], checks: ['true'], dependencies: [], outcome: 'draft only' }], reviewer: { backend: 'codex' } };
  const created = await api('POST', { op: 'create', sessionFile: 'durable-file', requestId: 'http-stable-run', config });
  assert.equal(created.body.ok, true, JSON.stringify(created)); assert.equal(created.body.run.status, 'draft');
  assert.equal((await api('POST', { op: 'create', sessionFile: 'durable-file', requestId: 'http-stable-run', config })).body.run.id, created.body.run.id);
  assert.equal((await api('GET')).body.runs.length, 1);
  process.kill(-server.pid, 'SIGKILL'); await once(server, 'exit'); await start();
  const restored = await api('GET'); assert.equal(restored.body.runs[0].status, 'draft'); assert.equal(restored.body.runs[0].id, 'http-stable-run');
  assert.equal((await api('POST', { op: 'resume', runId: 'http-stable-run', sessionFile: 'wrong-file' })).status, 400);
});
