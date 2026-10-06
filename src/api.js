import { getAccessToken } from './storage.js';

export const API_BASE = (import.meta.env.VITE_API_BASE || '/api').replace(/\/$/, '');

export async function api(path, options = {}) {
  const hasBody = options.body !== undefined;
  const accessToken = getAccessToken();
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const contentType = response.headers.get('content-type') || '';
    let detail = null;
    try {
      detail = contentType.includes('application/json') ? await response.json() : await response.text();
    } catch {
      detail = null;
    }
    const errorBody = detail && typeof detail === 'object' ? (detail.error || detail) : null;
    const message = typeof errorBody?.message === 'string'
      ? errorBody.message
      : typeof detail === 'string' && detail.trim()
        ? detail.trim()
        : `Request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.code = errorBody?.code || detail?.code || null;
    error.details = errorBody?.details || detail?.details || null;
    throw error;
  }
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') || '';
  return contentType.includes('application/json') ? response.json() : response.text();
}

export function parseSseBlock(block) {
  const eventLine = String(block || '').split('\n').find((line) => line.startsWith('event: '));
  const dataLines = String(block || '').split('\n').filter((line) => line.startsWith('data: '));
  if (!eventLine || !dataLines.length) return null;
  const raw = dataLines.map((line) => line.slice(6)).join('\n');
  try {
    return { event: eventLine.slice(7), data: JSON.parse(raw) };
  } catch {
    return { event: eventLine.slice(7), data: raw };
  }
}

export async function streamSse(path, { signal, onEvent } = {}) {
  const accessToken = getAccessToken();
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'same-origin',
    headers: {
      Accept: 'text/event-stream',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    signal,
  });
  if (!response.ok) {
    const error = new Error(`Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      const parsed = parseSseBlock(part);
      if (parsed) onEvent?.(parsed);
    }
  }
  const tail = parseSseBlock(buffer);
  if (tail) onEvent?.(tail);
  return response;
}
