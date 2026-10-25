/** Place crew runs among transcript items. Ties sit after a user message with the same time. */
type Stamp = { id: string; kind: string; timestamp?: number; startedAt?: number };
type RunStamp = { id: string; createdAt?: number };

function itemTime(item: Stamp) {
  if (item.kind === 'tool') return typeof item.startedAt === 'number' ? item.startedAt : null;
  return typeof item.timestamp === 'number' ? item.timestamp : null;
}

export function interleaveCrew<I extends Stamp, R extends RunStamp>(items: I[], runs: R[]) {
  const timed = runs.map((run, index) => ({ run, index })).filter(entry => typeof entry.run.createdAt === 'number')
    .sort((a, b) => a.run.createdAt! - b.run.createdAt! || a.index - b.index);
  const untimed = runs.filter(run => typeof run.createdAt !== 'number');
  const out: Array<{ kind: 'item'; item: I } | { kind: 'crew'; run: R }> = [];
  let cursor = 0;
  const emitBefore = (time: number, equal: boolean) => {
    while (cursor < timed.length) {
      const at = timed[cursor].run.createdAt!;
      if (equal ? at <= time : at < time) { out.push({ kind: 'crew', run: timed[cursor].run }); cursor += 1; }
      else break;
    }
  };
  for (const item of items) {
    const time = itemTime(item);
    if (time != null) emitBefore(time, false);
    out.push({ kind: 'item', item });
    if (time != null && item.kind === 'user') emitBefore(time, true);
  }
  while (cursor < timed.length) { out.push({ kind: 'crew', run: timed[cursor].run }); cursor += 1; }
  for (const run of untimed) out.push({ kind: 'crew', run });
  return out;
}

export function crewAnchors<I extends Stamp, R extends RunStamp>(items: I[], runs: R[]) {
  const leading: R[] = [];
  const after = new Map<string, R[]>();
  let seen = false;
  let last = '';
  for (const entry of interleaveCrew(items, runs)) {
    if (entry.kind === 'item') { seen = true; last = entry.item.id; continue; }
    if (!seen) leading.push(entry.run);
    else {
      const list = after.get(last) ?? [];
      list.push(entry.run);
      after.set(last, list);
    }
  }
  return { leading, after };
}

export function runLabel(status: string) {
  if (status === 'awaiting_input') return 'needs you';
  if (status === 'awaiting_approval' || status === 'blocked') return 'blocked';
  if (status === 'initializing') return 'running';
  if (['draft', 'running', 'paused', 'stopped', 'done'].includes(status)) return status;
  return 'blocked';
}
