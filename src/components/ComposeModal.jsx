import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { formatAttachmentSize } from '../mail/dates.js';
import { parseRecipientList } from '../mail/people.js';
import { editorHtmlToStored, htmlToPlainText, signaturePreviewHtml, storedComposeToEditorHtml } from '../mail/signature.js';
import { Icon } from './Icon.jsx';
import { IconButton } from './ui.jsx';
import { RecipientField } from './RecipientField.jsx';
import { SignatureEditor } from './SignatureEditor.jsx';

export const MAX_COMPOSE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_COMPOSE_ATTACHMENT_COUNT = 8;
export const MAX_COMPOSE_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;

async function readFileAsAttachment(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return {
    filename: file.name || 'attachment',
    contentType: file.type || 'application/octet-stream',
    size: Number(file.size) || bytes.length,
    content: btoa(binary),
  };
}

function initialHtmlBody(initialReply) {
  if (initialReply?.htmlBody) return storedComposeToEditorHtml(initialReply.htmlBody);
  if (initialReply?.body) return storedComposeToEditorHtml(initialReply.body);
  return '';
}

export function ComposeModal({ account, accounts, contacts = [], isDemo, onClose, onSent, onDraftSaved, onDraftRemoved, initialReply, closing = false }) {
  const [to, setTo] = useState(() => parseRecipientList(initialReply?.to || ''));
  const [cc, setCc] = useState(() => parseRecipientList(initialReply?.cc || ''));
  const [bcc, setBcc] = useState(() => parseRecipientList(initialReply?.bcc || ''));
  const [subject, setSubject] = useState(initialReply?.subject || '');
  const [htmlBody, setHtmlBody] = useState(() => initialHtmlBody(initialReply));
  const [attachments, setAttachments] = useState(initialReply?.attachments || []);
  const [extraFields, setExtraFields] = useState(Boolean(initialReply?.cc || initialReply?.bcc));
  const [isMinimized, setIsMinimized] = useState(false);
  const [isExpanded, setIsExpanded] = useState(Boolean(initialReply?.expanded));
  const [isSending, setIsSending] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [draftId, setDraftId] = useState(initialReply?.draftId || '');
  const [error, setError] = useState('');
  const [senderId, setSenderId] = useState(initialReply?.accountId || account?.id || accounts[0]?.id || '');
  const toRef = useRef(to);
  const ccRef = useRef(cc);
  const bccRef = useRef(bcc);
  const subjectRef = useRef(subject);
  const htmlBodyRef = useRef(htmlBody);
  const attachmentsRef = useRef(attachments);
  const draftIdRef = useRef(draftId);
  const fileRef = useRef(null);
  toRef.current = to;
  ccRef.current = cc;
  bccRef.current = bcc;
  subjectRef.current = subject;
  htmlBodyRef.current = htmlBody;
  attachmentsRef.current = attachments;
  draftIdRef.current = draftId;
  useEffect(() => {
    setSenderId((current) => accounts.some((item) => item.id === current) ? current : initialReply?.accountId || account?.id || accounts[0]?.id || '');
  }, [account?.id, accounts, initialReply?.accountId]);
  const senderAccount = accounts.find((item) => item.id === senderId) || account || accounts[0] || null;
  const recipientPayload = (list) => list.map((person) => ({
    name: person.name || '',
    email: person.email,
  }));
  const hasUnsavedContent = () => Boolean(
    toRef.current.length
    || ccRef.current.length
    || bccRef.current.length
    || subjectRef.current.trim()
    || htmlToPlainText(htmlBodyRef.current)
    || attachmentsRef.current.length
    || draftIdRef.current,
  );
  const composeBodies = () => {
    const storedHtml = editorHtmlToStored(htmlBody);
    return {
      htmlBody: storedHtml,
      textBody: htmlToPlainText(storedHtml || htmlBody),
    };
  };
  const draftPayload = () => ({
    accountId: senderAccount?.id,
    threadId: initialReply?.threadId || null,
    to: recipientPayload(to),
    cc: recipientPayload(cc),
    bcc: recipientPayload(bcc),
    subject,
    ...composeBodies(),
    attachments,
  });
  const saveDraft = async ({ closeAfter = true } = {}) => {
    if (isSending || isSavingDraft) return false;
    if (!hasUnsavedContent()) {
      if (closeAfter) onClose();
      return true;
    }
    if (!senderAccount?.id) {
      setError('Connect an account before saving this draft.');
      return false;
    }
    setError('');
    setIsSavingDraft(true);
    const payload = draftPayload();
    try {
      if (isDemo) {
        const localId = draftId || `preview-${Date.now()}`;
        const draft = { id: localId, ...payload, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        setDraftId(localId);
        onDraftSaved(draft, senderAccount, true);
      } else {
        const result = await api(draftId ? `/drafts/${encodeURIComponent(draftId)}` : '/drafts', { method: draftId ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
        const draft = result?.draft || result;
        setDraftId(draft?.id || draftId);
        onDraftSaved(draft, senderAccount, false);
      }
      if (closeAfter) onClose();
      return true;
    } catch (requestError) {
      setError(requestError.status === 401 || requestError.status === 403 ? 'Unlock aMail before saving this draft.' : `Draft could not be saved. ${requestError.message || 'Check the server connection and try again.'}`);
      return false;
    } finally {
      setIsSavingDraft(false);
    }
  };
  const discardDraft = async () => {
    if (isSending || isSavingDraft) return;
    if (!draftId) { onClose(); return; }
    setIsSavingDraft(true);
    setError('');
    try {
      if (!isDemo) await api(`/drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' });
      onDraftRemoved(draftId);
      onClose();
    } catch (requestError) {
      setError(`The saved draft could not be discarded. ${requestError.message || 'Try again when the server is available.'}`);
    } finally {
      setIsSavingDraft(false);
    }
  };
  useEffect(() => {
    const handleEscape = (event) => {
      if (closing || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (isExpanded) {
        setIsExpanded(false);
        return;
      }
      if (isMinimized) {
        onClose();
        return;
      }
      void saveDraft({ closeAfter: true });
    };
    window.addEventListener('keydown', handleEscape, true);
    return () => window.removeEventListener('keydown', handleEscape, true);
  });
  const addFiles = async (fileList) => {
    const files = [...(fileList || [])];
    if (!files.length) return;
    const current = attachmentsRef.current;
    if (current.length + files.length > MAX_COMPOSE_ATTACHMENT_COUNT) {
      setError(`Attach at most ${MAX_COMPOSE_ATTACHMENT_COUNT} files.`);
      return;
    }
    try {
      const next = [...current];
      for (const file of files) {
        if (file.size > MAX_COMPOSE_ATTACHMENT_BYTES) {
          setError(`${file.name || 'A file'} is larger than 8 MB.`);
          return;
        }
        next.push(await readFileAsAttachment(file));
      }
      const total = next.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
      if (total > MAX_COMPOSE_ATTACHMENT_TOTAL_BYTES) {
        setError('Attached files together must stay under 8 MB.');
        return;
      }
      setAttachments(next);
      setError('');
    } catch (readError) {
      setError(readError.message || 'The file could not be attached.');
    }
  };
  const removeAttachment = (index) => {
    setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index));
  };
  const send = async (event) => {
    event.preventDefault();
    if (!to.length && !cc.length && !bcc.length) { setError('Add at least one recipient.'); return; }
    if ([...to, ...cc, ...bcc].some((person) => person.valid === false)) {
      setError('Fix or remove the invalid recipient address.');
      return;
    }
    if (!senderAccount?.id && !isDemo) { setError('Connect an account before sending.'); return; }
    setError('');
    setIsSending(true);
    const { htmlBody: nextHtml, textBody } = composeBodies();
    const payload = {
      to: recipientPayload(to),
      cc: recipientPayload(cc),
      bcc: recipientPayload(bcc),
      subject,
      textBody,
      htmlBody: nextHtml,
      accountId: senderAccount?.id,
      attachments,
      ...(draftId ? { draftId } : {}),
      ...(initialReply?.threadId ? { threadId: initialReply.threadId } : {}),
      ...(initialReply?.replyToMessageId ? { replyToMessageId: initialReply.replyToMessageId } : {}),
    };
    try {
      if (isDemo) {
        if (draftId) onDraftRemoved(draftId);
        onSent(payload, true, senderAccount, null);
        onClose();
        return;
      }
      const result = await api('/messages', { method: 'POST', body: JSON.stringify(payload) });
      if (draftId) onDraftRemoved(draftId);
      onSent(payload, false, senderAccount, result);
      onClose();
    } catch (requestError) {
      const rejectedDelivery = requestError.details?.delivery;
      const rejectedCount = Number(rejectedDelivery?.recipientCount) || 0;
      setError(requestError.status === 401 || requestError.status === 403
        ? 'Unlock aMail before sending. Your message is still open.'
        : rejectedDelivery?.status === 'rejected'
          ? `The provider rejected ${rejectedCount ? `all ${rejectedCount} recipients` : 'all recipients'}. Check the addresses and try again; your message is still open.`
          : 'Could not send this message. Check the connection and try again, or save it as a draft.');
    } finally {
      setIsSending(false);
    }
  };
  return (
    <div className={`compose-window ${closing ? 'is-closing' : ''} ${isMinimized ? 'is-minimized' : ''} ${isExpanded ? 'is-expanded' : ''}`} role="dialog" aria-modal="true" aria-label="New message">
      <div className="compose-titlebar">
        <span>{draftId ? 'Draft' : initialReply?.mode === 'reply' || initialReply?.mode === 'reply-all' ? 'Reply' : initialReply?.mode === 'forward' ? 'Forward' : 'New Message'}</span>
        <div>
          <IconButton label={isMinimized ? 'Restore' : 'Minimize'} onClick={() => { setIsMinimized((value) => !value); if (!isMinimized) setIsExpanded(false); }}><Icon name="minimize" size={17} /></IconButton>
          <IconButton label={isExpanded ? 'Exit full screen' : 'Full screen'} onClick={() => { setIsExpanded((value) => !value); setIsMinimized(false); }}><Icon name="expand" size={16} /></IconButton>
          <IconButton label={isSavingDraft ? 'Saving draft' : 'Save and close'} onClick={() => void saveDraft({ closeAfter: true })} disabled={isSending || isSavingDraft}><Icon name="close" size={17} /></IconButton>
        </div>
      </div>
      {!isMinimized && (
        <form className="compose-form email-light" onSubmit={send}>
          <div className="recipient-line">
            <RecipientField
              label="Recipients"
              values={to}
              onChange={setTo}
              contacts={contacts}
              placeholder="Recipients"
              autoFocus={!initialReply?.draftId}
              extra={<button type="button" onClick={() => setExtraFields((value) => !value)}>{extraFields ? 'Hide' : 'Cc Bcc'}</button>}
            />
          </div>
          {accounts.length > 1 && (
            <div className="recipient-line from-line">
              <span>From</span>
              <select value={senderId} onChange={(event) => setSenderId(event.target.value)} aria-label="Send from account" disabled={Boolean(draftId)} title={draftId ? 'A saved draft stays with its original account' : undefined}>
                {accounts.map((item) => <option key={item.id} value={item.id}>{item.name} &lt;{item.email}&gt;</option>)}
              </select>
            </div>
          )}
          {extraFields && (
            <>
              <div className="recipient-line">
                <RecipientField label="Cc" values={cc} onChange={setCc} contacts={contacts} placeholder="Cc" />
              </div>
              <div className="recipient-line">
                <RecipientField label="Bcc" values={bcc} onChange={setBcc} contacts={contacts} placeholder="Bcc" />
              </div>
            </>
          )}
          <div className="recipient-line subject-line"><input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Subject" aria-label="Subject" /></div>
          <SignatureEditor
            variant="compose"
            compact
            value={htmlBody}
            onChange={setHtmlBody}
            placeholder="Write your message"
            ariaLabel="Message body"
          />
          {senderAccount?.signature && (
            <div
              className="signature-preview"
              dangerouslySetInnerHTML={{ __html: signaturePreviewHtml(senderAccount.signature) }}
            />
          )}
          {attachments.length > 0 && (
            <div className="compose-attachments" aria-label="Attachments">
              {attachments.map((attachment, index) => (
                <span className="attachment-chip" key={`${attachment.filename}-${index}`}>
                  <Icon name="attachment" size={17} />
                  <span>{attachment.filename || attachment.name || 'Attachment'}</span>
                  <small>{formatAttachmentSize(attachment.size)}</small>
                  <IconButton label={`Remove ${attachment.filename || 'attachment'}`} onClick={() => removeAttachment(index)}><Icon name="close" size={14} /></IconButton>
                </span>
              ))}
            </div>
          )}
          {error && <p className="compose-error" role="alert">{error}</p>}
          <div className="compose-footer">
            <button type="submit" className="send-button" disabled={isSending || isSavingDraft}>{isSending ? 'Sending…' : 'Send'}</button>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              aria-label="Choose files to attach"
              onChange={(event) => {
                void addFiles(event.target.files);
                event.target.value = '';
              }}
            />
            <IconButton label="Attach files" onClick={() => fileRef.current?.click()}><Icon name="attachment" /></IconButton>
            <span className="compose-spacer" />
            <IconButton label="Discard draft" onClick={discardDraft} disabled={isSending || isSavingDraft}><Icon name="trash" /></IconButton>
          </div>
        </form>
      )}
    </div>
  );
}
