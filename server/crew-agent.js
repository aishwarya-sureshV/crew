import { assistantText } from './pi-agent.js';
import { turnError } from './prosecutor.js';

/**
 * One crew agent that stays up across turns. Stopped only by close() or an
 * aborted turn. crewExecutor is open → turn → close on a fresh session.
 */
export function crewSession({ getAgent, stopAgent, timeoutMs = 20 * 60_000 }) {
  let agent = null;
  let backend = null;
  let sessionKey = null;
  let opened = false;
  let starting = false;
  let cancelOpen = null;

  async function stop(reason = 'Crew interrupted.') {
    const key = sessionKey;
    const which = backend;
    const shouldStop = opened || starting;
    opened = false;
    starting = false;
    const cancel = cancelOpen;
    cancelOpen = null;
    cancel?.(new Error(reason));
    if (!shouldStop || !key || !which) return;
    await stopAgent(key, which);
  }

  return {
    agent: () => agent,
    async open({ backend: nextBackend, model, sessionKey: key, cwd, readOnly, signal }) {
      if (opened || starting) return;
      backend = nextBackend;
      sessionKey = key;
      agent = getAgent(key, nextBackend);
      starting = true;
      let timedOut = false;
      if (signal?.aborted) {
        starting = false;
        throw new Error('Crew interrupted.');
      }
      let started;
      try {
        started = await new Promise((resolve, reject) => {
          let done = false;
          const finish = (error, value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            cancelOpen = null;
            if (error) reject(error);
            else resolve(value);
          };
          cancelOpen = error => finish(error);
          const onAbort = () => { void stop('Crew interrupted.'); };
          const timer = setTimeout(() => { timedOut = true; void stop('Crew agent timed out.'); }, timeoutMs);
          timer.unref?.();
          signal?.addEventListener('abort', onAbort);
          Promise.resolve(agent.start(cwd, {
            accessMode: readOnly ? 'read-only' : 'workspace-write',
            agentMode: readOnly ? 'plan' : 'manual',
            model: model || undefined,
          })).then(
            value => finish(null, value),
            error => finish(error instanceof Error ? error : new Error(String(error))),
          );
        });
        if (!starting) throw new Error(timedOut ? 'Crew agent timed out.' : 'Crew interrupted.');
        if (signal?.aborted) throw new Error('Crew interrupted.');
        if (started?.ok === false) throw new Error(started.error || 'Could not start crew agent.');
        starting = false;
        opened = true;
      } catch (error) {
        // stop() already cleared `starting` on abort, close, and timeout.
        // A thrown or refused start() leaves it set; stop the process here
        // or the next open() treats the session as still starting.
        const failedStart = starting;
        starting = false;
        opened = false;
        if (failedStart && sessionKey && backend) {
          try { await stopAgent(sessionKey, backend); } catch { /* keep the original start error */ }
        }
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
    async turn(prompt, { signal, onEvent = () => {}, onSession = () => {} } = {}) {
      if (!opened) throw new Error('Crew session is not open.');
      let off = () => {};
      let timer;
      let abort;
      let ended = false;
      try {
        return await new Promise((resolve, reject) => {
          let text = '';
          let error = '';
          const finish = err => { if (ended) return; ended = true; err ? reject(err) : resolve(text); };
          const interrupt = message => {
            void Promise.resolve().then(() => agent.abort?.()).catch(() => {});
            finish(new Error(message));
          };
          abort = () => interrupt('Crew interrupted.');
          signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => interrupt('Crew agent timed out.'), timeoutMs);
          timer.unref?.();
          if (signal?.aborted) { abort(); return; }
          off = agent.onEvent(event => {
            onEvent(event);
            const path = agent.sessionFile || agent.lastState?.sessionFile;
            if (path) onSession(path);
            if (['message_end', 'turn_end'].includes(event.type) && event.message?.role === 'assistant') {
              text = assistantText(event.message) || text;
              error = turnError(event.message) || error;
            }
            if (['agent_end', 'agent_settled'].includes(event.type)) finish(error ? new Error(error) : !text ? new Error('Agent ended without a report.') : null);
            if (event.type === 'process_exit') finish(new Error('Crew agent exited.'));
          });
          Promise.resolve().then(() => { if (!ended) return agent.prompt(prompt); }).then(result => {
            if (result?.ok === false) finish(new Error(result.error || 'Crew prompt failed.'));
          }).catch(finish);
        });
      } finally {
        clearTimeout(timer);
        off();
        if (abort) signal?.removeEventListener('abort', abort);
        if (signal?.aborted) await stop();
      }
    },
    close: stop,
  };
}

export function crewExecutor({ getAgent, stopAgent, timeoutMs }) {
  return async ({ backend, model, sessionKey, cwd, prompt, readOnly, signal, onEvent, onSession }) => {
    if (signal?.aborted) throw new Error('Crew interrupted.');
    const session = crewSession({ getAgent, stopAgent, timeoutMs });
    let timedOut = false;
    const kill = () => { timedOut = true; void stopAgent(sessionKey, backend); };
    const onAbort = () => kill();
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(kill, timeoutMs ?? 20 * 60_000);
    timer.unref?.();
    try {
      await session.open({ backend, model, sessionKey, cwd, readOnly, signal });
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) throw new Error('Crew interrupted.');
      if (timedOut) throw new Error('Crew agent timed out.');
      return await session.turn(prompt, { signal, onEvent, onSession });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      await session.close();
    }
  };
}
