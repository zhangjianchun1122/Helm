const counts = Object.create(null);
let truncatedResults = 0;
let calls = 0;

export function recordSecurityReport(report = {}) {
  calls++;
  for (const [type, count] of Object.entries(report.counts || {})) counts[type] = (counts[type] || 0) + Number(count || 0);
  if (report.truncated) truncatedResults++;
}

export function getSecurityStats() {
  return { calls, counts: { ...counts }, truncatedResults };
}
