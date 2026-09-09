import { useEffect, useState } from 'react';
import { BrandMark, Icon } from './Icon.jsx';

export function AccessPanel({
  open,
  required,
  currentToken,
  onSave,
  onClose,
  passkeyCount = 0,
  canUsePasskeys = false,
  onPasskeyLogin,
  authenticated = false,
  onRegisterPasskey,
  keyMode = 'env',
}) {
  // Keyslot mode (hosted): any keyslot credential unlocks, not one fixed token.
  const keyslot = keyMode === 'keyslot';
  const credentialLabel = keyslot ? 'Access token, passphrase, or recovery code' : 'Access token';
  const [token, setToken] = useState(currentToken || '');
  const [saving, setSaving] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [showToken, setShowToken] = useState(passkeyCount === 0);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setToken(currentToken || '');
      setError('');
      setShowToken(passkeyCount === 0);
    }
  }, [open, currentToken, passkeyCount]);
  if (!open) return null;

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await onSave(token.trim());
    } catch (requestError) {
      setError(requestError.message || 'That token did not unlock this server.');
    } finally {
      setSaving(false);
    }
  };

  const usePasskey = async () => {
    setPasskeyBusy(true);
    setError('');
    try {
      await onPasskeyLogin();
    } catch (requestError) {
      if (requestError?.name === 'NotAllowedError') setError('Passkey sign-in was cancelled.');
      else setError(requestError.message || 'Passkey sign-in failed.');
    } finally {
      setPasskeyBusy(false);
    }
  };

  const addPasskey = async () => {
    setPasskeyBusy(true);
    setError('');
    try {
      await onRegisterPasskey();
    } catch (requestError) {
      if (requestError?.name === 'NotAllowedError') setError('Passkey registration was cancelled.');
      else setError(requestError.message || 'Could not add a passkey.');
    } finally {
      setPasskeyBusy(false);
    }
  };

  const passkeyPrimary = required && canUsePasskeys && passkeyCount > 0;

  return (
    <div className="modal-layer access-layer" role="dialog" aria-modal="true" aria-label="Unlock aMail">
      {!required && <button type="button" className="modal-scrim" onClick={onClose} aria-label="Close unlock dialog" />}
      <form className="access-modal" onSubmit={submit}>
        <div className="access-mark">{passkeyPrimary ? <Icon name="key" size={26} /> : <BrandMark size={48} />}</div>
        <h2>{required ? 'Unlock aMail' : (keyslot ? 'Unlock credential' : 'Server access token')}</h2>
        <p>
          {required
            ? (passkeyPrimary
              ? `Use your passkey to open the inbox. ${keyslot ? 'A token, passphrase, or recovery code' : 'The access token'} is still available as a fallback.`
              : (keyslot
                ? 'This inbox is locked and its data is encrypted. Enter an access token, your passphrase, or a recovery code to unlock it.'
                : 'This aMail server is protected. Enter its access token to open your mail.'))
            : (keyslot
              ? 'Enter any credential that unlocks this inbox: an access token, your passphrase, or a recovery code.'
              : 'If this server has AMAIL_ACCESS_TOKEN set, paste the matching token here.')}
        </p>
        {passkeyPrimary && (
          <button type="button" className="primary-button passkey-button" onClick={usePasskey} disabled={passkeyBusy}>
            <Icon name="key" size={18} />
            {passkeyBusy ? 'Waiting for passkey…' : 'Continue with passkey'}
          </button>
        )}
        {canUsePasskeys && passkeyCount > 0 && !required && (
          <button type="button" className="secondary-button passkey-button" onClick={usePasskey} disabled={passkeyBusy}>
            <Icon name="key" size={18} />
            {passkeyBusy ? 'Waiting for passkey…' : 'Unlock with passkey'}
          </button>
        )}
        {authenticated && canUsePasskeys && onRegisterPasskey && (
          <button type="button" className="secondary-button passkey-button" onClick={addPasskey} disabled={passkeyBusy}>
            <Icon name="plus" size={18} />
            {passkeyBusy ? 'Waiting for authenticator…' : 'Add a passkey'}
          </button>
        )}
        {passkeyPrimary && !showToken && (
          <button type="button" className="text-button token-fallback" onClick={() => setShowToken(true)}>
            {keyslot ? 'Use another credential instead' : 'Use access token instead'}
          </button>
        )}
        {(!passkeyPrimary || showToken) && (
          <>
            <label className="form-field">
              <span>{credentialLabel}</span>
              <input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={keyslot ? 'Token, passphrase, or recovery code' : 'aMail access token'} autoFocus={!passkeyPrimary} autoComplete="off" />
            </label>
            <small className="access-note">
              {passkeyPrimary
                ? 'The token is a fallback. After unlock, a session cookie keeps this browser signed in.'
                : (keyslot
                  ? 'Unlocking decrypts your inbox for this session only. Passphrases and recovery codes are never stored in the browser.'
                  : 'Stored only in this browser session and sent as a Bearer token to this aMail server.')}
            </small>
          </>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="access-actions">
          {!required && <button type="button" className="text-button" onClick={onClose}>Cancel</button>}
          {(!passkeyPrimary || showToken) && (
            <button type="submit" className="primary-button" disabled={saving || !token.trim()}>
              {saving ? 'Unlocking…' : 'Unlock'}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
