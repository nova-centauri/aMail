import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ATTACHMENT_STAGE_CONCURRENCY,
  attachmentDownloadKey,
  beginDownload,
  createDownloadLane,
  fetchAttachmentBlob,
  previewAttachmentDownload,
  runWithConcurrency,
  saveBlob,
  stageableAttachments,
} from '../mail/attachment-download.js';
import { smartCategoryMetadata } from '../mail/classify.js';
import { copyText, messageContextMenu, openThreadContextMenu } from '../mail/context-menu.js';
import { formatAttachmentSize, formatListDate, formatMessageDate } from '../mail/dates.js';
import { sanitizeEmailHtml } from '../mail/html.js';
import { formatRecipients, normalizeMessage, recipientArray } from '../mail/normalize.js';
import { messageTimelineContent } from '../mail/quotes.js';
import { ContextMenu, useContextMenu } from './ContextMenu.jsx';
import { Icon } from './Icon.jsx';
import { Avatar, IconButton } from './ui.jsx';
import { CategoryBadge } from './MailList.jsx';

export function ThreadToolbar({ onBack, onAction, isRead, isAnalyzed = true }) {
  return (
    <div className="thread-toolbar">
      <div className="toolbar-left">
        <IconButton label="Back to inbox" onClick={onBack}><Icon name="back" /></IconButton>
        <span className="toolbar-separator" />
        <IconButton label="Archive" onClick={() => onAction('archive')}><Icon name="archive" /></IconButton>
        <IconButton label="Report spam" onClick={() => onAction('spam')}><Icon name="spam" /></IconButton>
        <IconButton label="Delete" onClick={() => onAction('trash')}><Icon name="trash" /></IconButton>
        <IconButton label={isRead ? 'Mark as unread' : 'Mark as read'} onClick={() => onAction(isRead ? 'unread' : 'read')}><Icon name={isRead ? 'unread' : 'mail'} /></IconButton>
        <IconButton label="Snooze until tomorrow" onClick={() => onAction('snooze')}><Icon name="snooze" /></IconButton>
        <span className="toolbar-separator" />
        <IconButton label={isAnalyzed ? 'Mark as not analyzed' : 'Mark as analyzed by agent'} active={isAnalyzed} onClick={() => onAction(isAnalyzed ? 'unanalyzed' : 'analyzed')} className="analyzed-toggle"><Icon name="sparkles" /></IconButton>
      </div>
    </div>
  );
}

function downloadLabel(progress, sizeLabel) {
  if (!progress) return sizeLabel;
  if (progress.state === 'failed') return 'Failed — try again';
  if (progress.state !== 'downloading') return sizeLabel;
  const total = Number(progress.total) || 0;
  const loaded = Number(progress.loaded) || 0;
  if (total > 0) return `${Math.min(100, Math.round((loaded / total) * 100))}%`;
  return 'Downloading';
}

function AttachmentChip({ attachment, index, progress, onDownload }) {
  const name = attachment.name || 'Attachment';
  const sizeLabel = formatAttachmentSize(attachment.size || attachment.sizeBytes || attachment.bytes);
  const downloading = progress?.state === 'downloading';
  const total = Number(progress?.total) || 0;
  const loaded = Number(progress?.loaded) || 0;
  const percent = total > 0 ? Math.min(1, loaded / total) : 0;
  const canDownload = Boolean(attachment.url || attachment.preview);
  if (!canDownload) {
    return (
      <span className="attachment-chip" title={name}>
        <Icon name="attachment" size={17} />
        <span>{name}</span>
        {sizeLabel && <small>{sizeLabel}</small>}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`attachment-chip ${downloading ? 'is-downloading is-spinning' : ''} ${progress?.state === 'failed' ? 'is-failed' : ''}`}
      title={name}
      aria-label={downloading ? `Downloading ${name}` : `Download ${name}`}
      aria-busy={downloading}
      disabled={downloading}
      onClick={() => onDownload(attachment, index)}
    >
      <span
        className={`attachment-progress ${downloading && !total ? 'is-indeterminate' : ''}`}
        style={downloading && total ? { transform: `scaleX(${Math.max(percent, 0.08)})` } : undefined}
      />
      <Icon name="attachment" size={17} />
      <span>{name}</span>
      <small>{downloadLabel(progress, sizeLabel)}</small>
    </button>
  );
}

function MessageBody({ message, onLoadRemote, allowPrivateImages, downloadProgress, onDownloadAttachment }) {
  const timeline = useMemo(() => messageTimelineContent(message), [message.body, message.bodyHtml]);
  const [showQuoted, setShowQuoted] = useState(false);
  useEffect(() => setShowQuoted(false), [message.id]);
  const displayHtml = showQuoted ? message.bodyHtml : timeline.bodyHtml;
  const displayBody = showQuoted ? message.body : timeline.body;
  const paragraphs = String(displayBody || '').split(/\n\s*\n/).filter(Boolean);
  const safeHtml = useMemo(
    () => sanitizeEmailHtml(displayHtml, Boolean(message.remoteContentLoaded && allowPrivateImages)),
    [displayHtml, message.remoteContentLoaded, allowPrivateImages],
  );
  return (
    <div className="message-body">
      {message.remoteContentBlocked && (!message.remoteContentLoaded || !allowPrivateImages) && (
        <div className="privacy-notice">
          <span className="notice-icon"><Icon name="eyeOff" size={18} /></span>
          <div><strong>Remote content blocked for your privacy</strong><span>Known tracking pixels stay blocked; other images are never fetched directly.</span></div>
          {allowPrivateImages ? (
            <button type="button" onClick={() => onLoadRemote(message)}>Load images privately</button>
          ) : (
            <span className="private-load-off">Private image loading is off</span>
          )}
        </div>
      )}
      {safeHtml ? (
        <div className="html-email-body" dangerouslySetInnerHTML={{ __html: safeHtml }} />
      ) : paragraphs.length ? paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>) : <p className="muted-copy">This message has no plain-text preview.</p>}
      {timeline.stripped && (
        <button type="button" className="quoted-toggle" aria-expanded={showQuoted} onClick={() => setShowQuoted((value) => !value)}>
          {showQuoted ? 'Hide quoted text' : 'Show quoted text'}
        </button>
      )}
      {message.attachments?.length > 0 && (
        <div className="attachments">
          {message.attachments.map((attachment, index) => {
            const key = attachmentDownloadKey(message.id, attachment, index);
            return (
              <AttachmentChip
                key={attachment.id || key}
                attachment={attachment}
                index={index}
                progress={downloadProgress[key]}
                onDownload={(attachment, index) => onDownloadAttachment(message, attachment, index)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function MessageCard({ message, expanded, onToggle, onLoadRemote, onReply, onReplyAll, onForward, onContextMenu, allowPrivateImages, downloadProgress, onDownloadAttachment, cardRef }) {
  const from = message.from || {};
  const recipientList = formatRecipients(message.to);
  const canReplyAll = [...recipientArray(message.to), ...recipientArray(message.cc)].length > 1;
  const handleContextMenu = (event) => {
    // The rendered email keeps the browser menu: copying text, opening links,
    // and saving images from mail is what people right-click there for.
    if (event.target.closest('.message-body')) return;
    onContextMenu?.(event, message, { expanded, canReplyAll });
  };
  return (
    <article ref={cardRef} className={`message-card email-light ${expanded ? 'is-expanded' : ''}`} onContextMenu={onContextMenu ? handleContextMenu : undefined}>
      <button type="button" className="message-summary" onClick={onToggle} aria-expanded={expanded}>
        <Avatar person={from} size="md" />
        <span className="message-sender"><strong>{from.name || from.email || 'Unknown sender'}</strong><small>{expanded ? (from.email || '') : message.body?.replace(/\s+/g, ' ').slice(0, 88)}</small></span>
        <time>{expanded ? formatMessageDate(message.timestamp) : formatListDate(message.timestamp)}</time>
        <Icon name="chevronDown" size={18} className={expanded ? 'is-rotated' : ''} />
      </button>
      {expanded && (
        <div className="message-content">
          <div className="message-utilities">
            <span>to {recipientList || 'me'}</span>
            <div>
              <IconButton label="Reply" onClick={() => onReply(message)}><Icon name="reply" size={18} /></IconButton>
              <IconButton label="Forward" onClick={() => onForward(message)}><Icon name="forward" size={18} /></IconButton>
            </div>
          </div>
          <MessageBody message={message} onLoadRemote={onLoadRemote} allowPrivateImages={allowPrivateImages} downloadProgress={downloadProgress} onDownloadAttachment={onDownloadAttachment} />
          <div className="message-reply-actions">
            <button type="button" className="secondary-button" onClick={() => onReply(message)}><Icon name="reply" size={18} /> Reply</button>
            {canReplyAll && <button type="button" className="secondary-button" onClick={() => onReplyAll(message)}><Icon name="reply" size={18} /> Reply all</button>}
            <button type="button" className="secondary-button" onClick={() => onForward(message)}><Icon name="forward" size={18} /> Forward</button>
          </div>
        </div>
      )}
    </article>
  );
}

function conversationMessages(thread) {
  const messages = thread.messages?.length ? thread.messages : [normalizeMessage(thread)];
  return [...messages].sort((left, right) => String(left.timestamp || '').localeCompare(String(right.timestamp || '')));
}

export function ThreadView({ thread, activeFolder, onBack, onAction, onLoadRemote, onReply, onReplyAll, onForward, onToggleStar, onNotice, allowPrivateImages }) {
  const sourceMessages = useMemo(() => conversationMessages(thread), [thread]);
  const messageKey = sourceMessages.map((message) => message.id).join('|');
  const classification = smartCategoryMetadata(thread);
  const [expandedIds, setExpandedIds] = useState(() => new Set(sourceMessages.map((message) => message.id)));
  useEffect(() => setExpandedIds(new Set(sourceMessages.map((message) => message.id))), [thread.id, messageKey]);
  const toggleExpanded = (id) => setExpandedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const { menu, openMenu, closeMenu } = useContextMenu();
  const copyWithNotice = onNotice
    ? (text, confirmation) => { void copyText(text).then((copied) => onNotice(copied ? confirmation : 'Could not copy to the clipboard.')); }
    : undefined;
  const openHeadingMenu = (event) => openMenu(event, openThreadContextMenu(thread, {
    handlers: {
      applyAction: onAction,
      toggleStar: onToggleStar,
      copyText: copyWithNotice,
      back: onBack,
    },
  }));
  const laneRef = useRef(createDownloadLane());
  const busyRef = useRef(new Set());
  const stagedRef = useRef(new Map());
  const abortRef = useRef(null);
  const scrollerRef = useRef(null);
  const latestRef = useRef(null);
  const [downloadProgress, setDownloadProgress] = useState({});
  const attachmentKey = sourceMessages.map((message) => (message.attachments || []).map((attachment, index) => attachmentDownloadKey(message.id, attachment, index)).join(',')).join('|');

  useEffect(() => {
    const scroller = scrollerRef.current;
    const latest = latestRef.current;
    if (!scroller || !latest) return;
    const fits = latest.offsetTop + latest.offsetHeight <= scroller.clientHeight + 8;
    scroller.scrollTop = fits ? 0 : Math.max(0, latest.offsetTop - 8);
  }, [thread.id, messageKey]);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    stagedRef.current = new Map();
    const items = stageableAttachments(sourceMessages);
    let cancelled = false;
    // Stage only this open conversation, after the cards have rendered.
    // The next list row is not fetched: it often has no attachment URLs yet,
    // and warming it would pull IMAP before the reader needs it.
    void runWithConcurrency(items, ATTACHMENT_STAGE_CONCURRENCY, async (item) => {
      if (cancelled || controller.signal.aborted) return;
      try {
        const blob = await laneRef.current.start(item.key, () => fetchAttachmentBlob(item.attachment.url, { signal: controller.signal }));
        if (!cancelled && !controller.signal.aborted && blob) stagedRef.current.set(item.key, blob);
      } catch {
        // Staging is best-effort. A click still downloads that one attachment.
      }
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      controller.abort();
      stagedRef.current = new Map();
      laneRef.current.clear();
      busyRef.current.clear();
    };
  }, [thread.id, attachmentKey]);

  const reportProgress = (key, progress) => {
    setDownloadProgress((current) => ({ ...current, [key]: progress }));
  };

  const downloadAttachment = async (message, attachment, index) => {
    const key = attachmentDownloadKey(message.id, attachment, index);
    if (!beginDownload(busyRef.current, key)) return;
    reportProgress(key, { state: 'downloading', loaded: 0, total: 0 });
    const onProgress = ({ loaded, total }) => reportProgress(key, { state: 'downloading', loaded, total });
    try {
      let blob = stagedRef.current.get(key) || null;
      if (!blob && attachment.url) {
        blob = await laneRef.current.start(key, () => fetchAttachmentBlob(attachment.url, {
          signal: abortRef.current?.signal,
          onProgress,
        }));
        if (blob) stagedRef.current.set(key, blob);
      } else if (!blob && attachment.preview) {
        await previewAttachmentDownload({ signal: abortRef.current?.signal, onProgress });
      } else if (!blob) {
        throw new Error('This attachment has no download.');
      }
      if (blob) {
        saveBlob(blob, attachment.name || attachment.filename || 'attachment');
        stagedRef.current.delete(key);
      } else {
        onNotice?.('This preview mailbox has no file to save.');
      }
      setDownloadProgress((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        setDownloadProgress((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        return;
      }
      reportProgress(key, { state: 'failed' });
      onNotice?.('Could not download this attachment.');
    } finally {
      busyRef.current.delete(key);
    }
  };

  const openMessageMenu = (event, message, { expanded, canReplyAll }) => openMenu(event, messageContextMenu(message, {
    expanded,
    canReplyAll,
    handlers: {
      reply: (target) => onReply(thread, target),
      replyAll: (target) => onReplyAll(thread, target),
      forward: (target) => onForward(thread, target),
      toggleExpanded: (target) => toggleExpanded(target.id),
      copyText: copyWithNotice,
    },
  }));
  return (
    <section className="thread-panel" aria-label="Open conversation">
      <ThreadToolbar onBack={onBack} onAction={(action) => onAction(action, [thread.id])} isRead={!thread.unread} isAnalyzed={thread.analyzed !== false} />
      <div className="thread-scroll" ref={scrollerRef}>
        <div className="thread-heading" onContextMenu={openHeadingMenu}>
          <div className="thread-heading-main">
            <div className="thread-title-line">
              <h1>{thread.subject || '(no subject)'}</h1>
              <div className="heading-labels">
                <CategoryBadge thread={thread} showPrimary />
                {(thread.labels || []).map((label) => <span key={label} className="message-label">{label}</span>)}
                {activeFolder !== 'inbox' && <span className="message-label neutral-label">{activeFolder}</span>}
                {thread.analyzed === false
                  ? <span className="message-label analyzed-label is-pending" title="No agent has analyzed this conversation yet"><Icon name="sparkles" size={12} /> Not yet analyzed</span>
                  : thread.analyzedBy && <span className="message-label analyzed-label" title={thread.analyzedAt ? `Analyzed ${formatMessageDate(thread.analyzedAt)}` : undefined}><Icon name="sparkles" size={12} /> Analyzed by {thread.analyzedBy}</span>}
              </div>
            </div>
            <p className="category-reason"><Icon name="sparkles" size={13} />{classification.categoryReason}</p>
          </div>
        </div>
        <div className="conversation-stack" key={messageKey}>
          {sourceMessages.map((message, index) => (
            <MessageCard
              key={message.id}
              cardRef={index === sourceMessages.length - 1 ? latestRef : undefined}
              message={message}
              expanded={expandedIds.has(message.id)}
              onToggle={() => toggleExpanded(message.id)}
              onLoadRemote={onLoadRemote}
              onReply={(target) => onReply(thread, target)}
              onReplyAll={(target) => onReplyAll(thread, target)}
              onForward={(target) => onForward(thread, target)}
              onContextMenu={openMessageMenu}
              allowPrivateImages={allowPrivateImages}
              downloadProgress={downloadProgress}
              onDownloadAttachment={downloadAttachment}
            />
          ))}
        </div>
      </div>
      <ContextMenu menu={menu} onClose={closeMenu} />
    </section>
  );
}
