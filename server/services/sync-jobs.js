const JOB_LIMIT = 32;

export function publicSyncJob(job) {
  if (!job) return null;
  return {
    jobId: job.id,
    status: job.status,
    kind: job.kind,
    accountId: job.accountId || null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error || null,
    result: job.result || null,
  };
}

export function mcpEnqueueStatus(state) {
  if (state === 'in-flight' || state === 'recent' || state === 'cooling') return 'already_running';
  return 'queued';
}

export function createSyncJobBoard({ now = () => Date.now() } = {}) {
  const jobs = new Map();
  let seq = 0;

  function remember(job) {
    jobs.set(job.id, job);
    while (jobs.size > JOB_LIMIT) {
      const oldest = jobs.keys().next().value;
      jobs.delete(oldest);
    }
    return job;
  }

  return {
    create({ kind = 'all', accountId = null, status = 'queued' } = {}) {
      seq += 1;
      const startedAt = new Date(now()).toISOString();
      return remember({
        id: `sync_${seq}_${now().toString(36)}`,
        kind,
        accountId,
        status,
        startedAt,
        finishedAt: null,
        error: null,
        result: null,
      });
    },
    get(id) {
      return jobs.get(String(id || '')) || null;
    },
    latest() {
      let last = null;
      for (const job of jobs.values()) last = job;
      return last;
    },
    running() {
      return [...jobs.values()].find((job) => job.status === 'running' || job.status === 'queued') || null;
    },
    finish(job, { status = 'done', error = null, result = null } = {}) {
      if (!job) return null;
      job.status = status;
      job.error = error;
      job.result = result;
      job.finishedAt = new Date(now()).toISOString();
      return job;
    },
    public: publicSyncJob,
  };
}
