import { SMART_CATEGORIES } from '../mail/constants.js';
import { smartCategoryMetadata } from '../mail/classify.js';
import { copyText, draftContextMenu, threadContextMenu } from '../mail/context-menu.js';
import { formatListDate } from '../mail/dates.js';
import { ContextMenu, useContextMenu } from './ContextMenu.jsx';
import { DeepSearchProgress } from './DeepSearchProgress.jsx';
import { FreshDraftsCard } from './FreshDraftsCard.jsx';
import { Icon } from './Icon.jsx';
import { Checkbox, IconButton } from './ui.jsx';

export function ListToolbar({ visibleCount, totalCount, selectedCount, onRefresh, onBulkAction, allSelected, onToggleAll, loading }) {
  return (
    <div className="list-toolbar">
      <div className="toolbar-left">
        <Checkbox checked={allSelected} onChange={onToggleAll} label="Select all conversations" />
        {selectedCount > 0 ? (
          <>
            <IconButton label="Archive" onClick={() => onBulkAction('archive')}><Icon name="archive" /></IconButton>
            <IconButton label="Report spam" onClick={() => onBulkAction('spam')}><Icon name="spam" /></IconButton>
            <IconButton label="Delete" onClick={() => onBulkAction('trash')}><Icon name="trash" /></IconButton>
            <IconButton label="Mark as unread" onClick={() => onBulkAction('unread')}><Icon name="unread" /></IconButton>
            <IconButton label="Snooze until tomorrow" onClick={() => onBulkAction('snooze')}><Icon name="snooze" /></IconButton>
            <IconButton label="Mark as analyzed by agent" onClick={() => onBulkAction('analyzed')}><Icon name="sparkles" /></IconButton>
          </>
        ) : (
          <IconButton label="Refresh" onClick={onRefresh} disabled={loading} className={loading ? 'is-spinning' : ''}><Icon name="refresh" /></IconButton>
        )}
      </div>
      <div className="toolbar-right">
        <span className="range-copy">{visibleCount ? `1–${visibleCount} of ${totalCount}` : '0 of 0'}</span>
      </div>
    </div>
  );
}

export function SmartFilterBar({ activeCategory, onChange, visibleCount, categoryCounts, loading }) {
  const availableCounts = SMART_CATEGORIES
    .filter((category) => category.id !== 'all')
    .map((category) => categoryCounts?.[category.id])
    .filter((count) => Number.isFinite(Number(count)));
  const allCount = availableCounts.length
    ? availableCounts.reduce((sum, count) => sum + Number(count), 0)
    : Number(visibleCount || 0);
  return (
    <section className="smart-filter-bar" id="smart-mail-filters" aria-label="Smart inbox filters">
      <div className="smart-filter-intro">
        <span className="smart-filter-mark"><Icon name="sparkles" size={16} /></span>
        <span><strong>Smart views</strong><small>Automatic, explainable sorting</small></span>
      </div>
      <div className="smart-filter-scroll" role="tablist" aria-label="Filter conversations by category">
        {SMART_CATEGORIES.map((category) => {
          const selected = activeCategory === category.id;
          const categoryCount = category.id === 'all'
            ? allCount
            : Number(categoryCounts?.[category.id] || 0);
          return (
            <button
              type="button"
              role="tab"
              key={category.id}
              aria-selected={selected}
              aria-controls="conversation-list"
              className={`smart-filter-chip category-${category.id} ${selected ? 'is-selected' : ''}`}
              onClick={() => onChange(category.id)}
              title={category.description}
            >
              <Icon name={category.icon} size={15} />
              <span>{category.shortLabel}</span>
              {!loading && categoryCount > 0 && <small aria-label={`${categoryCount} ${categoryCount === 1 ? 'message' : 'messages'}`}>{categoryCount}</small>}
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function CategoryBadge({ thread, showPrimary = false }) {
  const metadata = smartCategoryMetadata(thread);
  if (metadata.category === 'primary' && !showPrimary) return null;
  if (metadata.category === 'ops_quiet' && !showPrimary) return null;
  const definition = SMART_CATEGORIES.find((item) => item.id === metadata.category)
    || (metadata.category === 'ops_quiet' ? { id: 'ops_quiet', label: 'Ops digests', icon: 'terminal' } : null)
    || SMART_CATEGORIES[1];
  return (
    <span
      className={`thread-category category-${metadata.category}`}
      title={metadata.categoryReason}
      aria-label={`${metadata.categoryLabel}. ${metadata.categoryReason}`}
    >
      <Icon name={definition.icon || 'sparkles'} size={12} />
      <span>{metadata.categoryLabel}</span>
    </span>
  );
}

function ThreadRow({ thread, selected, isCursor, isChecked, isMenuTarget, onOpen, onCheck, onToggleStar, onContextMenu }) {
  const sender = thread.from?.name || thread.from?.email || 'Unknown sender';
  return (
    <article
      data-thread-id={thread.id}
      className={`thread-row ${thread.unread ? 'is-unread' : ''} ${selected ? 'is-selected' : ''} ${isCursor ? 'is-cursor' : ''} ${isMenuTarget ? 'is-menu-target' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(thread)}
      onContextMenu={onContextMenu ? (event) => onContextMenu(event, thread) : undefined}
      onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen(thread); } }}
    >
      <Checkbox checked={isChecked} onChange={onCheck} label={`Select ${thread.subject}`} />
      <IconButton label={thread.starred ? 'Unstar' : 'Star'} active={thread.starred} onClick={(event) => { event.stopPropagation(); onToggleStar(thread); }} className="row-star">
        <Icon name="star" size={19} />
      </IconButton>
      <div className="row-sender" title={sender}>{sender}</div>
      <div className="row-subject">
        <span className="row-subject-heading"><strong>{thread.subject || '(no subject)'}</strong><CategoryBadge thread={thread} /></span>
        <span className="row-snippet">{thread.snippet}</span>
      </div>
      <div className="row-meta">
        {thread.analyzed === false && thread.folder !== 'drafts' && (
          <span className="analyzed-marker" title="No agent has analyzed this conversation yet" aria-label="Not yet analyzed by an agent"><Icon name="sparkles" size={14} /></span>
        )}
        {thread.providerHit && <span className="provider-hit" title="Found on the mail server" aria-label="Found on the mail server"><Icon name="search" size={14} /></span>}
        {thread.hasAttachments && <Icon name="attachment" size={17} />}
        {thread.messageCount > 1 && <span className="thread-count">{thread.messageCount}</span>}
        <time>{formatListDate(thread.timestamp)}</time>
      </div>
    </article>
  );
}

function EmptyMailbox({ folder, query, category = 'all', onCompose, onClearSearch, onClearCategory, onRefresh }) {
  const categoryDefinition = SMART_CATEGORIES.find((item) => item.id === category);
  const agentQueue = /^is:unanalyzed$/i.test(String(query || '').trim());
  const title = agentQueue ? 'Every conversation has been analyzed' : query ? 'No mail matched your search' : categoryDefinition && category !== 'all' ? `No ${categoryDefinition.label.toLowerCase()} here` : folder === 'inbox' ? 'Your inbox is clear' : `Nothing in ${folder}`;
  const copy = agentQueue
    ? 'Your agent is caught up. New mail lands here until an agent marks it analyzed.'
    : query
    ? 'Try from:, to:, subject:, has:attachment, is:unanalyzed, or Deep search to look on the server for mail that is not downloaded yet.'
    : categoryDefinition && category !== 'all'
      ? `${categoryDefinition.description}. New matches will appear here automatically.`
    : folder === 'inbox'
      ? 'Take a breath. New conversations will appear here.'
      : 'Mail moved here will appear when it is available.';
  return (
    <div className="empty-state">
      <div className="empty-icon"><Icon name={agentQueue ? 'sparkles' : query ? 'search' : folder === 'inbox' ? 'inbox' : 'mail'} size={38} /></div>
      <h2>{title}</h2>
      <p>{copy}</p>
      <div className="empty-actions">
        {query ? <button type="button" className="secondary-button" onClick={onClearSearch}>Clear search</button> : category !== 'all' ? <button type="button" className="secondary-button" onClick={onClearCategory}>View all mail</button> : <button type="button" className="primary-button" onClick={onCompose}><Icon name="compose" size={18} /> Compose</button>}
        <button type="button" className="text-button" onClick={onRefresh}>Refresh</button>
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="skeleton-list" aria-label="Loading messages">
      {Array.from({ length: 7 }, (_, index) => <div className="skeleton-row" key={index}><i /><span /><b /><em /></div>)}
    </div>
  );
}

export function MailList({ threads, totalCount, categoryCounts, selectedThread, cursorThreadId, loading, folder, query, activeCategory, setActiveCategory, selectedIds, setSelectedIds, onOpenThread, onToggleStar, onRefresh, onBulkAction, onCompose, onClearSearch, hideSmartFilters = false, freshDrafts = [], onOpenFreshDraft, onDismissFreshDraft, onDeleteFreshDraft, onViewAllDrafts, onReply, onForward, onNotice, deepSearch = null, onCancelDeepSearch }) {
  const allSelected = threads.length > 0 && threads.every((thread) => selectedIds.includes(thread.id));
  const toggleAll = () => setSelectedIds(allSelected ? [] : threads.map((thread) => thread.id));
  const toggleOne = (thread, checked) => setSelectedIds((current) => checked ? [...new Set([...current, thread.id])] : current.filter((id) => id !== thread.id));
  const { menu, openMenu, closeMenu } = useContextMenu();
  const copyWithNotice = (text, confirmation) => {
    void copyText(text).then((copied) => onNotice?.(copied ? confirmation : 'Could not copy to the clipboard.'));
  };
  const openThreadMenu = (event, thread) => openMenu(event, {
    ...threadContextMenu(thread, {
      selectedIds,
      handlers: {
        openThread: onOpenThread,
        reply: onReply,
        forward: onForward,
        applyAction: onBulkAction,
        toggleStar: onToggleStar,
        toggleSelect: toggleOne,
        clearSelection: () => setSelectedIds([]),
        deleteDraft: onDeleteFreshDraft,
        copyText: onNotice ? copyWithNotice : undefined,
      },
    }),
    context: { threadId: thread.id },
  });
  const openDraftMenu = (event, draft) => openMenu(event, draftContextMenu(draft, {
    handlers: { open: onOpenFreshDraft, dismiss: onDismissFreshDraft, remove: onDeleteFreshDraft },
  }));
  return (
    <section className={`mail-list-panel ${selectedThread ? 'has-selected-thread' : ''}`} aria-label="Conversation list">
      <ListToolbar
        visibleCount={threads.length}
        totalCount={totalCount}
        selectedCount={selectedIds.length}
        onRefresh={onRefresh}
        onBulkAction={onBulkAction}
        allSelected={allSelected}
        onToggleAll={toggleAll}
        loading={loading}
      />
      {folder === 'inbox' && freshDrafts.length > 0 && (
        <FreshDraftsCard
          drafts={freshDrafts}
          onOpen={onOpenFreshDraft}
          onDismiss={onDismissFreshDraft}
          onDelete={onDeleteFreshDraft}
          onViewAll={onViewAllDrafts}
          onContextMenu={openDraftMenu}
        />
      )}
      {folder === 'inbox' && !hideSmartFilters && <SmartFilterBar activeCategory={activeCategory} onChange={setActiveCategory} visibleCount={threads.length} categoryCounts={categoryCounts} loading={loading} />}
      {deepSearch ? <DeepSearchProgress progress={deepSearch.progress} status={deepSearch.status} onCancel={onCancelDeepSearch} /> : null}
      {loading && !threads.length && deepSearch?.status !== 'running' ? <SkeletonRows /> : threads.length ? (
        <div className="thread-list" id="conversation-list" role="tabpanel">
          {threads.map((thread) => (
            <ThreadRow
              key={thread.id}
              thread={thread}
              selected={selectedThread?.id === thread.id}
              isCursor={cursorThreadId === thread.id}
              isChecked={selectedIds.includes(thread.id)}
              isMenuTarget={menu?.context?.threadId === thread.id}
              onOpen={onOpenThread}
              onCheck={(checked) => toggleOne(thread, checked)}
              onToggleStar={onToggleStar}
              onContextMenu={openThreadMenu}
            />
          ))}
        </div>
      ) : deepSearch?.status === 'running' ? (
        <div className="empty-state" role="status">
          <div className="empty-icon"><Icon name="search" size={38} /></div>
          <h2>Looking on the server</h2>
          <p>Local matches appear first. Older mail streams in as each account and folder is searched.</p>
        </div>
      ) : (
        <EmptyMailbox folder={folder} query={query} category={activeCategory} onCompose={onCompose} onClearSearch={onClearSearch} onClearCategory={() => setActiveCategory('all')} onRefresh={onRefresh} />
      )}
      <ContextMenu menu={menu} onClose={closeMenu} />
    </section>
  );
}
