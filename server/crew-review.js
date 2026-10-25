/** Pure parser for the final-review contract. Null means the text had no review lines. */

const clean = line => line
  .replace(/[*`]/g, '')
  .replace(/_+(?=\s|$)/g, '')
  .replace(/(^|\s)_+/g, '$1')
  .replace(/\s+/g, ' ')
  .trim();

export function parseReview(text, criteriaIds = []) {
  const findings = [];
  const verdicts = {};
  let sawLine = false;
  let crew = null;
  for (const raw of String(text ?? '').split('\n')) {
    const line = clean(raw);
    if (!line) continue;
    const finding = /^FINDING\s+(R\d+)\s*\|\s*([^|]*)\|\s*(blocker|should|nit)\s*\|\s*([^|]*)\|\s*(.+)$/i.exec(line);
    if (finding) {
      sawLine = true;
      const loc = finding[4].trim();
      const at = /^(.*):(\d+)$/.exec(loc);
      const criterion = finding[2].trim();
      findings.push({
        id: finding[1].toUpperCase(),
        criterion: !criterion || criterion === '-' ? null : criterion.toUpperCase(),
        severity: finding[3].toLowerCase(),
        file: at ? at[1] : loc,
        line: at ? Number(at[2]) : null,
        text: finding[5].trim(),
      });
      continue;
    }
    const verdict = /^VERDICT\s+(AC\d+)\s*:\s*(PASS|FAIL)\b/i.exec(line);
    if (verdict) {
      sawLine = true;
      verdicts[verdict[1].toUpperCase()] = verdict[2].toLowerCase();
      continue;
    }
    const overall = /^CREW_VERDICT\s*:\s*(PASS|FAIL)\b/i.exec(line);
    if (overall) {
      sawLine = true;
      crew = overall[1].toUpperCase();
    }
  }
  if (!sawLine) return null;
  for (const id of criteriaIds) if (!verdicts[id]) verdicts[id] = 'fail';
  const blockers = findings.some(finding => finding.severity === 'blocker' || finding.severity === 'should');
  const missed = Object.values(verdicts).includes('fail');
  const verdict = crew === 'PASS' && !blockers && !missed ? 'PASS' : 'FAIL';
  return { findings, verdicts, verdict, report: String(text ?? '') };
}
