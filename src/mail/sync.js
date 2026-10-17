export function syncWasAccepted(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return payload.accepted === true
    || payload.state === 'started'
    || payload.state === 'in-flight'
    || payload.state === 'queued'
    || payload.state === 'recent'
    || payload.state === 'cooling';
}

export function syncResultStatus(payload) {
  if (syncWasAccepted(payload) && payload?.result == null && payload?.results == null) return 'accepted';
  const source = payload?.result ?? payload?.results ?? payload;
  const results = Array.isArray(source) ? source : source ? [source] : [];
  if (!results.length) return 'ok';
  if (results.every((result) => result?.skipped)) return 'skipped';
  if (results.some((result) => result?.skipped)) return 'partial';
  const statuses = results.map((result) => result?.status).filter(Boolean);
  if (statuses.length && statuses.every((status) => status === 'failed')) return 'failed';
  if (statuses.some((status) => status === 'failed' || status === 'partial')) return 'partial';
  return 'ok';
}

export function syncSkippedMessageCount(payload) {
  const source = payload?.result ?? payload?.results ?? payload;
  const results = Array.isArray(source) ? source : source ? [source] : [];
  return results.reduce((sum, result) => sum + (typeof result?.skipped === 'number' ? Math.max(0, result.skipped) : 0), 0);
}
