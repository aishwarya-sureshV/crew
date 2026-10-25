import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('crew transcript renders native object-shaped permission requests', async () => {
  // Render the actual component with inert stores; no browser or live API needed.
  const source = (await readFile(new URL('../src/components/CrewPanel.tsx', import.meta.url), 'utf8'))
    .replace(/import \{ api \} from '..\/lib\/api';/, 'const api = {};')
    .replace(/import \{ useStore \} from '..\/lib\/store';/, 'const useStore = () => ({ resumeConversation() {} });')
    .replace(/import \{ resolveRouteModel, type SessionRoute \} from '..\/lib\/route';/, 'const resolveRouteModel = () => ({ ok: true, model: null });')
    .replace(/import \{ runLabel \} from '..\/lib\/crewTimeline';/, 'const runLabel = (status) => status;') + '\nexport { Transcript };';
  const compiled = await transform(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic' });
  const module = { exports: {} }; new Function('require', 'module', 'exports', compiled.code)(createRequire(import.meta.url), module, module.exports);
  const record = {label:'worker',backend:'claude',sessionKey:'test',cwd:'/tmp',prompt:'test',report:'',events:[{type:'approval_request',requestId:'1',title:'Write',detail:{file_path:'x.txt',content:'new content'},options:[{id:'allow',label:'Allow once'}]}]};
  const html = renderToStaticMarkup(React.createElement(module.exports.Transcript,{record,refresh(){}}));
  assert.match(html,/new content/); assert.match(html,/Allow once/);
});

test('activity renders approved model selections and worker overrides', async () => {
  const source = (await readFile(new URL('../src/components/CrewPanel.tsx', import.meta.url), 'utf8'))
    .replace(/import \{ api \} from '..\/lib\/api';/, 'const api = {};')
    .replace(/import \{ useStore \} from '..\/lib\/store';/, 'const useStore = () => ({ resumeConversation() {} });')
    .replace(/import \{ resolveRouteModel, type SessionRoute \} from '..\/lib\/route';/, 'const resolveRouteModel = () => ({ ok: true, model: null });')
    .replace(/import \{ runLabel \} from '..\/lib\/crewTimeline';/, 'const runLabel = (status) => status;') + '\nexport { Activity };';
  const compiled = await transform(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.code)(createRequire(import.meta.url), module, module.exports);
  const html = renderToStaticMarkup(React.createElement(module.exports.Activity, { run: { events: [
    { at: 1, kind: 'criteria_approved', text: 'criteria approved', detail: {
      criteria: [{ id: 'AC1', text: 'exists' }],
      delta: ['review off → on'],
      models: {
        builder: { backend: 'codex', model: { provider: 'openai', id: 'gpt-5.1' } },
        prosecutor: { backend: 'pi', model: { provider: 'anthropic', id: 'claude' } },
      },
    } },
    { at: 2, kind: 'split_approved', text: '2 workers', detail: { workers: [
      { id: 'W1', backend: 'codex', model: { provider: 'openai', id: 'gpt-5.1' } },
      { id: 'W2', backend: 'grok', model: null },
    ] } },
  ] } }));
  assert.match(html, /AC1 exists/);
  assert.match(html, /review off → on/);
  assert.match(html, /builder codex openai\/gpt-5\.1/);
  assert.match(html, /prosecutor pi anthropic\/claude/);
  assert.match(html, /W1 codex openai\/gpt-5\.1/);
  assert.match(html, /W2 grok default/);
});

test('folded crew cards render in timestamp order', async () => {
  const built = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { TurnList } from './src/components/ConversationPane.tsx';
        import { groupTranscriptRows } from './src/lib/toolRow.ts';
        const tool = (id, startedAt) => ({ id, kind: 'tool', name: 'read', args: {}, details: {}, output: 'ok', status: 'done', startedAt });
        const user = { id: 'u', kind: 'user', text: 'go', timestamp: 1 };
        const assistant = { id: 'a', kind: 'assistant', text: 'done', live: false, timestamp: 300 };
        const turn = [user, tool('t1', 100), tool('t2', 140), assistant];
        const html = renderToStaticMarkup(React.createElement(TurnList, {
          turnViews: [{
            id: 'u', turn, turnIndex: 0, user, showFold: false, logOpen: true,
            blocks: groupTranscriptRows(turn.filter(item => item.kind !== 'user')),
            changedFiles: [], stats: null, cardHost: undefined, userItems: [user], failedCount: 0,
          }],
          renderTimelineItem: (item) => React.createElement('span', { 'data-row': item.id }, item.id),
          openFileView() {},
          onRewindFiles: async () => ({ ok: true, files: [] }),
          setTurnOpen() {},
          latestChangedTurn: -1,
          streaming: false,
          cwd: '/tmp',
          crewAfter: {
            t1: React.createElement('div', { 'data-crew': 'early' }, 'EARLY'),
            a: React.createElement('div', { 'data-crew': 'late' }, 'LATE'),
          },
        }));
        export { html };
      `,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      sourcefile: 'crew-kept-render.tsx',
      loader: 'tsx',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
    logLevel: 'silent',
    plugins: [{
      name: 'stub-workbench-glob',
      setup(builder) {
        builder.onLoad({ filter: /WorkbenchIcon\.tsx$/ }, async (args) => ({
          contents: (await readFile(args.path, 'utf8')).replace(/const icons = import\.meta\.glob[\s\S]*?;/, 'const icons: Record<string, string> = {};'),
          loader: 'tsx',
        }));
      },
    }],
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const html = module.exports.html;
  assert.ok(html.includes('data-crew="early"'), html);
  assert.ok(html.includes('data-crew="late"'), html);
  assert.ok(html.indexOf('data-crew="early"') < html.indexOf('data-crew="late"'), html);
});
