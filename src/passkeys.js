import { api } from './api.js';

export function passkeysSupported() {
  return typeof window !== 'undefined'
    && Boolean(window.PublicKeyCredential)
    && typeof window.PublicKeyCredential === 'function';
}

function base64UrlToBuffer(value) {
  const base64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function bufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The WebAuthn PRF extension is how a passkey can hold an encryption secret:
 * in keyslot mode the server asks the authenticator to evaluate PRF over a
 * fixed input and the result wraps the tenant's data key. The browser library
 * passes `extensions` through untouched, so the eval input has to be decoded
 * into bytes before the ceremony and the result encoded afterwards.
 */
function withPrfInput(optionsJSON) {
  const first = optionsJSON?.extensions?.prf?.eval?.first;
  if (typeof first !== 'string') return optionsJSON;
  return {
    ...optionsJSON,
    extensions: { ...optionsJSON.extensions, prf: { ...optionsJSON.extensions.prf, eval: { first: base64UrlToBuffer(first) } } },
  };
}

function encodePrfResults(credential) {
  const results = credential?.clientExtensionResults?.prf;
  if (!results) return credential;
  const encoded = { enabled: Boolean(results.enabled) };
  if (results.results?.first) encoded.results = { first: bufferToBase64Url(results.results.first) };
  return { ...credential, clientExtensionResults: { ...credential.clientExtensionResults, prf: encoded } };
}

export async function authenticateWithPasskey() {
  const { startAuthentication } = await import('@simplewebauthn/browser');
  const payload = await api('/session/passkey/login/options', { method: 'POST', body: '{}' });
  const assertion = await startAuthentication({ optionsJSON: withPrfInput(payload.options) });
  await api('/session/passkey/login', {
    method: 'POST',
    body: JSON.stringify({ challengeId: payload.challengeId, response: encodePrfResults(assertion) }),
  });
}

export async function registerPasskey(name = 'Passkey') {
  const { startRegistration } = await import('@simplewebauthn/browser');
  const payload = await api('/session/passkey/register/options', { method: 'POST', body: '{}' });
  const attestation = await startRegistration({ optionsJSON: withPrfInput(payload.options) });
  const result = await api('/session/passkey/register', {
    method: 'POST',
    body: JSON.stringify({ challengeId: payload.challengeId, name, response: encodePrfResults(attestation) }),
  });
  if (result?.passkey?.canUnlock === false) {
    // Most authenticators only evaluate PRF on an assertion, not during
    // registration. This authenticated session runs one right away so the
    // server can link the new passkey to the data key.
    await authenticateWithPasskey();
    result.passkey = { ...result.passkey, canUnlock: true };
  }
  return result;
}
