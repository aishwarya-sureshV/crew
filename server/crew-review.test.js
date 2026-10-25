import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReview } from './crew-review.js';

const well = `FINDING R1 | AC2 | blocker | src/lib/theme.ts:42 | saves theme before validating it
FINDING R2 | - | nit | src/components/Settings.tsx:18 | rename toggle handler
VERDICT AC1: PASS
VERDICT AC2: FAIL
CREW_VERDICT: FAIL`;

test('parseReview reads a well-formed report and fails a missing verdict', () => {
  const parsed = parseReview(well, ['AC1', 'AC2']);
  assert.equal(parsed.verdict, 'FAIL');
  assert.equal(parsed.findings[0].id, 'R1');
  assert.equal(parsed.findings[0].criterion, 'AC2');
  assert.equal(parsed.findings[0].severity, 'blocker');
  assert.equal(parsed.findings[0].file, 'src/lib/theme.ts');
  assert.equal(parsed.findings[0].line, 42);
  assert.equal(parsed.findings[1].criterion, null);
  assert.equal(parsed.verdicts.AC1, 'pass');
  assert.equal(parsed.verdicts.AC2, 'fail');
  const missing = parseReview('VERDICT AC1: PASS\nCREW_VERDICT: PASS', ['AC1', 'AC2']);
  assert.equal(missing.verdicts.AC2, 'fail');
  assert.equal(missing.verdict, 'FAIL');
});

test('parseReview tolerates markdown and lets nits pass', () => {
  const text = '**FINDING R1 | - | nit | src/a.ts:3 | rename it**\n*VERDICT AC1: PASS*\n`CREW_VERDICT: PASS`';
  const parsed = parseReview(text, ['AC1']);
  assert.equal(parsed.findings[0].severity, 'nit');
  assert.equal(parsed.findings[0].file, 'src/a.ts');
  assert.equal(parsed.verdict, 'PASS');
});

test('parseReview returns null when the text has no review lines', () => {
  assert.equal(parseReview('I looked around and it seems fine.', ['AC1']), null);
  assert.equal(parseReview('', []), null);
});
