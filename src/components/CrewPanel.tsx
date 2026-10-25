import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import { api } from '../lib/api';
import type { AgentBackend, ModelInfo } from '../lib/api';
import type { ConversationTab } from '../lib/store';
import { useStore } from '../lib/store';
import { resolveRouteModel, type SessionRoute } from '../lib/route';
import type { CrewDecisions, CrewRun, CrewStepModel, CrewTask, CrewTranscript } from '../lib/crew';
import { runLabel } from '../lib/crewTimeline';

const READERS = new Set(['pi', 'claude', 'codex']);
const BACKENDS = ['claude', 'codex', 'grok', 'pi'] as const;
const KINDS = ['plan', 'diagnose', 'execute', 'review'] as const;
const MARKS: Record<string, { g: string; c: string }> = {
  claude: { g: '✳', c: '#e8906a' },
  codex: { g: '⬡', c: '#9cc4ff' },
  grok: { g: '✦', c: '#b69cff' },
  pi: { g: 'π', c: '#5fd49a' },
};

type Kind = (typeof KINDS)[number];
type ModelRef = { provider: string; id: string } | null;
type DraftTask = {
  id: string;
  kind: Kind;
  backend: string;
  model: ModelRef;
  outcome: string;
  scope: string[];
  checks: string[];
  dependencies: string[];
};
type Draft = {
  requestId: string;
  request: string;
  mode: 'sequential' | 'parallel';
  reviewer: { backend: string; model: ModelRef };
  tasks: DraftTask[];
};
type CrewState = {
  runs: CrewRun[];
  error: string;
  draft: Draft | null;
  selectedId: string | null;
  revealed: boolean;
  problems: string[];
};

function mark(backend: string) {
  return MARKS[backend] ?? { g: '✦', c: 'var(--fg3)' };
}
function readerBackend(backend: string) {
  return READERS.has(backend) ? backend : 'codex';
}
function prettyCwd(cwd: string) {
  const home = /^\/(?:Users|home)\/[^/]+\/(.*)$/.exec(cwd);
  return home ? `~/${home[1]}` : cwd;
}
function taskIdOf(message: string, ids: string[]) {
  return ids.find(id => message.startsWith(`${id}.`) || message.startsWith(`${id}:`)) ?? '';
}
function dependencyCycle(tasks: { id: string; dependencies: string[] }[]) {
  const deps = new Map(tasks.map(task => [task.id, task.dependencies]));
  for (const start of deps.keys()) {
    const seen = new Set<string>();
    const walk = (id: string, path: string[]): string[] | null => {
      for (const next of deps.get(id) || []) {
        if (next === start) return [...path, next];
        if (!deps.has(next) || seen.has(next)) continue;
        seen.add(next);
        const found = walk(next, [...path, next]);
        if (found) return found;
      }
      return null;
    };
    const found = walk(start, [start]);
    if (found) return found;
  }
  return null;
}
function planProblems(config: { request?: string; cwd?: string; mode?: string; tasks?: DraftTask[]; reviewer?: { backend: string } }) {
  const messages: string[] = [];
  const tasks = config.tasks ?? [];
  const ids = tasks.map(task => task.id);
  if (!config.request?.trim()) messages.push('Request and workspace are required.');
  if (!tasks.length) messages.push('Provide 1–32 assignments.');
  for (const task of tasks) {
    if (task.kind === 'execute' && !task.checks.length) messages.push(`${task.id}.checks: execute assignments need at least one acceptance check`);
    if (task.kind !== 'execute' && !READERS.has(task.backend)) messages.push(`${task.id}.backend: ${task.backend} cannot run ${task.kind} assignments read-only`);
    if (!task.scope.length || task.scope.some(path => !path || path.startsWith('/') || path.split('/').includes('..'))) messages.push(`${task.id}.scope: Each assignment needs repository-relative scope (use . for the whole repository).`);
    for (const id of task.dependencies) if (!ids.includes(id)) messages.push(`${task.id}.dependencies: unknown assignment ${id}`);
  }
  const cycle = dependencyCycle(tasks);
  if (cycle) messages.push(`${cycle[0]}.dependencies: cycle ${cycle.join(' → ')}`);
  if (new Set(ids).size !== ids.length) messages.push('Assignment IDs must be unique.');
  if (config.reviewer && !READERS.has(config.reviewer.backend)) messages.push('Choose an independent read-only reviewer (pi, claude or codex).');
  if (tasks.length && !tasks.some(task => task.kind === 'execute')) messages.push('Crew needs a build assignment.');
  return [...new Set(messages)];
}
function configFrom(draft: Draft, cwd: string) {
  return {
    request: draft.request,
    cwd,
    mode: draft.mode,
    concurrency: 2,
    agreement: '',
    reviewer: { backend: draft.reviewer.backend, model: draft.reviewer.model },
    tasks: draft.tasks.map(task => ({
      id: task.id,
      kind: task.kind,
      backend: task.backend,
      model: task.model,
      outcome: task.outcome,
      scope: task.scope,
      checks: task.checks,
      dependencies: task.dependencies,
    })),
  };
}
function defaultTasks(request: string, backend: string): DraftTask[] {
  const reader = readerBackend(backend);
  return [
    { id: 'a1', kind: 'plan', backend: reader, model: null, outcome: request ? `Plan: ${request}` : '', scope: ['.'], checks: ['Report the outcome'], dependencies: [] },
    { id: 'a2', kind: 'execute', backend, model: null, outcome: request, scope: ['.'], checks: [], dependencies: ['a1'] },
  ];
}
function nextId(tasks: DraftTask[]) {
  let n = tasks.length + 1;
  let id = `a${n}`;
  while (tasks.some(task => task.id === id)) id = `a${++n}`;
  return id;
}
function nextCriterionId(rows: { id: string }[]) {
  const used = new Set(rows.map(row => row.id));
  let n = 1;
  while (used.has(`AC${n}`)) n += 1;
  return `AC${n}`;
}
function criterionCredit(run: CrewRun, id: string) {
  const verdict = run.reviews?.at(-1)?.verdicts?.[id];
  const accepted = (run.events ?? []).some(event => event.kind === 'review_accepted');
  const marks = [
    verdict === 'pass' ? 'review passed' : verdict === 'fail' ? (accepted ? 'accepted open' : 'review failed') : '',
    run.prosecution?.status === 'verified' ? 'prosecution' : '',
    run.gate?.ok ? 'checks' : '',
  ].filter(Boolean);
  return marks.join(' · ') || 'open';
}
function activityCriteria(event: { detail?: unknown }) {
  const detail = event.detail;
  if (!detail || typeof detail !== 'object' || !('criteria' in detail)) return '';
  const criteria = (detail as { criteria?: { id?: string; text?: string }[] }).criteria;
  if (!Array.isArray(criteria) || !criteria.length) return '';
  return criteria.map(item => `${item.id} ${item.text}`).join(' · ');
}
function activityDelta(event: { detail?: unknown }) {
  const detail = event.detail;
  if (!detail || typeof detail !== 'object' || !('delta' in detail)) return '';
  const delta = (detail as { delta?: unknown }).delta;
  return Array.isArray(delta) ? delta.map(item => String(item)).filter(Boolean).join('; ') : '';
}
function modelName(model?: { provider?: string; id?: string } | null) {
  if (!model?.id) return 'default';
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}
function activityModels(event: { detail?: unknown }) {
  const detail = event.detail;
  if (!detail || typeof detail !== 'object') return '';
  const models = (detail as { models?: Record<string, { backend?: string; model?: { provider?: string; id?: string } | null }> }).models;
  const workers = (detail as { workers?: { id?: string; backend?: string; model?: { provider?: string; id?: string } | null }[] }).workers;
  const roles = ['builder', 'investigator', 'prosecutor', 'reviewer'].flatMap(role => {
    const step = models?.[role];
    return step?.backend ? [`${role} ${step.backend} ${modelName(step.model)}`] : [];
  });
  const picked = Array.isArray(workers)
    ? workers.flatMap(worker => (worker?.backend || worker?.id) ? [`${worker.id || 'worker'} ${worker.backend || ''} ${modelName(worker.model)}`.replace(/\s+/g, ' ').trim()] : [])
    : [];
  return [...roles, ...picked].join(' · ');
}
function autonomousTranscripts(run: CrewRun): CrewTranscript[] {
  return [
    ...(run.lead?.history ?? []),
    ...(run.investigation?.history ?? []),
    ...(run.tasks ?? []).flatMap(task => task.history ?? []),
    ...(run.integrator?.history ?? []),
    ...(run.reviewTranscripts ?? []),
    ...(run.finalHistory ?? []),
  ];
}
function elapsed(from?: number, to?: number) {
  if (!from) return '';
  const seconds = Math.max(0, Math.floor(((to ?? Date.now()) - from) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function ago(ts?: number) {
  if (!ts) return '';
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  if (seconds < 172800) return 'yesterday';
  return `${Math.round(seconds / 86400)}d`;
}
function viewStatus(run: CrewRun, task: CrewTask) {
  if (task.status === 'accepted') return 'done';
  if (task.status === 'awaiting_approval') return 'approval';
  if (run.status === 'paused' && task.status === 'interrupted') return 'paused';
  if (task.status === 'interrupted') return 'interrupted';
  if (task.status === 'failed' || task.status === 'conflict') return task.attempts >= 3 ? 'limit' : 'failed';
  if (['running', 'reviewing', 'ready_for_review'].includes(task.status)) return 'running';
  const waiting = task.dependencies.some(id => run.tasks.find(item => item.id === id)?.status !== 'accepted');
  return waiting ? 'waiting' : 'queued';
}
function statusWord(status: string) {
  if (status === 'failed') return 'failed';
  if (status === 'limit') return 'review manually';
  if (status === 'approval') return 'needs approval';
  if (status === 'interrupted') return 'interrupted';
  if (status === 'paused') return 'paused';
  return '';
}
function progressLabel(run: CrewRun) {
  if (run.status === 'done') return '';
  if (run.phase === 'routing') return 'choosing workflow…';
  if (run.tasks.some(task => task.status === 'conflict')) return 'merge conflict';
  if (run.tasks.some(task => task.id.startsWith('combined-repair-') && ['running', 'reviewing', 'ready_for_review'].includes(task.status))) return 'repairing…';
  if (run.phase === 'combined_validation' && (run.status === 'blocked' || run.status === 'awaiting_approval')) return 'validation failed';
  const done = run.tasks.filter(task => task.status === 'accepted').length;
  return `${done}/${run.tasks.length} done`;
}
function diffFiles(diff: string) {
  return diff.split(/^diff --git /m).slice(1).map(chunk => {
    const head = chunk.split('\n')[0] ?? '';
    const match = /^a\/(\S+) b\/(\S+)/.exec(head);
    const path = match?.[2] ?? 'file';
    const added = (chunk.match(/^\+[^+]/gm) ?? []).length;
    const removed = (chunk.match(/^-[^-]/gm) ?? []).length;
    const slash = path.lastIndexOf('/');
    const fresh = /^new file mode/m.test(chunk);
    return {
      status: fresh ? 'A' as const : 'M' as const,
      name: slash >= 0 ? path.slice(slash + 1) : path,
      dir: slash >= 0 ? path.slice(0, slash + 1) : '',
      added,
      removed,
    };
  });
}
function signature(runs: CrewRun[]) {
  return JSON.stringify(runs.map(run => [run.id, run.status, run.updatedAt, run.error, run.phase, run.events?.length, run.repairs, run.diff?.length, run.finalReview?.length, run.tasks.map(task => [task.id, task.status, task.attempts, task.error, task.report?.length, task.gate?.ok, task.history.length])]));
}

type Bucket = {
  id: string;
  key: string;
  sessionFile: string;
  cwd: string;
  state: CrewState;
  listeners: Set<() => void>;
  users: number;
  timer: number;
  gen: number;
  sig: string;
};
const buckets = new Map<string, Bucket>();
const emptyState = (): CrewState => ({ runs: [], error: '', draft: null, selectedId: null, revealed: false, problems: [] });
function emit(bucket: Bucket) {
  for (const listener of bucket.listeners) listener();
}
function load(bucket: Bucket) {
  const gen = ++bucket.gen;
  void api.crew(bucket.key, bucket.sessionFile || undefined, bucket.cwd).then(result => {
    if (gen !== bucket.gen || !result.ok) return;
    const next = signature(result.runs);
    if (next === bucket.sig) return;
    bucket.sig = next;
    bucket.state = { ...bucket.state, runs: result.runs, error: bucket.state.error };
    emit(bucket);
  }).catch(error => {
    if (gen !== bucket.gen) return;
    bucket.state = { ...bucket.state, error: String(error) };
    emit(bucket);
  });
}
function ensure(key: string, sessionFile: string | undefined, cwd: string) {
  const id = `${key}\0${sessionFile || ''}\0${cwd}`;
  let bucket = buckets.get(id);
  if (!bucket) {
    bucket = { id, key, sessionFile: sessionFile || '', cwd, state: emptyState(), listeners: new Set(), users: 0, timer: 0, gen: 0, sig: '' };
    buckets.set(id, bucket);
  }
  bucket.key = key;
  bucket.sessionFile = sessionFile || '';
  bucket.cwd = cwd;
  return bucket;
}
export function useCrewState(key: string, sessionFile: string | undefined, cwd: string) {
  const bucket = ensure(key, sessionFile, cwd);
  const state = useSyncExternalStore(
    listener => {
      bucket.listeners.add(listener);
      return () => bucket.listeners.delete(listener);
    },
    () => bucket.state,
    () => bucket.state,
  );
  useEffect(() => {
    bucket.users += 1;
    if (bucket.users === 1) {
      load(bucket);
      bucket.timer = window.setInterval(() => load(bucket), 1500);
    }
    return () => {
      bucket.users -= 1;
      if (bucket.users <= 0) {
        bucket.users = 0;
        if (bucket.timer) window.clearInterval(bucket.timer);
        bucket.timer = 0;
      }
    };
  }, [bucket]);
  useEffect(() => {
    let stop = () => {};
    let cancelled = false;
    void import('../lib/api').then(mod => {
      if (cancelled) return;
      stop = mod.subscribeEvents(event => {
        const loose = event as { type?: string; sessionKey?: string };
        if (loose.type !== 'crew_state') return;
        const owner = bucket.sessionFile || bucket.key;
        if (loose.sessionKey === owner || loose.sessionKey === bucket.key) load(bucket);
      });
    }).catch(() => {});
    return () => { cancelled = true; stop(); };
  }, [bucket]);
  const update = useCallback((partial: Partial<CrewState>) => {
    bucket.state = { ...bucket.state, ...partial };
    emit(bucket);
  }, [bucket]);
  const reload = useCallback(() => load(bucket), [bucket]);
  return { state, update, reload };
}

function Transcript({ record, refresh }: { record: CrewTranscript; refresh: () => void }) {
  const { resumeConversation } = useStore();
  const [error, setError] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const pending = record.events.filter(e => ['approval_request', 'user_input_request'].includes(e.type) && !record.events.some(r => ['approval_resolved', 'user_input_resolved'].includes(r.type) && r.requestId === e.requestId));
  return <details><summary>{record.label} · {record.backend} · {record.sessionKey}</summary>
    {record.sessionPath && <button type="button" onClick={() => resumeConversation({ path: record.sessionPath!, cwd: record.cwd, name: `Crew ${record.label}`, backend: record.backend, createdAt: 0, modifiedAt: Date.now(), messageCount: 0 })}>Open transcript</button>}
    {pending.map(e => <div key={e.requestId}><strong>Needs input: {e.title || e.type}</strong><pre>{typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail, null, 2)}</pre>
      {e.type === 'approval_request' && e.options?.map(option => <button type="button" key={option.id} onClick={() => { void api.approve(record.sessionKey, e.requestId!, option.id, record.backend).then(r => { setError(r.error || ''); refresh(); }).catch(err => setError(String(err))); }}>{option.label}</button>)}
      {e.type === 'user_input_request' && <>{e.questions?.map(q => <label key={q.id}>{q.question}<input value={answers[q.id] || ''} onChange={event => setAnswers({ ...answers, [q.id]: event.target.value })}/></label>)}<button type="button" onClick={() => { void api.answer(record.sessionKey, e.requestId!, Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, { answers: [value] }]))).then(r => { setError(r.error || ''); refresh(); }).catch(err => setError(String(err))); }}>Answer</button></>}
    </div>)}
    {error && <p role="alert">{error}</p>}<details><summary>Context received</summary><pre>{record.prompt}</pre></details><pre>{record.report || 'Agent is working; open transcript for activity.'}</pre>
  </details>;
}

function ModelMenu({ backends, catalog, selected, readOnlyKind, onPick }: {
  backends: readonly string[];
  catalog: Record<string, ModelInfo[]>;
  selected: { backend: string; model: ModelRef };
  readOnlyKind: boolean;
  onPick: (backend: string, model: ModelRef) => void;
}) {
  return <div className="crew-menu">{backends.map(backend => {
    const disabled = readOnlyKind && !READERS.has(backend);
    const models = catalog[backend] ?? [];
    const chips = models.length ? models : [{ id: '', provider: '', name: 'default' } as ModelInfo];
    const glyph = mark(backend);
    return <div key={backend} className="crew-menu__row" style={{ opacity: disabled ? 0.35 : 1 }} title={disabled ? `${backend} has no read-only mode` : undefined}>
      <span className="crew-menu__name"><span style={{ color: glyph.c }}>{glyph.g}</span>{backend}</span>
      <div className="crew-menu__models">{chips.map(model => {
        const on = selected.backend === backend && (model.id ? selected.model?.id === model.id && selected.model.provider === model.provider : !selected.model);
        return <button type="button" key={`${model.provider}/${model.id || 'default'}`} className={on ? 'is-on' : ''} disabled={disabled} style={{ cursor: disabled ? 'not-allowed' : 'pointer' }} onClick={() => { if (!disabled) onPick(backend, model.id ? { provider: model.provider, id: model.id } : null); }}>{model.name || model.id || 'default'}</button>;
      })}</div>
    </div>;
  })}</div>;
}

function PlanEditor({ tab, draft, revealed, problems, accessMode, onChange, onClose, onReveal, onCreated }: {
  tab: ConversationTab;
  draft: Draft;
  revealed: boolean;
  problems: string[];
  accessMode: string;
  onChange: (draft: Draft) => void;
  onClose: () => void;
  onReveal: (problems: string[]) => void;
  onCreated: (run: CrewRun) => void;
}) {
  const readOnly = accessMode === 'read-only';
  const [menu, setMenu] = useState<string | null>(null);
  const [scopeDraft, setScopeDraft] = useState<Record<string, string>>({});
  const [checkDraft, setCheckDraft] = useState<Record<string, string>>({});
  const [catalog, setCatalog] = useState<Record<string, ModelInfo[]>>({});
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const ids = draft.tasks.map(task => task.id);
  useEffect(() => {
    let alive = true;
    void api.gitChanges(tab.key, tab.cwd).then(result => { if (alive && result.branch) setBranch(result.branch); }).catch(() => {});
    for (const backend of BACKENDS) {
      void api.models(tab.key, backend).then(result => {
        if (alive && result.ok && Array.isArray(result.models)) setCatalog(current => ({ ...current, [backend]: result.models }));
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [tab.key, tab.cwd]);
  useEffect(() => {
    if (!revealed) return;
    const config = configFrom(draft, tab.cwd);
    onReveal(planProblems(config));
    const timer = window.setTimeout(() => {
      void api.crewAction(tab.key, { op: 'validate', sessionFile: tab.sessionPath, config }).then(result => {
        if (Array.isArray(result.problems)) onReveal(result.problems);
        else if (result.error && !/Unknown crew action/.test(result.error)) onReveal([result.error]);
      }).catch(() => {});
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draft, revealed, tab.cwd, tab.key, tab.sessionPath]);
  function patchTask(id: string, partial: Partial<DraftTask>) {
    onChange({ ...draft, tasks: draft.tasks.map(task => task.id === id ? { ...task, ...partial } : task) });
  }
  async function create() {
    if (readOnly || busy) return;
    const config = configFrom(draft, tab.cwd);
    setBusy(true);
    try {
      const result = await api.crewAction(tab.key, { op: 'create', requestId: draft.requestId, sessionFile: tab.sessionPath, config });
      if (!result.ok || !result.run) {
        const server = result.error ? [result.error] : [];
        onReveal([...new Set([...planProblems(config), ...(result.problems ?? server)])]);
        return;
      }
      onCreated(result.run);
    } catch (error) {
      onReveal([...planProblems(config), error instanceof Error ? error.message : String(error)]);
    } finally { setBusy(false); }
  }
  function preview() {
    if (readOnly || busy) return;
    onReveal(planProblems(configFrom(draft, tab.cwd)));
  }
  const lock = readOnly ? 'Read-only session' : undefined;
  return <div className="crew-plan">
    <div className="crew-plan__top">
      <div className="crew-plan__head">
        <strong>New crew run</strong>
        <span className="crew-plan__ws">{prettyCwd(tab.cwd)}{branch ? ` ⎇ ${branch}` : ''}</span>
        <button type="button" className="crew-x" title="Discard" onClick={onClose}>×</button>
      </div>
      <textarea className="crew-request" rows={2} value={draft.request} aria-label="Crew request" onChange={event => onChange({ ...draft, request: event.target.value })} />
      <div className="crew-line">
        <div className="crew-seg" role="group" aria-label="Run mode">
          {(['sequential', 'parallel'] as const).map(mode => <button type="button" key={mode} className={draft.mode === mode ? 'is-on' : ''} onClick={() => onChange({ ...draft, mode })}>{mode === 'sequential' ? 'Sequential' : 'Parallel'}</button>)}
        </div>
        <button type="button" className={`crew-chip${menu === 'reviewer' ? ' is-on' : ''}`} title="Reviewer" onClick={() => setMenu(menu === 'reviewer' ? null : 'reviewer')}>
          <span className="crew-chip__k">reviewer</span>
          <span style={{ color: mark(draft.reviewer.backend).c }}>{mark(draft.reviewer.backend).g}</span>
          {draft.reviewer.model?.id || 'default'}
          <span className="crew-caret">▾</span>
        </button>
      </div>
      {menu === 'reviewer' && <ModelMenu backends={BACKENDS} catalog={catalog} selected={draft.reviewer} readOnlyKind onPick={(backend, model) => { onChange({ ...draft, reviewer: { backend, model } }); setMenu(null); }} />}
    </div>
    <div className="crew-assignments">
      {draft.tasks.map(task => {
        const errs = revealed ? problems.filter(problem => taskIdOf(problem, ids) === task.id) : [];
        const glyph = mark(task.backend);
        return <div key={task.id} className="crew-asg">
          <div className="crew-asg__row">
            <span className="crew-id">{task.id}</span>
            <button type="button" className="crew-kind" title="Kind · click to change" onClick={() => patchTask(task.id, { kind: KINDS[(KINDS.indexOf(task.kind) + 1) % KINDS.length] ?? 'plan' })}>{task.kind}</button>
            <button type="button" className={`crew-chip${menu === task.id ? ' is-on' : ''}`} title="Backend and model" onClick={() => setMenu(menu === task.id ? null : task.id)}>
              <span style={{ color: glyph.c }}>{glyph.g}</span>{task.model?.id || 'default'}<span className="crew-caret">▾</span>
            </button>
            <input className="crew-outcome" value={task.outcome} placeholder="Outcome" aria-label={`${task.id} outcome`} onChange={event => patchTask(task.id, { outcome: event.target.value })} />
            {errs.length > 0 && <i className="crew-dot" />}
            <button type="button" className={`crew-more${menu === `more:${task.id}` ? ' is-on' : ''}`} title="Scope, checks, dependencies" onClick={() => setMenu(menu === `more:${task.id}` ? null : `more:${task.id}`)}>···</button>
            <button type="button" className="crew-remove" title="Remove" onClick={() => onChange({ ...draft, tasks: draft.tasks.filter(item => item.id !== task.id).map(item => ({ ...item, dependencies: item.dependencies.filter(id => id !== task.id) })) })}>×</button>
          </div>
          {menu === task.id && <ModelMenu backends={BACKENDS} catalog={catalog} selected={task} readOnlyKind={task.kind !== 'execute'} onPick={(backend, model) => { patchTask(task.id, { backend, model }); setMenu(null); }} />}
          {errs.map(error => <p key={error} className="crew-problem">{error}</p>)}
          {menu === `more:${task.id}` && <div className="crew-morebox">
            <span>scope</span>
            <div>{task.scope.map(path => <span key={path} className="crew-token">{path}<button type="button" aria-label={`Remove ${path}`} onClick={() => patchTask(task.id, { scope: task.scope.filter(item => item !== path) })}>×</button></span>)}
              <input value={scopeDraft[task.id] ?? ''} placeholder="+ path" aria-label={`${task.id} path`} onChange={event => setScopeDraft({ ...scopeDraft, [task.id]: event.target.value })} onKeyDown={event => { if (event.key !== 'Enter') return; event.preventDefault(); const path = (scopeDraft[task.id] ?? '').trim(); if (!path) return; patchTask(task.id, { scope: [...task.scope, path] }); setScopeDraft({ ...scopeDraft, [task.id]: '' }); }} /></div>
            <span>checks</span>
            <div>{task.checks.map(command => <span key={command} className="crew-token">$ {command}<button type="button" aria-label={`Remove ${command}`} onClick={() => patchTask(task.id, { checks: task.checks.filter(item => item !== command) })}>×</button></span>)}
              <input value={checkDraft[task.id] ?? ''} placeholder="+ command" aria-label={`${task.id} command`} onChange={event => setCheckDraft({ ...checkDraft, [task.id]: event.target.value })} onKeyDown={event => { if (event.key !== 'Enter') return; event.preventDefault(); const command = (checkDraft[task.id] ?? '').replace(/^\$\s*/, '').trim(); if (!command) return; patchTask(task.id, { checks: [...task.checks, command] }); setCheckDraft({ ...checkDraft, [task.id]: '' }); }} /></div>
            <span>after</span>
            <div className="crew-deps">{draft.tasks.filter(item => item.id !== task.id).map(item => {
              const on = task.dependencies.includes(item.id);
              return <button type="button" key={item.id} className={on ? 'is-on' : ''} onClick={() => patchTask(task.id, { dependencies: on ? task.dependencies.filter(id => id !== item.id) : [...task.dependencies, item.id] })}>{item.id}</button>;
            })}</div>
          </div>}
        </div>;
      })}
    </div>
    {revealed && problems.length > 0 && <div className="crew-count">
      <span>{problems.length} {problems.length === 1 ? 'problem' : 'problems'} from the server</span>
      {problems.filter(problem => !taskIdOf(problem, ids)).map(problem => <p key={problem} className="crew-problem">{problem}</p>)}
    </div>}
    <div className="crew-foot">
      <button type="button" className="crew-add" onClick={() => { const id = nextId(draft.tasks); onChange({ ...draft, tasks: [...draft.tasks, { id, kind: 'execute', backend: tab.backend, model: null, outcome: '', scope: ['.'], checks: [], dependencies: draft.tasks.slice(-1).map(task => task.id) }] }); }}>+ Add</button>
      <span className="crew-note" />
      <button type="button" className={`crew-btn${readOnly ? ' is-locked' : ''}`} title={lock} aria-disabled={readOnly} onClick={preview}>Save preview</button>
      <button type="button" className={`crew-btn crew-btn--primary${readOnly ? ' is-locked' : ''}`} title={lock} aria-disabled={readOnly} onClick={() => void create()}>Create</button>
    </div>
  </div>;
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'running') return <span className="crew-ico crew-ico--spin" aria-hidden><svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="rgb(255 255 255 / .12)" strokeWidth="1.6" /><circle cx="8" cy="8" r="6.5" fill="none" stroke="#5fd49a" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="11 30" /></svg></span>;
  if (status === 'done') return <span className="crew-ico crew-ico--done" aria-hidden>✓</span>;
  if (status === 'failed' || status === 'limit') return <span className="crew-ico crew-ico--bad" aria-hidden>×</span>;
  if (status === 'approval') return <span className="crew-ico crew-ico--ask" aria-hidden>?</span>;
  if (status === 'interrupted') return <span className="crew-ico crew-ico--bang" aria-hidden>!</span>;
  if (status === 'paused') return <span className="crew-ico crew-ico--pause" aria-hidden>‖</span>;
  return <span className="crew-ico crew-ico--wait" aria-hidden />;
}

function RunView({ tab, run, accessMode, reload }: { tab: ConversationTab; run: CrewRun; accessMode: string; reload: () => void }) {
  const { resumeConversation } = useStore();
  const readOnly = accessMode === 'read-only';
  const [openId, setOpenId] = useState<string | null>(null);
  const [picked, setPicked] = useState(false);
  const [showList, setShowList] = useState(run.status !== 'done');
  const [plans, setPlans] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState('');
  const label = runLabel(run.status);
  const running = run.tasks.find(task => task.kind === 'execute' && viewStatus(run, task) === 'running');
  const shown = picked ? openId : (running?.id ?? openId);
  useEffect(() => { setPicked(false); setShowList(run.status !== 'done'); setError(''); }, [run.id, run.status]);
  useEffect(() => {
    if (run.status !== 'running') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run.status, run.id]);
  async function act(op: string, extra: Record<string, unknown> = {}) {
    if (readOnly && op !== 'pause' && op !== 'stop') return;
    setBusy(op === 'retry' ? String(extra.taskId ?? op) : op);
    setError('');
    try {
      const result = await api.crewAction(tab.key, { runId: run.id, op, sessionFile: run.owner || tab.sessionPath, ...extra });
      if (!result.ok) throw new Error(result.error || 'Crew action failed');
      reload();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(''); }
  }
  const progress = progressLabel(run);
  const progressHot = progress === 'merge conflict' || progress === 'validation failed';
  const approval = run.tasks.find(task => task.status === 'awaiting_approval');
  const stopped = run.tasks.find(task => task.status === 'interrupted' || task.status === 'failed');
  // A validation or conflict block has only the error banner, so Resume stays usable.
  const blocker = label === 'blocked' && Boolean(approval || stopped);
  const files = diffFiles(run.diff || '');
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  const total = added + removed || 1;
  const retries = run.tasks.reduce((sum, task) => sum + Math.max(0, task.attempts - (task.attempts ? 1 : 0)), 0);
  const reviewer = mark(run.reviewer?.backend || 'grok');
  const verdict = (run.finalReview || '').replace(/CREW_VERDICT:\s*PASS\s*$/i, '').trim();
  const controls = label === 'running'
    ? [['pause', 'Pause'], ['stop', 'Stop']]
    : label === 'draft'
      ? [['start', 'Start']]
      : label === 'paused' || label === 'stopped'
        ? [['resume', 'Resume']]
        : label === 'blocked'
          ? [['resume', 'Resume']]
          : [];
  return <div className="crew-run">
    <div className="crew-run__head">
      <div className="crew-run__title">
        <strong title={run.request}>{run.request}</strong>
        <div className="crew-controls">{controls.map(([op, tip]) => {
          const primary = op === 'start' || (op === 'resume' && !blocker);
          const dim = blocker && op === 'resume';
          const title = readOnly && op !== 'pause' && op !== 'stop' ? 'Read-only session' : dim ? 'Resolve the blocker below to resume' : tip;
          return <button type="button" key={op} className={`crew-iconbtn${primary ? ' is-primary' : ''}${dim || (readOnly && op !== 'pause' && op !== 'stop') ? ' is-dim' : ''}`} title={title} aria-label={tip} onClick={() => { if (dim) return; void act(op === 'start' ? 'start' : op); }}>
            {op === 'pause' ? <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z" /></svg> : op === 'stop' ? <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M4 4h8v8H4z" /></svg> : <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M5 3.5v9l7-4.5z" /></svg>}
          </button>;
        })}</div>
      </div>
      <div className={`crew-status is-${label}`}>
        <i />{label}
        <span>{label === 'draft' ? 'not started' : elapsed(run.createdAt, label === 'running' ? now : run.updatedAt)}</span>
        {progress && <><span>·</span><span className={progressHot ? 'is-hot' : ''}>{progress}</span></>}
      </div>
    </div>
    {run.rationale && <p className="crew-note">{run.mode} · {run.rationale}</p>}
    {run.routingHistory?.map(record => <Transcript key={record.sessionKey} record={record} refresh={reload} />)}
    {(run.error || error) && <div className="crew-banner" role="alert"><span>!</span><div><strong>Run error</strong><p>{error || run.error}</p></div></div>}
    {approval && <div className="crew-block">
      <div className="crew-block__title"><i /><strong>Plan needs your approval</strong><span>{approval.id} · <em style={{ color: mark(approval.backend).c }}>{mark(approval.backend).g}</em> {approval.model?.id || approval.backend}</span></div>
      <p>Edit before approving. {run.tasks.filter(task => task.kind === 'execute').map(task => task.id).join(', ') || 'Builders'} receive this text as their plan.</p>
      <textarea rows={9} value={plans[approval.id] ?? approval.report ?? ''} aria-label="Plan to approve" onChange={event => setPlans({ ...plans, [approval.id]: event.target.value })} />
      <button type="button" className={`crew-block__go${readOnly ? ' is-locked' : ''}`} title={readOnly ? 'Read-only session' : undefined} onClick={() => { if (!readOnly) void act('approve', { taskId: approval.id, plan: plans[approval.id] ?? approval.report ?? '' }); }}>Approve plan</button>
    </div>}
    {stopped && !approval && <div className="crew-block">
      <div className="crew-block__title">
        <i />
        <strong>{stopped.status === 'interrupted' ? `${stopped.id} was interrupted` : `${stopped.id} failed on attempt ${Math.min(3, stopped.attempts)} of 3`}</strong>
        <span className="crew-pips" title="Attempts">{[0, 1, 2].map(pip => <i key={pip} className={pip < stopped.attempts ? 'is-used' : ''} />)}</span>
        <span>{Math.min(3, stopped.attempts)} of 3</span>
      </div>
      <p>{stopped.error || 'The assignment stopped. Changes are retained.'}</p>
      {stopped.attempts < 3 && <button type="button" className={`crew-block__go${readOnly ? ' is-locked' : ''}`} title={readOnly ? 'Read-only session' : undefined} onClick={() => { if (!readOnly) void act('retry', { taskId: stopped.id }); }}>{busy === stopped.id ? 'Retrying' : 'Retry'} · attempt {stopped.attempts + 1} of 3</button>}
    </div>}
    {run.status === 'done' && <div className="crew-done">
      <div className="crew-verdict">
        <div><strong>✓ Reviewer approved</strong><span><em style={{ color: reviewer.c }}>{reviewer.g}</em> {run.reviewer?.model?.id || run.reviewer?.backend}</span></div>
        <p>{verdict.split(/(?<=\.)\s/)[0] || 'The reviewer accepted the combined outcome.'}</p>
      </div>
      <div className="crew-diff">
        <div className="crew-diff__head"><strong>Combined diff</strong><span className="crew-diff__bar"><i style={{ width: `${added / total * 100}%` }} /><i style={{ width: `${removed / total * 100}%` }} /></span><b>+{added}</b><s>−{removed}</s><em>{files.length} {files.length === 1 ? 'file' : 'files'}</em></div>
        {files.map(file => <div key={`${file.dir}${file.name}`} className="crew-diff__row"><span className={file.status === 'A' ? 'is-a' : 'is-m'}>{file.status}</span><span><b>{file.name}</b> <em>{file.dir}</em></span><span><b>+{file.added || ''}</b> <s>{file.removed ? `−${file.removed}` : ''}</s></span></div>)}
        {!files.length && <p className="crew-empty">No file changes</p>}
      </div>
      <div className="crew-summary">
        <span>{run.tasks.length} assignments · {retries} {retries === 1 ? 'retry' : 'retries'} · {run.repairs || 0} {(run.repairs || 0) === 1 ? 'repair' : 'repairs'} · {elapsed(run.createdAt, run.updatedAt)}</span>
        <button type="button" onClick={() => setShowList(value => !value)}>{showList ? 'Hide assignments' : 'Show assignments'}</button>
      </div>
    </div>}
    {showList && <div className="crew-rows">{run.tasks.map(task => {
      const status = viewStatus(run, task);
      const word = statusWord(status);
      const glyph = mark(task.backend);
      const waiting = task.dependencies.filter(id => run.tasks.find(item => item.id === id)?.status !== 'accepted');
      const active = status === 'running';
      const open = shown === task.id;
      const passed = task.gate?.results.filter(result => result.ok).length ?? 0;
      const transcript = [...task.history].reverse().find(record => record.sessionPath);
      return <div key={task.id} className={open ? 'is-open' : ''}>
        <button type="button" className="crew-row" onClick={() => { setPicked(true); setOpenId(open ? null : task.id); }}>
          <StatusIcon status={status} />
          <span className="crew-row__main"><span className="crew-id">{task.id}</span><span>{task.outcome}</span></span>
          <span className={`crew-word is-${status}`}>{word}</span>
          <span className="crew-row__meta">
            <span>{task.kind}</span>
            <span><em style={{ color: glyph.c }}>{glyph.g}</em> {task.model?.id || task.backend}</span>
            {active && <span>attempt {task.attempts} of 3</span>}
            {active && task.checks.length > 0 && <span>{passed}/{task.checks.length} checks</span>}
            {waiting.length > 0 && <span>waiting on {waiting.join(', ')}</span>}
          </span>
        </button>
        {open && <div className="crew-detail">
          {status === 'running' && task.attempts > 1 && <p className="is-fail">{task.lastFailure?.error || task.error || 'The previous attempt failed.'}</p>}
          {(status === 'waiting' || status === 'queued') && <p>{status === 'waiting' ? `Not started, waiting on ${waiting.join(', ')}.` : 'Not started.'}</p>}
          {active && <p>{task.outcome}</p>}
          {task.gate?.results.map(result => <div key={result.command} className="crew-tool"><span>bash</span><span>$ {result.command}</span><span className={result.ok ? 'is-ok' : 'is-bad'}>{result.ok ? 'passed' : 'failed'}</span></div>)}
          {(status === 'done' || status === 'approval') && task.report && <p>{task.report}</p>}
          {task.history.map(record => <Transcript key={record.sessionKey} record={record} refresh={reload} />)}
          <button type="button" className="crew-link" title="Open transcript" onClick={() => { if (transcript?.sessionPath) resumeConversation({ path: transcript.sessionPath, cwd: transcript.cwd, name: `Crew ${task.id}`, backend: transcript.backend, createdAt: 0, modifiedAt: Date.now(), messageCount: 0 }); }}>Open transcript ↗</button>
        </div>}
      </div>;
    })}</div>}
  </div>;
}

function CrewGlyph() {
  return <svg className="crew-v__mark" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="8" cy="3.5" r="2" /><circle cx="3.5" cy="12" r="2" /><circle cx="12.5" cy="12" r="2" /><path d="M7 5.3 4.4 10.2M9 5.3l2.6 4.9" /></svg>;
}

function brief(text: string | undefined, max = 220) {
  const line = (text || '').replace(/\s+/g, ' ').trim();
  if (!line) return '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function idSpan(ids: string[]) {
  const nums = ids.map(id => Number(/^AC(\d+)$/.exec(id)?.[1]));
  if (ids.length && nums.every((n, index) => Number.isFinite(n) && n === nums[0] + index)) return ids.length === 1 ? ids[0] : `${ids[0]}–${ids[ids.length - 1]}`;
  return ids.join(' ');
}

function stepText(step?: CrewStepModel | null) {
  if (!step?.backend) return '';
  const name = step.model?.id || step.backend;
  return step.effort ? `${name} · ${step.effort}` : name;
}

function dotKind(status: string) {
  if (status === 'done' || status === 'accepted') return 'done';
  if (status === 'running' || status === 'approval') return 'run';
  if (status === 'failed' || status === 'limit' || status === 'interrupted' || status === 'conflict') return 'bad';
  return 'wait';
}

function taskClock(task: CrewTask, now: number, doneAt?: number) {
  const record = task.history.at(-1) as { startedAt?: number; endedAt?: number } | undefined;
  if (!record?.startedAt) return '';
  const end = task.status === 'accepted' ? (record.endedAt || doneAt) : now;
  return elapsed(record.startedAt, end);
}

function checkLabel(task: CrewTask) {
  const results = task.gate?.results ?? [];
  if (!results.length) return task.checks.length ? '—' : '';
  const passed = results.filter(result => result.ok).length;
  if (results.every(result => result.ok)) return 'passed';
  return `${passed}/${results.length}`;
}

type RelayStage = { name: string; hint: string; state: 'done' | 'now' | 'wait' };

function checkNames(checks: string[]) {
  return checks.map(command => {
    const npm = command.match(/\b(?:npm|pnpm|yarn|bun)\s+run\s+(\S+)/);
    if (npm) return npm[1];
    if (/diff --check/.test(command)) return 'diff check';
    return command;
  });
}

function checkPhrase(checks: string[] | undefined, gate?: { ok?: boolean }) {
  const names = checkNames(checks ?? []);
  if (!names.length) return '';
  const list = names.join(', ');
  if (!gate) return list;
  return `${list} ${gate.ok ? 'passed' : 'failed'}`;
}

function relayStages(run: CrewRun, decisions?: CrewDecisions, models?: CrewRun['models']): RelayStage[] {
  const phase = run.status === 'done' ? 'done' : (run.phase || 'lead');
  const workers = (run.tasks ?? []).filter(task => task.kind === 'execute');
  const accepted = workers.filter(task => task.status === 'accepted').length;
  const planned = workers.length || run.investigation?.workers?.length || 0;
  const checks = decisions?.checks ?? [];
  const named = checkNames(checks);
  const keys: { key: string; name: string }[] = [{ key: 'lead', name: 'Lead' }];
  if (decisions?.investigate === 'plan') keys.push({ key: 'plan', name: 'Plan' });
  else if (decisions?.investigate === 'diagnose') keys.push({ key: 'plan', name: 'Diagnose' });
  keys.push({ key: 'build', name: 'Build' });
  if (planned > 1) keys.push({ key: 'merge', name: 'Merge' });
  if (named.length) keys.push({ key: 'checks', name: 'Checks' });
  keys.push({ key: 'integrate', name: 'Integrator' });
  if (decisions?.prosecute) keys.push({ key: 'prosecute', name: 'Prosecute' });
  if (decisions?.review) keys.push({ key: 'review', name: 'Review' });
  const phaseKey: Record<string, string> = {
    lead: 'lead', criteria: 'lead',
    investigating: 'plan', split: 'plan',
    building: 'build',
    merging: planned > 1 ? 'merge' : (named.length ? 'checks' : 'integrate'),
    combined_checks: named.length ? 'checks' : 'integrate',
    combined_validation: named.length ? 'checks' : 'integrate',
    integrating: 'integrate',
    prosecuting: decisions?.prosecute ? 'prosecute' : 'integrate',
    fixing: decisions?.review ? 'review' : 'integrate',
    reviewing: 'review', review_gate: 'review',
  };
  const current = phaseKey[phase] ?? 'build';
  const found = keys.findIndex(stage => stage.key === current);
  const at = found >= 0 ? found : keys.length - 1;
  const you = run.status === 'awaiting_input';
  return keys.map((stage, index) => {
    const state = at > index ? 'done' : at === index ? 'now' : 'wait';
    let hint = '';
    if (stage.key === 'lead') hint = state === 'now' ? (you ? 'you approve' : 'reading') : (run.lead?.backend || '');
    if (stage.key === 'plan') hint = state === 'now' && you ? 'you approve' : stepText(models?.investigator);
    if (stage.key === 'build') {
      if (state === 'wait') hint = planned > 1 ? `${stepText(models?.builder)} ×${planned}`.trim() : stepText(models?.builder);
      else hint = workers.length ? `${accepted} of ${workers.length}` : stepText(models?.builder);
    }
    if (stage.key === 'merge') hint = 'server';
    if (stage.key === 'checks') hint = state === 'now' && run.gate ? (run.gate.ok ? 'passed' : 'failed') : brief(named.join(', '), 42);
    if (stage.key === 'integrate') hint = stepText(models?.builder);
    if (stage.key === 'prosecute') hint = state === 'now' && you ? `round ${run.prosecution?.round || ''}`.trim() : state === 'done' && run.prosecution?.round ? `${run.prosecution.round} rounds` : stepText(models?.prosecutor);
    if (stage.key === 'review') hint = state === 'now' ? (you ? 'you decide' : phase === 'fixing' ? 'fixing' : (stepText(models?.reviewer) || 'reading')) : state === 'done' && run.reviews?.length ? `${run.reviews.length} ${run.reviews.length === 1 ? 'pass' : 'passes'}` : stepText(models?.reviewer);
    return { name: stage.name, hint, state };
  });
}

function Relay({ stages }: { stages: RelayStage[] }) {
  return <nav className="crew-v__relay" aria-label="Crew stages">
    {stages.map((stage, index) => <span key={`${stage.name}-${index}`} className="crew-v__relay-item">
      {index > 0 && <span className="crew-v__arrow" aria-hidden="true">→</span>}
      <span className={`crew-v__seg is-${stage.state}`}>
        {stage.state === 'done' ? '✓ ' : null}
        {stage.state === 'now' ? <i className="crew-v__live" /> : null}
        {stage.name}{stage.hint ? <em>{stage.hint}</em> : null}
      </span>
    </span>)}
  </nav>;
}

function ModelField({ label, catalog, value, readersOnly, disabled, onPick }: {
  label: string;
  catalog: Record<string, ModelInfo[]>;
  value: CrewStepModel;
  readersOnly: boolean;
  disabled?: boolean;
  onPick: (step: CrewStepModel) => void;
}) {
  const options: { value: string; backend: AgentBackend; model: { provider: string; id: string } | null; text: string }[] = [];
  BACKENDS.forEach(backend => {
    if (readersOnly && !READERS.has(backend)) return;
    const glyph = mark(backend);
    const models = catalog[backend] ?? [];
    const rows = models.length ? models : [{ id: '', provider: '', name: backend } as ModelInfo];
    rows.forEach((model, index) => {
      const ref = model.id ? { provider: model.provider, id: model.id } : null;
      const current = value.backend === backend && (value.model?.id || '') === (ref?.id || '') && (value.model?.provider || '') === (ref?.provider || '');
      options.push({
        value: `${backend}\t${ref?.provider || ''}\t${ref?.id || ''}\t${index}`,
        backend,
        model: ref,
        text: `${glyph.g} ${model.name || model.id || backend}${current && value.effort ? ` · ${value.effort}` : ''}`,
      });
    });
  });
  const match = options.find(option => option.backend === value.backend && (option.model?.id || '') === (value.model?.id || '') && (option.model?.provider || '') === (value.model?.provider || ''));
  if (!match) {
    const glyph = mark(value.backend);
    options.unshift({ value: `${value.backend}\tcurrent`, backend: value.backend, model: value.model ?? null, text: `${glyph.g} ${value.model?.id || value.backend}` });
  }
  const selected = (match || options[0])?.value || '';
  return <label className="crew-v__pick">
    <span className="sr-only">{label}</span>
    <select className="crew-v__field" aria-label={label} disabled={disabled || !options.length} value={selected} onChange={event => {
      const picked = options.find(option => option.value === event.target.value);
      if (picked) onPick({ backend: picked.backend, model: picked.model, effort: value.effort });
    }}>
      {options.map(option => <option key={option.value} value={option.value}>{option.text}</option>)}
    </select>
  </label>;
}

function Activity({ run }: { run: CrewRun }) {
  const events = run.events ?? [];
  if (!events.length) return null;
  return <details className="crew-activity"><summary>Activity · {events.length}</summary>{events.map((event, index) => {
    const trail = [activityCriteria(event), activityDelta(event), activityModels(event)].filter(Boolean).join(' · ');
    return <p key={`${event.at}-${index}`}><time>{new Date(event.at).toLocaleTimeString()}</time> {event.text}{trail ? <span className="crew-muted"> {trail}</span> : null}</p>;
  })}</details>;
}

function AutonomousView({ tab, run, accessMode, reload }: { tab: ConversationTab; run: CrewRun; accessMode: string; reload: () => void }) {
  const { resumeConversation, openConversation } = useStore();
  const readOnly = accessMode === 'read-only';
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [criteria, setCriteria] = useState(run.criteria ?? []);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [decisions, setDecisions] = useState<CrewDecisions | undefined>(run.decisions);
  const [picked, setPicked] = useState(run.models);
  const [note, setNote] = useState('');
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [workerModels, setWorkerModels] = useState<Record<string, CrewStepModel>>({});
  const [catalog, setCatalog] = useState<Record<string, ModelInfo[]>>({});
  const [now, setNow] = useState(() => Date.now());
  const [single, setSingle] = useState(false);
  const [openPanel, setOpenPanel] = useState<string | null>(null);
  const [pickedRow, setPickedRow] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  useEffect(() => {
    setCriteria(run.criteria ?? []);
    setDecisions(run.decisions);
    setPicked(run.models);
    setError('');
    const next: Record<string, boolean> = {};
    for (const finding of run.reviews?.at(-1)?.findings ?? []) next[finding.id] = Boolean(finding.selected);
    setChosen(next);
  }, [run.id, run.updatedAt, run.phase, run.reviews?.length]);
  useEffect(() => { setSingle(false); setPickedRow(null); setOpenPanel(null); setShowPrompt(false); setWorkerModels({}); setNote(''); }, [run.id]);
  useEffect(() => {
    if (run.status !== 'running' && run.status !== 'awaiting_input') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run.status, run.id]);
  useEffect(() => {
    let alive = true;
    for (const backend of BACKENDS) {
      void api.models(tab.key, backend).then(result => {
        if (alive && result.ok && Array.isArray(result.models)) setCatalog(current => ({ ...current, [backend]: result.models }));
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [tab.key]);
  async function act(op: string, extra: Record<string, unknown> = {}) {
    if (readOnly && op !== 'pause' && op !== 'stop') return;
    setBusy(op); setError('');
    try {
      const result = await api.crewAction(tab.key, { runId: run.id, op, sessionFile: run.owner || tab.sessionPath, ...extra });
      if (!result.ok) throw new Error(result.error || 'Crew action failed');
      reload();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(''); }
  }
  const lock = readOnly ? 'Read-only session' : undefined;
  const phase = run.phase || 'lead';
  const done = run.status === 'done';
  const questions = run.questions ?? [];
  const unanswered = questions.some(question => !(answers[question.id] ?? question.answer)?.trim());
  const lead = run.leadDecisions;
  const workers = (run.tasks ?? []).filter(task => task.kind === 'execute');
  const latest = run.reviews?.at(-1);
  const passes = run.reviews?.length ?? 0;
  const criteriaGate = phase === 'criteria' && run.status === 'awaiting_input' && Boolean(decisions);
  const splitGate = phase === 'split' && run.status === 'awaiting_input';
  const reviewGate = phase === 'review_gate' && run.status === 'awaiting_input' && Boolean(latest);
  const proPause = phase === 'prosecuting' && run.status === 'awaiting_input';
  const showBuild = !done && ['building', 'merging', 'combined_checks', 'combined_validation'].includes(phase);
  const showProsecute = !done && ['integrating', 'prosecuting', 'fixing'].includes(phase);
  const showReview = !done && ['reviewing', 'review_gate'].includes(phase);
  const ask = !done && ['awaiting_input', 'awaiting_approval', 'blocked'].includes(run.status);
  const clock = elapsed(run.createdAt, run.status === 'running' || run.status === 'awaiting_input' ? now : run.updatedAt);
  const files = diffFiles(run.diff || '');
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  // Lead, criteria, investigation, and the split gate are the setup. The stage
  // strip starts once those are finished and the run is building (or later).
  // A concern bounce returns phase to criteria, which hides the strip again.
  const stagesReady = !done && !['lead', 'criteria', 'investigating', 'split'].includes(phase);
  const stages = stagesReady ? relayStages(run, decisions, picked) : [];
  const pendingWorkers = workers.filter(worker => worker.status !== 'accepted');
  const chosenChecks = checkNames(decisions?.checks ?? []);
  const buildFoot = phase === 'combined_checks' && chosenChecks.length
    ? `Running ${chosenChecks.join(', ')}.`
    : pendingWorkers.length
      ? (workers.length > 1 ? `Merge starts when ${pendingWorkers.map(worker => worker.id).join(', ')} pass.` : `${pendingWorkers.map(worker => worker.id).join(', ')} still building.`)
      : (workers.length > 1 ? 'Merging the workers.' : 'Build finished.');
  const laterWork = [decisions?.prosecute ? 'Prosecution rounds' : '', decisions?.review ? 'review fixes' : ''].filter(Boolean).join(' and ');
  const leadGlyph = mark(run.lead?.backend || 'claude');
  const fallback = (reader: boolean): CrewStepModel => ({ backend: reader ? readerBackend(tab.backend) : tab.backend, model: null });
  const blocked = workers.filter(worker => ['failed', 'interrupted', 'conflict'].includes(worker.status));
  const taskBlock = blocked.length > 0;
  const running = run.status === 'running';
  function stopBtn(label: string) {
    return <button type="button" className="crew-v__btn crew-v__btn--stop" disabled={Boolean(busy)} onClick={() => void act('stop')}>{label}</button>;
  }
  let actions: ReactElement | null = null;
  if (done && run.integration?.path) {
    actions = <button type="button" className="crew-v__btn" onClick={() => openConversation(run.integration!.path, 'Crew worktree', run.models?.builder?.backend || tab.backend)}>Open worktree</button>;
  } else if (criteriaGate) actions = stopBtn('Discard');
  else if (running || proPause) {
    actions = <>
      {running && <button type="button" className="crew-v__btn" disabled={Boolean(busy)} onClick={() => void act('pause')}>Pause</button>}
      {stopBtn('Stop crew')}
    </>;
  } else if (['paused', 'stopped', 'blocked'].includes(run.status) && !taskBlock) {
    actions = <button type="button" className="crew-v__btn" title={lock} disabled={readOnly || Boolean(busy)} onClick={() => { if (!readOnly) void act('resume'); }}>Resume</button>;
  } else if (!done) actions = stopBtn('Stop crew');
  const doneBits = [
    workers.length ? `${workers.length} ${workers.length === 1 ? 'worker' : 'workers'}` : '',
    run.prosecution?.round ? `${run.prosecution.round} prosecution ${run.prosecution.round === 1 ? 'round' : 'rounds'}` : '',
    passes ? `${passes} review ${passes === 1 ? 'pass' : 'passes'}` : '',
    elapsed(run.createdAt, run.updatedAt),
  ].filter(Boolean).join(' · ');
  function togglePanel(id: string) { setOpenPanel(current => current === id ? null : id); }
  function leadMark(text: string | null) { return text ? <span className="crew-v__lead"> · lead: {text}</span> : null; }
  const criteriaIds = (run.criteria ?? []).map(item => item.id);
  const proposed = run.investigation?.workers ?? [];
  const shownWorkers = single
    ? [{ id: 'W1', outcome: run.request, scope: ['.'], covers: criteriaIds }]
    : proposed;
  const selectedIds = Object.entries(chosen).filter(([, on]) => on).map(([id]) => id);
  const rowId = pickedRow || (showProsecute ? 'integrator' : (workers.find(worker => viewStatus(run, worker) === 'running')?.id || workers[0]?.id || 'merge'));
  const selectedTask = workers.find(worker => worker.id === rowId);
  const transcriptOf = (task?: CrewTask) => [...(task?.history ?? [])].reverse().find(record => record.sessionPath);
  const openTranscript = (task: CrewTask) => {
    const record = transcriptOf(task);
    if (!record?.sessionPath) return;
    resumeConversation({ path: record.sessionPath, cwd: record.cwd, name: `Crew ${task.id}`, backend: record.backend, createdAt: 0, modifiedAt: Date.now(), messageCount: 0 });
  };

  const criteriaForm = criteriaGate && decisions && <div className="crew-v__stack" style={{ gap: 16 }}>
    {run.summary && <p>{run.summary}</p>}
    <div className="crew-v__handoff"><span /><span>Lead · {leadGlyph.g} {run.lead?.backend || 'reader'} · read-only{clock ? ` · ${clock}` : ''}</span><span /></div>
    <div className="crew-v__stack">
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}><span className="crew-v__lbl">Acceptance criteria</span><span className="crew-v__dim" style={{ fontSize: 11.5 }}>every step is judged against these</span></div>
      {criteria.map((item, index) => <div key={item.id} className="crew-v__ac">
        <span className="crew-v__id">{item.id}</span>
        <input aria-label={`Criterion ${item.id}`} value={item.text} onChange={event => setCriteria(criteria.map((row, at) => at === index ? { ...row, text: event.target.value, source: row.text === event.target.value ? row.source : 'user' } : row))} />
        <button type="button" className="crew-v__icon" aria-label={`Remove ${item.id}`} onClick={() => setCriteria(criteria.filter(row => row.id !== item.id))}>×</button>
      </div>)}
      <button type="button" className="crew-v__btn" style={{ alignSelf: 'flex-start', height: 26, fontSize: 12 }} disabled={criteria.length >= 12} onClick={() => setCriteria([...criteria, { id: nextCriterionId(criteria), text: '', source: 'user' }])}>+ Add criterion</button>
    </div>
    {questions.map(question => {
      const value = answers[question.id] ?? question.answer ?? '';
      return <div key={question.id} className="crew-v__stack">
        <span className="crew-v__lbl">{questions.length > 1 ? 'Question' : 'One question'}</span>
        <div className="crew-v__q">
          <span><span className="crew-v__id" style={{ color: '#f5c77e' }}>{question.id}</span> {question.question}</span>
          {(question.options ?? []).length > 0
            ? <div className="crew-v__pills" role="group" aria-label={`Answer ${question.id}`}>
              {(question.options ?? []).map(option => <button type="button" key={option} className={`crew-v__pill${value === option ? ' is-on' : ''}`} aria-pressed={value === option} onClick={() => setAnswers({ ...answers, [question.id]: option })}>{option}</button>)}
            </div>
            : <input className="crew-v__field" aria-label={question.question} value={value} onChange={event => setAnswers({ ...answers, [question.id]: event.target.value })} />}
        </div>
      </div>;
    })}
    {(run.assumptions ?? []).length > 0 && <span className="crew-v__dim" style={{ fontSize: 12 }}>Assuming: {run.assumptions?.join(' · ')}</span>}
    <div className="crew-v__steps">
      <div className="crew-v__step crew-v__step--head"><span className="crew-v__lbl">Step</span><span className="crew-v__lbl">Lead's reason</span><span className="crew-v__lbl">Model</span></div>
      <div className="crew-v__step">
        <div className="crew-v__stack">
          <span>Investigate</span>
          <div className="crew-v__seg3" role="group" aria-label="Investigate">
            {(['none', 'plan', 'diagnose'] as const).map(mode => <button type="button" key={mode} className={decisions.investigate === mode ? 'is-on' : ''} aria-pressed={decisions.investigate === mode} onClick={() => setDecisions({ ...decisions, investigate: mode })}>{mode === 'none' ? 'None' : mode === 'plan' ? 'Plan' : 'Diagnose'}</button>)}
          </div>
        </div>
        <span className="crew-v__dim">{decisions.investigateWhy}{leadMark(lead && decisions.investigate !== lead.investigate ? lead.investigate : null)}</span>
        <ModelField label="Investigator model" catalog={catalog} value={picked?.investigator ?? fallback(true)} readersOnly disabled={decisions.investigate === 'none'} onPick={step => setPicked({ ...picked, investigator: step })} />
      </div>
      <div className="crew-v__step">
        <span>Build</span>
        <span className="crew-v__dim">Always on. Workers come from the plan.</span>
        <ModelField label="Builder model" catalog={catalog} value={picked?.builder ?? fallback(false)} readersOnly={false} onPick={step => setPicked({ ...picked, builder: step })} />
      </div>
      <div className="crew-v__step">
        <div className="crew-v__name"><button type="button" className={`crew-v__tog${decisions.prosecute ? ' is-on' : ''}`} aria-pressed={decisions.prosecute} aria-label="Prosecution" onClick={() => setDecisions({ ...decisions, prosecute: !decisions.prosecute })}><span /></button><span>Prosecution</span></div>
        <span className="crew-v__dim">{decisions.prosecuteWhy}{leadMark(lead && decisions.prosecute !== lead.prosecute ? (lead.prosecute ? 'on' : 'off') : null)}</span>
        <ModelField label="Prosecutor model" catalog={catalog} value={picked?.prosecutor ?? fallback(true)} readersOnly disabled={!decisions.prosecute} onPick={step => setPicked({ ...picked, prosecutor: step })} />
      </div>
      <div className="crew-v__step">
        <span>Checks</span>
        <div className="crew-v__checks">
          {(run.checkMenu ?? decisions.checks).map(command => <label key={command} className="crew-v__check"><input type="checkbox" checked={decisions.checks.includes(command)} onChange={event => setDecisions({ ...decisions, checks: event.target.checked ? [...decisions.checks, command] : decisions.checks.filter(item => item !== command) })} />{command}</label>)}
        </div>
        <span className="crew-v__dim" style={{ fontSize: 11.5 }}>Server runs these. Menu only.</span>
      </div>
      <div className="crew-v__step">
        <div className="crew-v__name"><button type="button" className={`crew-v__tog${decisions.review ? ' is-on' : ''}`} aria-pressed={decisions.review} aria-label="Final review" onClick={() => setDecisions({ ...decisions, review: !decisions.review })}><span /></button><span>Final review</span></div>
        <span className="crew-v__dim">{decisions.reviewWhy}{leadMark(lead && decisions.review !== lead.review ? (lead.review ? 'on' : 'off') : null)}</span>
        <ModelField label="Reviewer model" catalog={catalog} value={picked?.reviewer ?? fallback(true)} readersOnly disabled={!decisions.review} onPick={step => setPicked({ ...picked, reviewer: step })} />
      </div>
    </div>
  </div>;

  const splitForm = splitGate && <div className="crew-v__stack" style={{ gap: 14 }}>
    <div className="crew-v__line"><span>Criteria <span className="crew-v__dim">· {idSpan(criteriaIds)}{questions.some(question => question.answer) ? ` · ${questions.filter(question => question.answer).map(question => `${question.id}: ${question.answer}`).join(' · ')}` : ''}</span></span><button type="button" className="crew-v__text" aria-expanded={openPanel === 'criteria'} onClick={() => togglePanel('criteria')}>{openPanel === 'criteria' ? 'Hide' : 'Show'}</button></div>
    {openPanel === 'criteria' && <div className="crew-v__stack">{(run.criteria ?? []).map(item => <div key={item.id} className="crew-v__line"><span className="crew-v__id">{item.id}</span><span>{item.text}</span></div>)}</div>}
    <div className="crew-v__handoff"><span /><span>Handed to {stepText(run.models?.investigator) || run.models?.investigator?.backend || 'the planner'} · request + criteria · read-only</span><span /></div>
    {run.investigation?.approach && <div className="crew-v__stack"><span className="crew-v__lbl">Approach</span><p>{run.investigation.approach}</p></div>}
    {(run.investigation?.concerns ?? []).length > 0 && <p className="crew-v__dim">{run.investigation?.concerns?.join(' · ')}</p>}
    <div className="crew-v__steps">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', flexWrap: 'wrap' }}>
        <strong>{single ? 'One worker' : `${shownWorkers.length} parallel ${shownWorkers.length === 1 ? 'worker' : 'workers'}`}</strong>
        <span className="crew-v__dim" style={{ fontSize: 12 }}>{single ? 'whole repository, no merge step' : 'separate files · own worktree each'}</span>
        <span className="crew-v__grow" />
        {(run.investigation?.concerns ?? []).length === 0 && <span className="crew-v__chip crew-v__covered">✓ every criterion covered</span>}
      </div>
      <div className="crew-v__table"><div>
        <div className="crew-v__worker" style={{ paddingTop: 6, paddingBottom: 6 }}><span className="crew-v__lbl">ID</span><span className="crew-v__lbl">Outcome</span><span className="crew-v__lbl">Files</span><span className="crew-v__lbl">Covers</span><span className="crew-v__lbl">Builder</span></div>
        {shownWorkers.map(worker => {
          const current = workerModels[worker.id] ?? picked?.builder ?? fallback(false);
          return <div key={worker.id} className="crew-v__worker">
            <span className="crew-v__id">{worker.id}</span>
            <span style={{ lineHeight: 1.45 }}>{worker.outcome}</span>
            <span className="crew-v__dim crew-v__mono" style={{ fontSize: 11.5 }}>{worker.scope.join(', ')}</span>
            <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{(worker.covers ?? []).map(id => <span key={id} className="crew-v__tag">{id}</span>)}</span>
            {single
              ? <span className="crew-v__dim">{stepText(picked?.builder ?? fallback(false))}</span>
              : <ModelField label={`Model for ${worker.id}`} catalog={catalog} value={current} readersOnly={false} onPick={step => setWorkerModels({ ...workerModels, [worker.id]: step })} />}
          </div>;
        })}
      </div></div>
    </div>
    {!single && <div className="crew-v__split">
      <div className="crew-v__panel"><span className="crew-v__lbl">Shared contract</span><span className="crew-v__mono" style={{ fontSize: 12, lineHeight: 1.6 }}>{run.investigation?.contract || 'Workers share only the criteria.'}</span></div>
      <div className="crew-v__panel">
        <span className="crew-v__lbl">{shownWorkers.length === 2 ? 'After both finish' : 'After the workers finish'}</span>
        <span className="crew-v__lane"><b>Merge</b><span className="crew-v__dim">server cherry-picks {shownWorkers.map(worker => worker.id).join(', ') || 'the workers'}</span></span>
        <span className="crew-v__lane"><b>Integrator</b><span className="crew-v__dim">one new {stepText(picked?.builder) || 'builder'} session takes the merged code to the end</span></span>
      </div>
    </div>}
  </div>;

  const buildTable = showBuild && <div className="crew-v__stack">
    <div className="crew-v__line"><span>Criteria <span className="crew-v__dim">· {idSpan(criteriaIds)}</span></span><button type="button" className="crew-v__text" aria-expanded={openPanel === 'criteria'} onClick={() => togglePanel('criteria')}>{openPanel === 'criteria' ? 'Hide' : 'Show'}</button></div>
    {openPanel === 'criteria' && (run.criteria ?? []).map(item => <div key={item.id} className="crew-v__line"><span className="crew-v__id">{item.id}</span><span>{item.text}</span></div>)}
    {decisions?.investigate && decisions.investigate !== 'none' && <div className="crew-v__line"><span>{decisions.investigate === 'diagnose' ? 'Diagnose' : 'Plan'} <span className="crew-v__dim">· {workers.length || proposed.length} workers{run.investigation?.contract ? ` · ${brief(run.investigation.contract, 80)}` : ''}</span></span><button type="button" className="crew-v__text" aria-expanded={openPanel === 'plan'} onClick={() => togglePanel('plan')}>{openPanel === 'plan' ? 'Hide' : 'Show'}</button></div>}
    {openPanel === 'plan' && decisions?.investigate !== 'none' && run.investigation?.approach && <p>{run.investigation.approach}</p>}
    <div className="crew-v__table"><div>
      <div className="crew-v__row crew-v__rowhead is-quiet" aria-hidden="true"><span /><span>ID</span><span>Doing</span><span>Builder</span><span>Checks</span><span>Time</span></div>
      {workers.map(task => {
        const glyph = mark(task.backend);
        const status = viewStatus(run, task);
        const checks = checkLabel(task);
        const failed = task.gate?.results?.some(result => !result.ok);
        return <button type="button" key={task.id} className={`crew-v__row${rowId === task.id ? ' is-on' : ''}`} aria-pressed={rowId === task.id} onClick={() => setPickedRow(task.id)}>
          <span className={`crew-v__dot is-${dotKind(status)}`} aria-label={status} />
          <span className="crew-v__id">{task.id}</span>
          <span className="crew-v__ellip">{task.outcome}{task.scope.length > 0 && <span className="crew-v__sub">{task.scope.join(', ')}</span>}</span>
          <span className="crew-v__ellip"><span style={{ color: glyph.c }}>{glyph.g}</span> {task.model?.id || task.backend}</span>
          <span style={{ color: failed ? '#ff7a8a' : checks === 'passed' ? '#86e6b0' : undefined }}>{checks}</span>
          <span className="crew-v__dim crew-v__mono">{taskClock(task, now, run.updatedAt)}</span>
        </button>;
      })}
      <button type="button" className={`crew-v__row${rowId === 'integrator' ? ' is-on' : ''}${phase === 'building' ? ' is-quiet' : ''}`} onClick={() => setPickedRow('integrator')}>
        <span className={`crew-v__dot is-${phase === 'building' ? 'wait' : 'run'}`} />
        <span className="crew-v__id">Int</span>
        <span className="crew-v__ellip">Integrator<span className="crew-v__sub">{phase === 'building' ? 'not started' : 'owns the merged code'}</span></span>
        <span className="crew-v__ellip"><span style={{ color: mark(run.models?.builder?.backend || '').c }}>{mark(run.models?.builder?.backend || '').g}</span> {stepText(run.models?.builder)}</span>
        <span /><span />
      </button>
    </div></div>
  </div>;

  const prosecuteBody = showProsecute && <div className="crew-v__stack">
    <div className="crew-v__line"><span>Build <span className="crew-v__dim">· {workers.map(worker => worker.id).join(', ') || 'workers'}{files.length ? <> · <span className="crew-v__add">+{added}</span> <span className="crew-v__del">−{removed}</span></> : null}{run.gate ? ` · combined checks ${run.gate.ok ? 'passed' : 'failed'}` : ''}</span></span>{files.length > 0 && <button type="button" className="crew-v__text" aria-expanded={openPanel === 'diff'} onClick={() => togglePanel('diff')}>{openPanel === 'diff' ? 'Hide' : 'Open diff'}</button>}</div>
    {openPanel === 'diff' && files.map(file => <div key={`${file.dir}${file.name}`} className="crew-v__file"><span className="crew-v__mono" style={{ color: file.status === 'A' ? '#5fd49a' : '#f0b35a' }}>{file.status}</span><span className="crew-v__ellip crew-v__mono">{file.dir}{file.name}</span><span className="crew-v__mono"><span className="crew-v__add">+{file.added}</span> <span className="crew-v__del">−{file.removed}</span></span></div>)}
    <div className="crew-v__handoff"><span /><span>Handed to {stepText(run.models?.builder) || 'the integrator'} · new integrator session · criteria, plan, reports, merged diff</span><span /></div>
    {(run.integrator?.history ?? []).slice(-1).map(record => <div key={record.sessionKey} className="crew-v__turn"><span className="crew-v__who" style={{ color: '#b69cff' }}>{mark(record.backend).g} Integrator</span><span className="crew-v__dim">{brief(record.report, 240) || 'Reading the merged diff.'}</span></div>)}
    {run.decisions?.prosecute && <div className="crew-v__handoff"><span /><span>Prosecutor · {stepText(run.models?.prosecutor) || run.models?.prosecutor?.backend || 'reader'} · spec = {idSpan(criteriaIds) || 'the criteria'}</span><span /></div>}
    {(run.prosecution?.log ?? []).map((entry, index) => <div key={`${entry.round}-${index}`} className="crew-v__round">
      <span className="crew-v__dim crew-v__mono" style={{ fontSize: 11.5 }}>Round {entry.round || index + 1}</span>
      <div className="crew-v__turn"><span className="crew-v__who" style={{ color: /prosecutor/i.test(entry.by || '') ? '#8fb4ff' : '#b69cff' }}>{entry.by || 'Crew'}</span><span>{brief(entry.report, 280) || 'Working.'}</span></div>
    </div>)}
    {proPause && <div className="crew-v__pause" role="group" aria-label="Prosecution paused">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <strong>Round {run.prosecution?.round ?? 5}: the prosecutor still finds a bug</strong>
        <span className="crew-v__pips" aria-label={`${run.prosecution?.round ?? 5} rounds used`}>{Array.from({ length: Math.min(10, run.prosecution?.round || 5) }, (_, index) => <i key={index} />)}</span>
        <span className="crew-v__dim" style={{ fontSize: 12 }}>rounds stop at 10 whatever you pick</span>
      </div>
      <p>{brief(run.prosecution?.lastReport, 280) || 'The same failure is still open. A redesign rewrites this part instead of patching it again.'}</p>
      <div className="crew-v__pills">
        <button type="button" className="crew-v__btn crew-v__btn--primary" title={lock} disabled={readOnly || Boolean(busy)} onClick={() => void act('prosecution-choice', { choice: 'redesign' })}>Redesign this part</button>
        <button type="button" className="crew-v__btn" title={lock} disabled={readOnly || Boolean(busy)} onClick={() => void act('prosecution-choice', { choice: 'continue' })}>Continue 3 more rounds</button>
        <button type="button" className="crew-v__btn" title={lock} disabled={readOnly || Boolean(busy)} onClick={() => void act('prosecution-choice', { choice: 'accept' })}>Accept as is</button>
      </div>
    </div>}
  </div>;

  const reviewBody = showReview && <div className="crew-v__stack">
    <div className="crew-v__line"><span>Changes <span className="crew-v__dim">· {files.length} {files.length === 1 ? 'file' : 'files'}{files.length ? <> · <span className="crew-v__add">+{added}</span> −{removed}</> : null}{checkPhrase(decisions?.checks, run.gate) ? ` · ${checkPhrase(decisions?.checks, run.gate)}` : ''}</span></span>{files.length > 0 && <button type="button" className="crew-v__text" onClick={() => togglePanel('diff')}>{openPanel === 'diff' ? 'Hide' : 'Open diff'}</button>}</div>
    {openPanel === 'diff' && files.map(file => <div key={`${file.dir}${file.name}`} className="crew-v__file"><span className="crew-v__mono" style={{ color: file.status === 'A' ? '#5fd49a' : '#f0b35a' }}>{file.status}</span><span className="crew-v__ellip crew-v__mono">{file.dir}{file.name}</span><span className="crew-v__mono"><span className="crew-v__add">+{file.added}</span> <span className="crew-v__del">−{file.removed}</span></span></div>)}
    {run.decisions?.prosecute && <div className="crew-v__line"><span>Prosecution <span className="crew-v__dim">· {run.prosecution?.status || 'finished'}{run.prosecution?.round ? ` · round ${run.prosecution.round}` : ''}</span></span></div>}
    <div className="crew-v__handoff"><span /><span>Handed to {stepText(run.models?.reviewer) || run.models?.reviewer?.backend || 'the reviewer'} · fresh reviewer · read-only · whole crew diff{passes ? ` · pass ${Math.min(passes, latest?.pass || passes)} of 3` : ''}</span><span /></div>
    {latest?.verdicts && <div className="crew-v__verdicts" aria-label="Verdict by criterion">
      {(run.criteria ?? []).map(item => {
        const pass = latest.verdicts?.[item.id] === 'pass';
        return <span key={item.id} className={`crew-v__verdict ${pass ? 'is-pass' : 'is-fail'}`}>{pass ? '✓' : '✕'} {item.id} {brief(item.text, 28)}</span>;
      })}
    </div>}
    {reviewGate && latest && <>
      <p>{(run.criteria ?? []).some(item => latest.verdicts?.[item.id] !== 'pass') ? `${(run.criteria ?? []).filter(item => latest.verdicts?.[item.id] !== 'pass').map(item => item.id).join(', ')} failed.` : 'Every criterion passed.'} {brief(latest.findings?.[0]?.text, 180)}</p>
      <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <legend className="sr-only">Findings to send</legend>
        {(latest.findings ?? []).map(finding => <label key={finding.id} className="crew-v__find">
          <input type="checkbox" checked={Boolean(chosen[finding.id])} onChange={event => setChosen({ ...chosen, [finding.id]: event.target.checked })} />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
            <span>{finding.text}</span>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="crew-v__dim crew-v__mono" style={{ fontSize: 11 }}>{finding.id}</span>
              <span className={`crew-v__sev is-${finding.severity}`}>{finding.severity}</span>
              {finding.criterion && <span className="crew-v__tag">{finding.criterion}</span>}
              {finding.file && <code className="crew-v__mono" style={{ fontSize: 11 }}>{finding.file}{finding.line ? `:${finding.line}` : ''}</code>}
            </span>
          </span>
        </label>)}
      </fieldset>
      <div className="crew-v__send">
        <label className="sr-only" htmlFor={`crew-note-${run.id}`}>Note for the integrator</label>
        <input id={`crew-note-${run.id}`} className="crew-v__note" placeholder="Add a note for the integrator…" value={note} onChange={event => setNote(event.target.value)} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="crew-v__chip"><span style={{ color: 'var(--acc)' }}>{mark(run.models?.builder?.backend || '').g}</span> to Integrator · same session</span>
          <span className="crew-v__dim" style={{ fontSize: 11.5 }}>then checks, then a re-review of only what changed</span>
          <span className="crew-v__grow" />
          <button type="button" className="crew-v__btn" title={lock} disabled={readOnly || Boolean(busy)} onClick={() => void act('accept-review')}>Accept as is</button>
          <button type="button" className="crew-v__btn crew-v__btn--primary" title={passes >= 3 ? 'Review pass limit reached' : lock} disabled={readOnly || Boolean(busy) || passes >= 3 || (selectedIds.length === 0 && !note.trim())} onClick={() => void act('send-findings', { ids: selectedIds, note })}>{selectedIds.length ? `Send ${selectedIds.length} ${selectedIds.length === 1 ? 'finding' : 'findings'}` : 'Send note'}</button>
        </div>
      </div>
    </>}
    {!reviewGate && <p>The reviewer is reading the diff against the criteria.</p>}
  </div>;

  const doneBody = done && <div className="crew-v__stack" style={{ gap: 0 }}>
    <div style={{ padding: '0 0 6px' }}><span className="crew-v__lbl">Acceptance criteria</span></div>
    {(run.criteria ?? []).map(item => {
      const verdict = run.reviews?.at(-1)?.verdicts?.[item.id];
      const pass = verdict !== 'fail';
      const credit = criterionCredit(run, item.id).split(' · ').filter(Boolean);
      return <div key={item.id} className="crew-v__acrow">
        <span style={{ color: pass ? '#86e6b0' : '#ff9aa6' }} aria-label={pass ? 'passed' : 'open'}>{pass ? '✓' : '✕'}</span>
        <span className="crew-v__id">{item.id}</span>
        <span>{item.text}</span>
        <span className="crew-v__by">{credit.map(bit => <span key={bit}>{bit}</span>)}</span>
      </div>;
    })}
    <div style={{ borderTop: '.5px solid rgb(var(--ink) / .07)', paddingTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px 6px', flexWrap: 'wrap' }}>
        <span className="crew-v__lbl">Combined diff</span>
        <span className="crew-v__mono"><span className="crew-v__add">+{added}</span> <span className="crew-v__del">−{removed}</span></span>
        <span className="crew-v__dim" style={{ fontSize: 12 }}>{files.length} {files.length === 1 ? 'file' : 'files'}{run.integration?.path ? ' · still in the crew worktree' : ''}</span>
      </div>
      {files.map(file => <div key={`${file.dir}${file.name}`} className="crew-v__file"><span className="crew-v__mono" style={{ color: file.status === 'A' ? '#5fd49a' : '#f0b35a' }}>{file.status}</span><span className="crew-v__ellip crew-v__mono" style={{ fontSize: 12 }}>{file.dir}{file.name}</span><span className="crew-v__mono" style={{ fontSize: 11.5 }}><span className="crew-v__add">+{file.added}</span> <span className="crew-v__del">−{file.removed}</span></span></div>)}
      {!files.length && <p className="crew-v__dim" style={{ padding: '0 14px 8px' }}>No file changes</p>}
    </div>
  </div>;

  const waiting = !done && !criteriaGate && !splitGate && !showBuild && !showProsecute && !showReview;
  const blurbs: Record<string, string> = {
    lead: 'Lead is reading the repository and writing acceptance criteria.',
    investigating: decisions?.investigate === 'diagnose' ? 'Diagnosing before anyone writes code.' : 'Planning the split. Nothing writes files yet.',
    merging: 'Merging the worker branches.',
    combined_checks: 'Running the combined checks.',
  };
  const asideTask = selectedTask;
  const asideTranscript = asideTask ? transcriptOf(asideTask) : [...(run.integrator?.history ?? [])].reverse().find(record => record.sessionPath);
  const showWorkerAside = Boolean(asideTask) && rowId !== 'integrator';
  const showIntegratorAside = !showWorkerAside && (rowId === 'integrator' || (showProsecute && !asideTask));
  const showAside = !done && (showBuild || showProsecute) && (showWorkerAside || showIntegratorAside);
  const liveLines = (asideTask?.report || asideTask?.history.at(-1)?.report || '').split('\n').map(line => line.trim()).filter(Boolean).slice(-5);

  return <div className="crew-v__layout">
    <div className="crew-v__request"><b>/crew</b> {run.request}</div>
    <div className={`crew-v__pair${ask ? ' is-ask' : ''}${done ? ' is-done' : ''}`}>
      <section className="crew-v" aria-label={done ? 'Crew run, done' : 'Crew run'}>
        <div className="crew-v__head">
          {done ? <span className="crew-v__ok" aria-hidden="true">✓</span> : <CrewGlyph />}
          <strong>{done ? 'Crew done' : 'Crew'}</strong>
          {done && <span className="crew-v__dim" style={{ fontSize: 12 }}>{doneBits}</span>}
          {criteriaGate && <span className="crew-v__chip"><span style={{ color: leadGlyph.c }}>{leadGlyph.g}</span> Lead · {run.lead?.backend || 'reader'}</span>}
          {showBuild && workers.length > 1 && <span className="crew-v__chip">parallel</span>}
          {!done && !criteriaGate && clock && <span className="crew-v__chip crew-v__mono">{clock}</span>}
          <span className="crew-v__grow" />
          {actions}
        </div>
        {stagesReady && <Relay stages={stages} />}
        <div className="crew-v__body" style={done ? { borderTop: 0, paddingTop: 0 } : undefined}>
          {(run.error || error) && <div className="crew-banner" role="alert"><span>!</span><div><strong>Run error</strong><p>{error || run.error}</p></div></div>}
          {criteriaForm}
          {splitForm}
          {buildTable}
          {prosecuteBody}
          {reviewBody}
          {doneBody}
          {waiting && <p>{blurbs[phase] || 'Crew is working.'}</p>}
          {!done && blocked.map(worker => <div key={worker.id} className="crew-v__pause">
            <strong>{worker.id} {worker.status === 'conflict' ? 'hit a merge conflict' : worker.status === 'interrupted' ? 'was interrupted' : `failed on attempt ${Math.min(3, worker.attempts)} of 3`}</strong>
            <p>{worker.error || 'The assignment stopped. Changes are retained.'}</p>
            <div className="crew-v__pills">
              {worker.status === 'conflict'
                ? <button type="button" className="crew-v__btn crew-v__btn--primary" title={lock} disabled={readOnly || Boolean(busy)} onClick={() => { if (!readOnly) void act('accept-resolution', { taskId: worker.id }); }}>{busy === 'accept-resolution' ? 'Accepting' : 'Accept resolution'}</button>
                : worker.attempts < 3 && <button type="button" className="crew-v__btn crew-v__btn--primary" title={lock} disabled={readOnly || Boolean(busy)} onClick={() => { if (!readOnly) void act('retry', { taskId: worker.id }); }}>{busy === 'retry' ? 'Retrying' : 'Retry'} · attempt {worker.attempts + 1} of 3</button>}
            </div>
          </div>)}
        </div>
        {criteriaGate && <div className="crew-v__foot">
          <span className="crew-v__dim" style={{ fontSize: 12 }}>Nothing writes files until you approve.</span>
          <span className="crew-v__grow" />
          {questions.length > 0 && <button type="button" className="crew-v__btn" title={lock} disabled={readOnly || Boolean(busy)} onClick={() => void act('answer', { answers, criteria })}>Send answer</button>}
          {questions.length > 0 && <button type="button" className="crew-v__btn" title={lock} disabled={readOnly || Boolean(busy)} onClick={() => void act('approve-criteria', { criteria, decisions, models: picked })}>Skip question & approve</button>}
          <button type="button" className="crew-v__btn crew-v__btn--primary" title={unanswered ? 'Answer the questions or skip them' : lock} disabled={readOnly || Boolean(busy) || unanswered} onClick={() => void act('approve-criteria', { criteria, decisions, models: picked, answers })}>Approve</button>
        </div>}
        {splitGate && <div className="crew-v__foot">
          <span className="crew-v__grow" />
          <button type="button" className="crew-v__btn" disabled={Boolean(busy)} onClick={() => setSingle(value => !value)}>{single ? 'Use the split' : 'Run as one worker'}</button>
          <button type="button" className="crew-v__btn crew-v__btn--primary" title={lock} disabled={readOnly || Boolean(busy) || (!single && proposed.length === 0)} onClick={() => void act('approve-split', single ? { single: true } : { workers: proposed.map(worker => ({ id: worker.id, model: workerModels[worker.id] || picked?.builder })) })}>{single ? 'Approve & build' : 'Approve split'}</button>
        </div>}
        {showBuild && <div className="crew-v__foot">
          {files.length > 0 && <span className="crew-v__mono" style={{ fontSize: 12 }}><span className="crew-v__add">+{added}</span> <span className="crew-v__del">−{removed}</span> <span className="crew-v__dim">{files.length} {files.length === 1 ? 'file' : 'files'}</span></span>}
          <span className="crew-v__grow" />
          <span className="crew-v__dim" style={{ fontSize: 12 }}>{buildFoot}</span>
        </div>}
        {done && <Activity run={run} />}
      </section>
      {showAside && <aside className="crew-v__aside" aria-label={asideTask ? 'Worker details' : 'Integrator session'}>
        {showWorkerAside && asideTask ? <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={`crew-v__dot is-${dotKind(viewStatus(run, asideTask))}`} />
            <strong className="crew-v__mono">{asideTask.id}</strong>
            <span className="crew-v__chip" style={{ marginLeft: 'auto' }}>{viewStatus(run, asideTask)}</span>
          </div>
          <p>{asideTask.outcome}</p>
          <dl className="crew-v__facts">
            <dt>Builder</dt><dd><span style={{ color: mark(asideTask.backend).c }}>{mark(asideTask.backend).g}</span> {asideTask.model?.id || asideTask.backend}</dd>
            <dt>Covers</dt><dd className="crew-v__mono" style={{ color: 'var(--acc)' }}>{(asideTask.covers ?? []).join(' ') || '—'}</dd>
            <dt>Worktree</dt><dd className="crew-v__mono" style={{ fontSize: 11.5 }}>{asideTask.worktree?.path || '—'}</dd>
            <dt>Files</dt><dd className="crew-v__mono" style={{ fontSize: 11.5 }}>{asideTask.scope.join(', ') || '—'}</dd>
            <dt>Attempt</dt><dd>{Math.max(1, asideTask.attempts)} of 3</dd>
          </dl>
          {(asideTask.gate?.results.length ?? 0) > 0 && <div>
            <div className="crew-v__lbl" style={{ marginBottom: 8 }}>Server checks</div>
            <ul className="crew-v__livebox">{asideTask.gate?.results.map(result => <li key={result.command}><span style={{ color: result.ok ? '#5fd49a' : '#ff7a8a' }}>{result.ok ? '✓' : '✕'}</span><span className="crew-v__ellip">{result.command}</span></li>)}</ul>
          </div>}
          <div>
            <div className="crew-v__lbl" style={{ marginBottom: 8 }}>Live</div>
            <ul className="crew-v__livebox">{(liveLines.length ? liveLines : ['Waiting for output.']).map(line => <li key={line}><span className="crew-v__ellip">{brief(line, 140)}</span></li>)}</ul>
          </div>
          <div className="crew-v__pills">
            <button type="button" className="crew-v__btn" disabled={!asideTranscript?.sessionPath} onClick={() => openTranscript(asideTask)}>Open transcript</button>
            <button type="button" className="crew-v__btn" aria-expanded={showPrompt} onClick={() => setShowPrompt(value => !value)}>Context received</button>
          </div>
          {showPrompt && <pre className="crew-v__prompt">{asideTask.history.at(-1)?.prompt || 'No prompt recorded yet.'}</pre>}
        </> : <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: '#b69cff' }}>{mark(run.models?.builder?.backend || '').g}</span>
            <strong>Integrator</strong>
            <span className="crew-v__chip" style={{ marginLeft: 'auto' }}>{proPause ? 'paused' : running ? 'working' : run.integrator?.sessionKey ? 'open' : 'not started'}</span>
          </div>
          <p>One {stepText(run.models?.builder) || 'builder'} session owns the {workers.length > 1 ? 'merged' : 'finished'} code until the run ends.{laterWork ? ` ${laterWork} go back to it.` : ''}</p>
          <dl className="crew-v__facts">
            <dt>Session</dt><dd className="crew-v__mono" style={{ fontSize: 11.5 }}>{run.integrator?.sessionKey || '—'}</dd>
            <dt>Turns</dt><dd>{run.integrator?.turns ?? run.integrator?.history?.length ?? 0}</dd>
            <dt>Files</dt><dd className="crew-v__mono" style={{ fontSize: 11.5 }}>{[...new Set(workers.flatMap(worker => worker.scope))].join(', ') || '—'}</dd>
            {(run.prosecution?.owned?.length ?? 0) > 0 && <><dt>Owned</dt><dd className="crew-v__mono" style={{ fontSize: 11.5 }}>{run.prosecution?.owned?.join(', ')}</dd></>}
          </dl>
          <div className="crew-v__pills">
            <button type="button" className="crew-v__btn" disabled={!asideTranscript?.sessionPath} onClick={() => { if (asideTranscript?.sessionPath) resumeConversation({ path: asideTranscript.sessionPath, cwd: asideTranscript.cwd, name: 'Crew integrator', backend: asideTranscript.backend, createdAt: 0, modifiedAt: Date.now(), messageCount: 0 }); }}>Open transcript</button>
          </div>
        </>}
      </aside>}
    </div>
  </div>;
}

export function CrewRunCard({ tab, run, accessMode, reload, selected = false, onSelect = () => {} }: { tab: ConversationTab; run: CrewRun; accessMode: string; reload: () => void; selected?: boolean; onSelect?: () => void }) {
  const quiet = !['running', 'awaiting_input', 'awaiting_approval'].includes(run.status);
  const [opened, setOpened] = useState(false);
  const expanded = !quiet || opened || selected;
  const label = runLabel(run.status);
  if (!expanded) return <button type="button" className="crew-run crew-run--fold" onClick={() => { setOpened(true); onSelect(); }}>
    <strong>{run.request}</strong>
    <span className={`crew-status is-${label.replace(/\s+/g, '-')}`}>{label}</span>
    <span>{run.error || run.summary || ''}</span>
  </button>;
  if (!run.autonomous) return <RunView tab={tab} run={run} accessMode={accessMode} reload={reload} />;
  return <AutonomousView tab={tab} run={run} accessMode={accessMode} reload={reload} />;
}

export function CrewTimeline({ tab, route, accessMode, placed = false }: { tab: ConversationTab; route: SessionRoute; accessMode: string; placed?: boolean }) {
  const owner = tab.sessionPath;
  const { state, update, reload } = useCrewState(tab.key, owner, tab.cwd);
  const slot = useRef<HTMLDivElement | null>(null);
  const posting = useRef(false);
  const posted = useRef(new Set<string>());
  useEffect(() => {
    const openDraft = async (request: string) => {
      const steps = route.enabled ? route.steps.filter(step => step.enabled) : [];
      let tasks = defaultTasks(request, tab.backend);
      const problems: string[] = [];
      if (steps.length) {
        let piModels: { id: string; provider: string }[] = [];
        if (steps.some(step => step.backend === 'pi' && step.modelId && !step.modelProvider)) {
          try {
            const listed = await api.models(tab.key, 'pi');
            if (listed.ok && Array.isArray(listed.models)) piModels = listed.models;
          } catch { /* an empty catalog leaves the provider for the picker */ }
        }
        tasks = steps.map((step, index) => {
          const resolved = step.modelId ? resolveRouteModel(step, step.backend === 'pi' ? piModels : []) : { ok: true as const, model: null };
          if (!resolved.ok) problems.push(resolved.error);
          const kind = (KINDS as readonly string[]).includes(step.kind) ? step.kind as Kind : 'execute';
          return {
            id: `a${index + 1}`,
            kind,
            backend: step.backend,
            model: resolved.ok ? resolved.model : { provider: '', id: step.modelId },
            outcome: request ? `${step.kind}: ${request}` : '',
            dependencies: index ? [`a${index}`] : [],
            scope: ['.'],
            checks: kind === 'execute' ? [] : ['Report the outcome'],
          };
        });
      }
      const reviewer = readerBackend(steps.find(step => step.kind === 'review')?.backend || tab.backend);
      update({
        draft: { requestId: crypto.randomUUID(), request, mode: 'parallel', reviewer: { backend: reviewer, model: null }, tasks },
        selectedId: null,
        revealed: problems.length > 0,
        problems,
        error: '',
      });
    };
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; request: string }>).detail;
      if (!detail || detail.key !== tab.key) return;
      const request = (detail.request ?? '').trim();
      if (request) {
        if (posting.current) return;
        posting.current = true;
        const requestId = crypto.randomUUID();
        if (posted.current.has(requestId)) { posting.current = false; return; }
        posted.current.add(requestId);
        void api.crewAuto(tab.key, { requestId, request, cwd: tab.cwd, backend: tab.backend, sessionFile: tab.sessionPath }).then(result => {
          posting.current = false;
          if (!result.ok) { update({ error: result.error || 'Crew could not start' }); return; }
          update({ draft: null, error: '', selectedId: result.run?.id || requestId });
          reload();
        }).catch(error => { posting.current = false; update({ error: error instanceof Error ? error.message : String(error) }); });
        return;
      }
      void openDraft(detail.request ?? '');
    };
    window.addEventListener('crew-open', open);
    return () => window.removeEventListener('crew-open', open);
  }, [tab.key, tab.cwd, tab.backend, tab.sessionPath, route, update, reload]);
  useEffect(() => { slot.current?.scrollIntoView({ block: 'nearest' }); }, [state.draft?.requestId, state.selectedId]);
  const mine = state.runs.filter(run => run.owner === (owner || tab.key) || run.owner === tab.key);
  const showRuns = !placed && !state.draft && mine.length > 0;
  if (!state.draft && !showRuns && !state.error) return null;
  const request = state.draft?.request ?? '';
  return <div className="crew-slot" ref={slot}>
    {state.error && !state.draft && <p className="crew-problem" role="alert">{state.error}</p>}
    {state.draft && <>
      <article className="tl tl--user"><div className="tl--user__stack"><div className="user-msg">/crew{request ? ` ${request}` : ''}</div></div></article>
      <div className="tl crew-nest">
        <span className="crew-nest__dot" />
        <div className="crew-nest__label"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2.5V6M8 6 3.5 10v3.5M8 6l4.5 4v3.5M8 6v7.5" /></svg><span>crew</span></div>
        <div className="crew-card" aria-label="Crew run">
          <PlanEditor tab={tab} draft={state.draft} revealed={state.revealed} problems={state.problems} accessMode={accessMode} onChange={draft => update({ draft })} onClose={() => update({ draft: null, revealed: false, problems: [] })} onReveal={problems => update({ revealed: true, problems })} onCreated={run => { update({ draft: null, revealed: false, problems: [], selectedId: run.id }); reload(); }} />
        </div>
      </div>
    </>}
    {showRuns && mine.map(run => <CrewRunCard key={run.id} tab={tab} run={run} accessMode={accessMode} reload={reload} selected={state.selectedId === run.id} onSelect={() => update({ selectedId: run.id, draft: null })} />)}
  </div>;
}

export function CrewHistory({ sessionKey, sessionFile, cwd, query }: { sessionKey: string; sessionFile?: string; cwd: string; query: string }) {
  const { state, update } = useCrewState(sessionKey, sessionFile, cwd);
  const [scope, setScope] = useState<'conv' | 'ws'>('conv');
  const needle = query.trim().toLowerCase();
  const owner = sessionFile || sessionKey;
  const mine = state.runs.filter(run => run.owner === owner || run.owner === sessionKey);
  const shownId = state.draft ? null : (state.selectedId ?? mine[0]?.id ?? null);
  const rows = (scope === 'ws' ? state.runs : mine).filter(run => !needle || `${run.request} ${run.status} ${run.mode}`.toLowerCase().includes(needle));
  return <div className="crew-history">
    <div className="crew-seg" role="group" aria-label="Run history">
      <button type="button" className={scope === 'conv' ? 'is-on' : ''} onClick={() => setScope('conv')}>This conversation</button>
      <button type="button" className={scope === 'ws' ? 'is-on' : ''} onClick={() => setScope('ws')}>Workspace</button>
    </div>
    {state.error && <p className="crew-problem" role="alert">{state.error}</p>}
    {rows.length === 0 && <p className="crew-empty">No crew runs yet.</p>}
    {rows.map(run => {
      const label = runLabel(run.status);
      return <button type="button" key={run.id} className={`crew-history__row${run.id === shownId ? ' is-current' : ''}`} onClick={() => update({ selectedId: run.id, draft: null })}>
        <i className={`is-${label}`} />
        <span className="crew-history__request">{run.request}</span>
        <span className="crew-history__meta">{label} · {run.mode} · {run.tasks.length} {run.tasks.length === 1 ? 'assignment' : 'assignments'}</span>
        <time>{ago(run.updatedAt || run.createdAt)}</time>
      </button>;
    })}
  </div>;
}

export function crewBlocked(runs: CrewRun[]) {
  return runs.some(run => run.status === 'blocked' || run.status === 'awaiting_approval');
}
