import { Icon } from './Icon.jsx';

export function DeepSearchProgress({ progress, status, onCancel }) {
  if (!progress || (status !== 'running' && status !== 'cancelled' && status !== 'error' && status !== 'complete')) return null;
  const total = Math.max(1, Number(progress.total) || 1);
  const done = Math.min(total, Math.max(0, Number(progress.done) || 0));
  const ratio = Number.isFinite(progress.ratio) ? progress.ratio : done / total;
  const percent = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  const found = Number(progress.found) || 0;
  const running = status === 'running';
  const label = progress.label || (running ? 'Searching connected accounts' : 'Search complete');
  return (
    <div className={`deep-search-progress ${running ? 'is-running' : ''} status-${status}`} role="status" aria-live="polite">
      <div className="deep-search-copy">
        <Icon name="search" size={16} />
        <span>
          <strong>{running ? 'Deep search' : status === 'cancelled' ? 'Deep search cancelled' : status === 'error' ? 'Deep search stopped' : 'Deep search complete'}</strong>
          <small>{label}{found ? ` · ${found} found` : ''}{running ? ` · ${done}/${total}` : ''}</small>
        </span>
      </div>
      <div
        className="deep-search-track"
        role="progressbar"
        aria-label="Deep search progress"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={`${percent}%`}
      >
        <div className="deep-search-fill" style={{ width: `${percent}%` }} />
      </div>
      {running && onCancel ? (
        <button type="button" className="text-button deep-search-cancel" onClick={onCancel}>Cancel</button>
      ) : null}
    </div>
  );
}
