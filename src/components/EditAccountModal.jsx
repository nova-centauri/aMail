import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { normalizeAccount } from '../mail/normalize.js';
import { Icon } from './Icon.jsx';
import { IconButton } from './ui.jsx';

const connectionKeys = ['imapHost', 'imapPort', 'imapSecure', 'smtpHost', 'smtpPort', 'smtpSecure', 'imapUsername', 'smtpUsername'];

function formFromSettings(account, credentials) {
  return {
    displayName: account.displayName || account.name || '',
    syncEnabled: account.syncEnabled !== false,
    password: '',
    imapHost: account.imap?.host || '',
    imapPort: String(account.imap?.port || 993),
    imapSecure: account.imap?.secure !== false,
    smtpHost: account.smtp?.host || '',
    smtpPort: String(account.smtp?.port || 465),
    smtpSecure: account.smtp?.secure !== false,
    imapUsername: credentials.imapUsername || credentials.username || account.email || '',
    smtpUsername: credentials.smtpUsername || credentials.username || account.email || '',
  };
}

function settingsError(error, operation) {
  if (error?.status === 401 || error?.status === 403) return 'Unlock aMail, then try again.';
  if (error?.status === 404) return 'This account is no longer available. Close this dialog and refresh aMail.';
  if (error?.status === 409) return 'This account changed while saving. Close and reopen this dialog to load its latest settings, then try again.';
  if (error?.code === 'CREDENTIAL_ENCRYPTION_UNAVAILABLE') return 'The server cannot securely store the replacement password. Its credential encryption needs to be configured.';
  if (operation === 'load') return 'Could not load account settings. Try again.';
  if (operation === 'remove') return 'Could not remove this account. No removal was confirmed. Try again.';
  return 'Could not save account settings. Check the server settings, usernames, and app-specific password, then try again.';
}

export function EditAccountModal({ account, onClose, onUpdated, onRemoved, removalBlockedReason = '' }) {
  const [form, setForm] = useState(null);
  const [original, setOriginal] = useState(null);
  const [phase, setPhase] = useState('loading');
  const [error, setError] = useState('');
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const dialogRef = useRef(null);
  const nameRef = useRef(null);
  const keepAccountRef = useRef(null);
  const removeButtonRef = useRef(null);
  const busyRef = useRef(true);
  const closeRef = useRef(null);
  const initiallyFocusedRef = useRef(false);
  const busy = phase !== '';
  const clearPassword = () => setForm((current) => current ? { ...current, password: '' } : current);
  const close = () => {
    if (busyRef.current) return;
    clearPassword();
    onClose();
  };
  closeRef.current = close;

  useEffect(() => {
    const previousFocus = document.activeElement;
    dialogRef.current?.focus();
    const handleKeys = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busyRef.current) closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll(':is(button, input, select, summary):not(:disabled)')].filter((element) => {
        const details = element.closest('details');
        return element.tabIndex >= 0 && (!details || details.open || element.tagName === 'SUMMARY') && !element.closest('[hidden]');
      });
      if (!focusable.length) { event.preventDefault(); dialogRef.current.focus(); return; }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', handleKeys);
    return () => { window.removeEventListener('keydown', handleKeys); previousFocus?.focus?.(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    busyRef.current = true;
    setPhase('loading');
    setError('');
    api(`/accounts/${encodeURIComponent(account.id)}/settings`, { signal: controller.signal })
      .then((result) => {
        if (!active) return;
        const settings = formFromSettings(result.account, result.credentials || {});
        setForm(settings);
        setOriginal(settings);
      })
      .catch((requestError) => { if (active) setError(settingsError(requestError, 'load')); })
      .finally(() => { if (active) { busyRef.current = false; setPhase(''); } });
    return () => { active = false; controller.abort(); };
  }, [account.id, loadAttempt]);

  useEffect(() => {
    if (original && !busy && !initiallyFocusedRef.current) {
      initiallyFocusedRef.current = true;
      nameRef.current?.focus();
    }
  }, [original, busy]);
  useEffect(() => { if (confirmRemoval) keepAccountRef.current?.focus(); }, [confirmRemoval]);

  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.type === 'checkbox' ? event.target.checked : event.target.value }));
  const connectionChanged = Boolean(form && original && (form.password.trim() || connectionKeys.some((key) => form[key] !== original[key])));
  const changed = Boolean(form && original && (connectionChanged || form.displayName !== original.displayName || form.syncEnabled !== original.syncEnabled));

  const save = async (event) => {
    event.preventDefault();
    if (busyRef.current || !form || !original || !changed || confirmRemoval) return;
    const payload = {};
    if (form.displayName !== original.displayName) payload.displayName = form.displayName.trim();
    if (form.syncEnabled !== original.syncEnabled) payload.syncEnabled = form.syncEnabled;
    const credentials = {};
    if (form.password.trim()) credentials.password = form.password;
    for (const protocol of ['imap', 'smtp']) {
      const key = `${protocol}Username`;
      if (form[key] !== original[key]) {
        if (!form[key].trim()) { setError(`Enter an ${protocol.toUpperCase()} username.`); return; }
        credentials[key] = form[key].trim();
      }
      if (['Host', 'Port', 'Secure'].some((part) => form[`${protocol}${part}`] !== original[`${protocol}${part}`])) {
        const host = form[`${protocol}Host`].trim();
        const port = Number(form[`${protocol}Port`]);
        if (!host || !Number.isInteger(port) || port < 1 || port > 65535) { setError(`Enter a valid ${protocol.toUpperCase()} host and port.`); return; }
        payload[protocol] = { host, port, secure: form[`${protocol}Secure`] };
      }
    }
    if (Object.keys(credentials).length) payload.credentials = credentials;
    busyRef.current = true;
    setPhase('saving');
    setError('');
    try {
      const result = await api(`/accounts/${encodeURIComponent(account.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      clearPassword();
      onUpdated?.(normalizeAccount(result.account || result));
      onClose();
    } catch (requestError) {
      setError(settingsError(requestError, 'save'));
    } finally {
      busyRef.current = false;
      setPhase('');
    }
  };

  const remove = async () => {
    if (busyRef.current || !confirmRemoval || !onRemoved || removalBlockedReason) return;
    busyRef.current = true;
    setPhase('removing');
    setError('');
    try {
      await api(`/accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE' });
      clearPassword();
      onRemoved(account.id);
      onClose();
    } catch (requestError) {
      setError(settingsError(requestError, 'remove'));
    } finally {
      busyRef.current = false;
      setPhase('');
    }
  };

  return (
    <div className="modal-layer">
      <button type="button" className="modal-scrim" onClick={close} aria-label="Close account settings" disabled={busy} />
      <div ref={dialogRef} tabIndex={-1} className="account-modal account-editor" role="dialog" aria-modal="true" aria-labelledby="edit-account-title" aria-describedby="edit-account-subtitle" aria-busy={busy}>
        <div className="account-modal-header">
          <div className="account-modal-title"><div><h2 id="edit-account-title">Account settings</h2><p id="edit-account-subtitle">{account.email}</p></div></div>
          <IconButton label="Close" onClick={close} disabled={busy}><Icon name="close" /></IconButton>
        </div>
        <form className="account-edit-form" onSubmit={save}>
          <div className="account-modal-scroll account-details-step">
            {phase === 'loading' && <p role="status">Loading account settings…</p>}
            {form && !confirmRemoval && (
              <fieldset className="account-edit-fieldset" disabled={busy}>
                <div className="account-fields-grid">
                  <label className="form-field"><span>Email address</span><input type="email" value={account.email} readOnly /></label>
                  <label className="form-field"><span>Display name</span><input ref={nameRef} value={form.displayName} onChange={update('displayName')} autoComplete="name" /></label>
                </div>
                <label className="form-field password-field"><span id="replacement-password-label">Replacement app-specific password</span><input type="password" aria-labelledby="replacement-password-label" value={form.password} onChange={update('password')} placeholder="Leave blank to keep the current password" autoComplete="new-password" spellCheck="false" autoCapitalize="none" aria-describedby="replacement-password-help" /><small id="replacement-password-help">Leave blank to keep the current password. A replacement is tested with IMAP and SMTP before it is saved securely.</small></label>
                <label className="account-edit-toggle"><input type="checkbox" checked={form.syncEnabled} onChange={update('syncEnabled')} /><span>Sync this account</span></label>
                <details className="advanced-connection">
                  <summary onClick={(event) => { if (busy) event.preventDefault(); }} tabIndex={busy ? -1 : 0}>Advanced connection settings</summary>
                  {['imap', 'smtp'].map((protocol) => (
                    <div className="provider-grid" key={protocol}>
                      <label className="form-field"><span>{protocol.toUpperCase()} host</span><input value={form[`${protocol}Host`]} onChange={update(`${protocol}Host`)} spellCheck="false" autoCapitalize="none" /></label>
                      <label className="form-field"><span>{protocol.toUpperCase()} port</span><input type="number" min="1" max="65535" value={form[`${protocol}Port`]} onChange={update(`${protocol}Port`)} /></label>
                      <label className="form-field"><span>{protocol.toUpperCase()} username</span><input value={form[`${protocol}Username`]} onChange={update(`${protocol}Username`)} spellCheck="false" autoCapitalize="none" autoComplete="off" /></label>
                      <label className="connection-security"><input type="checkbox" aria-label={`${protocol.toUpperCase()} implicit TLS`} checked={form[`${protocol}Secure`]} onChange={update(`${protocol}Secure`)} /><span>Implicit TLS</span><small>{form[`${protocol}Secure`] ? 'TLS from connection start' : 'Use STARTTLS'}</small></label>
                    </div>
                  ))}
                </details>
                {onRemoved && <section className="account-remove-section"><h3>Remove account</h3><p>Disconnect this account and remove its local data from aMail.</p>{removalBlockedReason && <p id="account-removal-blocked">{removalBlockedReason}</p>}<button ref={removeButtonRef} type="button" className="danger-button" disabled={Boolean(removalBlockedReason)} aria-describedby={removalBlockedReason ? 'account-removal-blocked' : undefined} onClick={() => { setError(''); setConfirmRemoval(true); }}>Remove account…</button></section>}
              </fieldset>
            )}
            {confirmRemoval && (
              <section className="account-remove-confirmation" aria-labelledby="remove-account-title">
                <h3 id="remove-account-title">Remove {account.email}?</h3>
                <p className="account-removal-warning">This removes the account, its cached messages, local drafts, and analyzed status from aMail. Email stored with your mail provider is not deleted.</p>
                <p>You can add the account again, but downloaded messages will need to be analyzed again.</p>
              </section>
            )}
            {phase === 'saving' && <p role="status">{connectionChanged ? 'Verifying IMAP and SMTP, then saving…' : 'Saving account settings…'}</p>}
            {phase === 'removing' && <p role="status">Removing account and local data…</p>}
            {error && <p className="form-error account-form-error" role="alert">{error}</p>}
            {!form && !busy && <button type="button" className="text-button" onClick={() => setLoadAttempt((current) => current + 1)}>Retry loading settings</button>}
          </div>
          <div className="account-modal-footer">
            {confirmRemoval ? <><button ref={keepAccountRef} type="button" className="text-button" disabled={busy} onClick={() => { setConfirmRemoval(false); setError(''); window.requestAnimationFrame(() => removeButtonRef.current?.focus()); }}>Keep account</button><button type="button" className="danger-button" disabled={busy || Boolean(removalBlockedReason)} onClick={remove}>{phase === 'removing' ? 'Removing…' : 'Remove account and local data'}</button></> : <><button type="button" className="text-button" onClick={close} disabled={busy}>Cancel</button><button type="submit" className="primary-button" disabled={busy || !changed}>{phase === 'saving' ? 'Saving…' : connectionChanged ? 'Test & save changes' : 'Save changes'}</button></>}
          </div>
        </form>
      </div>
    </div>
  );
}
