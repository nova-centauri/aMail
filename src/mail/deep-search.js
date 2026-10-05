import { parseMailboxQuery } from './search-query.js';
import { shouldDeepSearchProvider } from '../../server/mail/imap-search.js';

export function querySupportsDeepSearch(query, folder = 'inbox') {
  const parsed = parseMailboxQuery(String(query || '').trim());
  return shouldDeepSearchProvider(parsed, { folder: parsed.folder || folder });
}

export function applyDeepSearchPage(data, { normalizeThread, smartCategories }) {
  const rawThreads = Array.isArray(data?.messages) ? data.messages : [];
  const threads = rawThreads.map(normalizeThread);
  const responseTotal = Number(data?.total);
  const categoryCounts = data?.categoryCounts && typeof data.categoryCounts === 'object'
    ? Object.fromEntries(smartCategories.filter((item) => item.id !== 'all').map((item) => [item.id, Number(data.categoryCounts[item.id] || 0)]))
    : null;
  return {
    threads,
    total: Number.isFinite(responseTotal) ? responseTotal : threads.length,
    categoryCounts,
    folderCounts: data?.folderCounts || null,
    progress: data?.progress || null,
    jobId: data?.jobId || null,
    status: data?.status || null,
  };
}
