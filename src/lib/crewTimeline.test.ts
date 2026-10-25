import test from 'node:test';
import assert from 'node:assert/strict';
import { crewAnchors, interleaveCrew, runLabel } from './crewTimeline.ts';

const item = (id: string, kind: string, time: number) => kind === 'tool'
  ? { id, kind, startedAt: time }
  : { id, kind, timestamp: time };
const ids = (items: { id: string; kind: string; timestamp?: number; startedAt?: number }[], runs: { id: string; createdAt?: number }[]) =>
  interleaveCrew(items, runs).map(entry => entry.kind === 'item' ? entry.item.id : entry.run.id);

test('interleaveCrew orders runs, ties and empty input', () => {
  const items = [item('u', 'user', 10), item('a', 'assistant', 10), item('t', 'tool', 30)];
  assert.deepEqual(ids(items, [{ id: 'early', createdAt: 5 }, { id: 'tie', createdAt: 10 }, { id: 'mid', createdAt: 20 }, { id: 'late', createdAt: 40 }]), ['early', 'u', 'tie', 'a', 'mid', 't', 'late']);
  assert.deepEqual(ids(items, [{ id: 'same', createdAt: 10 }, { id: 'also', createdAt: 10 }]), ['u', 'same', 'also', 'a', 't']);
  assert.deepEqual(ids([item('a', 'assistant', 10), item('b', 'assistant', 20)], [{ id: 'r', createdAt: 10 }]), ['a', 'r', 'b']);
  assert.deepEqual(ids(items, [{ id: 'none' }]), ['u', 'a', 't', 'none']);
  assert.deepEqual(ids([], [{ id: 'only', createdAt: 1 }, { id: 'bare' }]), ['only', 'bare']);
  assert.deepEqual(ids(items, []), ['u', 'a', 't']);
  const anchors = crewAnchors(items, [{ id: 'early', createdAt: 5 }, { id: 'tie', createdAt: 10 }]);
  assert.deepEqual(anchors.leading.map(run => run.id), ['early']);
  assert.deepEqual(anchors.after.get('u')?.map(run => run.id), ['tie']);
});

test('runLabel handles awaiting_input', () => {
  assert.equal(runLabel('awaiting_input'), 'needs you');
  assert.equal(runLabel('awaiting_approval'), 'blocked');
  assert.equal(runLabel('running'), 'running');
  assert.equal(runLabel('done'), 'done');
  assert.equal(runLabel('mystery'), 'blocked');
});
