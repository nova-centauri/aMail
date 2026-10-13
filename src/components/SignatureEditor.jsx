import { useEffect, useRef, useState } from 'react';
import {
  COMPOSE_MAX_LENGTH,
  editorHtmlToStored,
  extractHtmlDocumentBody,
  looksLikeHtml,
  readFileAsDataUrl,
  readFileAsText,
  sanitizeSignatureHtml,
  SIGNATURE_HTML_UPLOAD_MAX_BYTES,
  SIGNATURE_IMAGE_MAX_BYTES,
  SIGNATURE_MAX_LENGTH,
  storedSignatureToEditorHtml,
  validateSignatureLength,
} from '../mail/signature.js';
import { Icon } from './Icon.jsx';

function runCommand(command, value) {
  try {
    return document.execCommand(command, false, value);
  } catch {
    return false;
  }
}

export function SignatureEditor({
  value = '',
  savedValue,
  onChange,
  onSave,
  disabled = false,
  compact = false,
  variant = 'signature',
  placeholder,
  ariaLabel,
}) {
  const isCompose = variant === 'compose';
  const visualLabel = ariaLabel || (isCompose ? 'Message body' : 'Signature');
  const sourceLabel = isCompose ? 'Message HTML' : 'Signature HTML';
  const placeholderText = placeholder || (isCompose ? 'Write your message' : 'Write or paste your signature');
  const maxLength = isCompose ? COMPOSE_MAX_LENGTH : SIGNATURE_MAX_LENGTH;
  const modeLabel = isCompose ? 'Message editor mode' : 'Signature editor mode';
  const formatLabel = isCompose ? 'Message formatting' : 'Signature formatting';
  const imageError = isCompose ? 'Choose an image smaller than 80 KB.' : 'Choose a signature image smaller than 80 KB.';
  const imageInputLabel = isCompose ? 'Insert message image' : 'Insert signature image';
  const htmlInputLabel = isCompose ? 'Upload message HTML' : 'Upload signature HTML';
  const [mode, setMode] = useState('visual');
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('https://');
  const rootRef = useRef(null);
  const visualRef = useRef(null);
  const sourceRef = useRef(null);
  const htmlFileRef = useRef(null);
  const imageFileRef = useRef(null);
  const skipVisualSync = useRef(false);
  // Compose keeps the live DOM. Sanitizing or rewriting it on each key stalls typing.
  const composeDomOwnsValue = useRef(false);
  const draftRef = useRef(draft);
  const savedRange = useRef(null);
  draftRef.current = draft;
  const baseline = savedValue === undefined ? value : savedValue;
  const dirty = draft !== (baseline || '');

  useEffect(() => {
    if (isCompose && composeDomOwnsValue.current) return;
    setDraft(value);
    setError('');
  }, [value, isCompose]);

  useEffect(() => {
    if (mode !== 'visual' || !visualRef.current) return;
    if (isCompose && composeDomOwnsValue.current) return;
    if (skipVisualSync.current) {
      skipVisualSync.current = false;
      return;
    }
    const next = isCompose ? String(draft || '') : storedSignatureToEditorHtml(draft);
    if (visualRef.current.innerHTML !== next) visualRef.current.innerHTML = next;
  }, [draft, mode, isCompose]);

  const persistable = (next) => {
    const raw = String(next ?? '');
    if (!raw.trim()) return '';
    return looksLikeHtml(raw)
      ? sanitizeSignatureHtml(extractHtmlDocumentBody(raw))
      : raw.replace(/\r\n/g, '\n');
  };

  const commit = (next, { save = false } = {}) => {
    const stored = save ? persistable(next) : next;
    const lengthError = validateSignatureLength(stored, maxLength);
    if (lengthError) {
      setError(lengthError);
      return false;
    }
    setError('');
    setDraft(stored);
    onChange?.(stored);
    if (save) onSave?.(stored);
    return true;
  };

  const persistDraft = (next = draftRef.current) => commit(next, { save: true });

  const readVisual = () => editorHtmlToStored(visualRef.current?.innerHTML || '');

  const handleVisualInput = () => {
    if (isCompose) {
      composeDomOwnsValue.current = true;
      onChange?.(visualRef.current?.innerHTML || '');
      return;
    }
    skipVisualSync.current = true;
    commit(readVisual());
  };

  const rememberSelection = () => {
    const selection = window.getSelection();
    if (selection?.rangeCount) savedRange.current = selection.getRangeAt(0);
  };

  const restoreSelection = () => {
    visualRef.current?.focus();
    const selection = window.getSelection();
    if (!selection || !savedRange.current) return;
    selection.removeAllRanges();
    selection.addRange(savedRange.current);
  };

  const format = (command, commandValue) => {
    if (disabled) return;
    restoreSelection();
    runCommand(command, commandValue);
    handleVisualInput();
    rememberSelection();
  };

  const applyUploadedHtml = (raw, { save = true } = {}) => {
    const cleaned = sanitizeSignatureHtml(extractHtmlDocumentBody(raw)) || String(raw || '').trim();
    if (!commit(cleaned, { save })) return;
    setMode('visual');
    setLinkOpen(false);
  };

  const chooseHtmlFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const looksHtml = /\.html?$/i.test(file.name) || file.type === 'text/html' || file.type === 'application/xhtml+xml' || !file.type;
    if (!looksHtml) {
      setError('Choose an .html file.');
      return;
    }
    if (file.size > SIGNATURE_HTML_UPLOAD_MAX_BYTES) {
      setError('Choose an HTML file smaller than 400 KB.');
      return;
    }
    try {
      applyUploadedHtml(await readFileAsText(file));
    } catch (readError) {
      setError(readError.message || 'The HTML file could not be read.');
    }
  };

  const chooseImage = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|gif|webp)$/i.test(file.type)) {
      setError('Choose a PNG, JPEG, GIF, or WebP image.');
      return;
    }
    if (file.size > SIGNATURE_IMAGE_MAX_BYTES) {
      setError(imageError);
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      restoreSelection();
      runCommand('insertHTML', `<img src="${dataUrl}" alt="">`);
      handleVisualInput();
    } catch (readError) {
      setError(readError.message || 'The image could not be read.');
    }
  };

  const handleVisualPaste = (event) => {
    const html = event.clipboardData?.getData('text/html');
    if (!html) return;
    event.preventDefault();
    const cleaned = sanitizeSignatureHtml(extractHtmlDocumentBody(html));
    runCommand('insertHTML', cleaned || event.clipboardData.getData('text/plain') || '');
    handleVisualInput();
  };

  const pasteHtml = async () => {
    if (disabled) return;
    if (navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (text.trim()) {
          applyUploadedHtml(text, { save: Boolean(onSave) });
          return;
        }
      } catch {
        // Fall through to the HTML tab when the clipboard is blocked.
      }
    }
    setMode('html');
    setLinkOpen(false);
    window.requestAnimationFrame(() => sourceRef.current?.focus());
  };

  const applyLink = () => {
    const href = linkUrl.trim();
    if (!href) return;
    format('createLink', href);
    setLinkOpen(false);
    setLinkUrl('https://');
  };

  const handleBlur = (event) => {
    if (rootRef.current?.contains(event.relatedTarget)) return;
    if (onSave && draftRef.current !== (baseline || '')) persistDraft(draftRef.current);
  };

  const handleKeyDown = (event) => {
    if (event.key !== 'Escape' || !linkOpen) return;
    event.preventDefault();
    event.stopPropagation();
    setLinkOpen(false);
  };

  return (
    <div
      ref={rootRef}
      className={`signature-editor ${compact ? 'is-compact' : ''} ${disabled ? 'is-disabled' : ''} ${isCompose ? 'is-compose' : ''}`}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      <div className="signature-editor-toolbar">
        <div className="signature-editor-modes" role="tablist" aria-label={modeLabel}>
          <button type="button" role="tab" aria-selected={mode === 'visual'} className={mode === 'visual' ? 'is-selected' : ''} disabled={disabled} onClick={() => { if (mode === 'html') composeDomOwnsValue.current = false; setMode('visual'); setLinkOpen(false); }}>Visual</button>
          <button type="button" role="tab" aria-selected={mode === 'html'} className={mode === 'html' ? 'is-selected' : ''} disabled={disabled} onClick={() => { if (isCompose && visualRef.current) { const raw = visualRef.current.innerHTML; composeDomOwnsValue.current = false; setDraft(raw); onChange?.(raw); } setMode('html'); }}>HTML</button>
        </div>
        {mode === 'visual' && (
          <div className="signature-editor-format" role="toolbar" aria-label={formatLabel}>
            <button type="button" aria-label="Bold" disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => format('bold')}><b>B</b></button>
            <button type="button" aria-label="Italic" disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => format('italic')}><i>I</i></button>
            <button type="button" aria-label="Underline" disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => format('underline')}><u>U</u></button>
            <button type="button" aria-label="Bulleted list" disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => format('insertUnorderedList')}>•</button>
            <button type="button" aria-label="Numbered list" disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => format('insertOrderedList')}>1.</button>
            <label className="signature-editor-color" title="Text color">
              <span>A</span>
              <input type="color" aria-label="Text color" disabled={disabled} defaultValue="#202124" onMouseDown={rememberSelection} onChange={(event) => format('foreColor', event.target.value)} />
            </label>
            <button type="button" aria-label="Insert link" disabled={disabled} onMouseDown={(event) => { event.preventDefault(); rememberSelection(); }} onClick={() => setLinkOpen((open) => !open)}><Icon name="link" size={15} /></button>
            <button type="button" aria-label="Insert image" disabled={disabled} onMouseDown={(event) => { event.preventDefault(); rememberSelection(); }} onClick={() => imageFileRef.current?.click()}><Icon name="image" size={15} /></button>
          </div>
        )}
      </div>
      {linkOpen && mode === 'visual' && (
        <div className="signature-editor-link">
          <input value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} placeholder="https://" aria-label="Link URL" disabled={disabled} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); applyLink(); } }} />
          <button type="button" className="text-button" disabled={disabled} onClick={applyLink}>Apply</button>
        </div>
      )}
      {mode === 'visual' ? (
        <div
          ref={visualRef}
          className="signature-editor-visual"
          contentEditable={!disabled}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={visualLabel}
          aria-disabled={disabled}
          data-placeholder={placeholderText}
          onInput={handleVisualInput}
          onPaste={handleVisualPaste}
          onMouseUp={rememberSelection}
          onKeyUp={rememberSelection}
        />
      ) : (
        <textarea
          ref={sourceRef}
          className="signature-editor-source"
          value={draft}
          disabled={disabled}
          spellCheck={false}
          aria-label={sourceLabel}
          placeholder="Paste or write HTML…"
          onChange={(event) => commit(event.target.value)}
        />
      )}
      {!isCompose && (
        <div className="signature-editor-actions">
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => htmlFileRef.current?.click()}>
            <Icon name="attachment" size={15} /> Upload HTML
          </button>
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => void pasteHtml()}>
            Paste HTML
          </button>
          {onSave && (
            <button type="button" className="secondary-button" disabled={disabled || !dirty} onClick={() => persistDraft(draft)}>
              Save
            </button>
          )}
          <button type="button" className="text-button" disabled={disabled || !draft} onClick={() => { persistDraft(''); setMode('visual'); }}>
            Clear
          </button>
        </div>
      )}
      <input ref={htmlFileRef} type="file" accept=".html,.htm,text/html,application/xhtml+xml" hidden aria-label={htmlInputLabel} onChange={(event) => void chooseHtmlFile(event)} />
      <input ref={imageFileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden aria-label={imageInputLabel} onChange={(event) => void chooseImage(event)} />
      {error && <p className="signature-editor-error" role="alert">{error}</p>}
      {!isCompose && <p className="signature-editor-hint">Upload an HTML file, paste HTML, or edit visually. Scripts and tracking markup are removed before the signature is saved or sent.</p>}
    </div>
  );
}
