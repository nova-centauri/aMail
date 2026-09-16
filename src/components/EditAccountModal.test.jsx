import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { EditAccountModal } from './EditAccountModal.jsx';

vi.mock('../api.js', () => ({ api: vi.fn() }));

const account = { id: 'account-one', name: 'Sam', email: 'sam@icloud.example', provider: 'icloud', connected: true };
const settings = {
  account: {
    ...account,
    displayName: 'Sam',
    syncEnabled: true,
    imap: { host: 'imap.mail.example', port: 993, secure: true },
    smtp: { host: 'smtp.mail.example', port: 587, secure: false },
  },
  credentials: { username: 'sam@icloud.example', imapUsername: 'sam', smtpUsername: 'sam@icloud.example', authType: 'password' },
};

async function showModal(overrides = {}) {
  const props = { account, onClose: vi.fn(), onUpdated: vi.fn(), onRemoved: vi.fn(), ...overrides };
  render(<EditAccountModal {...props} />);
  await screen.findByRole('textbox', { name: 'Display name' });
  return props;
}

const mutations = () => api.mock.calls.filter(([, options]) => ['PATCH', 'DELETE'].includes(options?.method));

describe('EditAccountModal', () => {
  beforeEach(() => {
    api.mockReset();
    api.mockImplementation(async (_path, options) => options?.method === 'PATCH' ? { account: settings.account } : options?.method === 'DELETE' ? null : settings);
  });

  it('loads safe settings and never pre-fills a password', async () => {
    await showModal();
    expect(api).toHaveBeenCalledWith('/accounts/account-one/settings', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByLabelText('Email address')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Email address')).toHaveValue(account.email);
    expect(screen.getByLabelText('Replacement app-specific password')).toHaveValue('');
    expect(screen.getByLabelText('Sync this account')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(mutations()).toEqual([]);
  });

  it('saves profile and sync changes without sending a blank password or connection settings', async () => {
    const props = await showModal();
    await userEvent.clear(screen.getByLabelText('Display name'));
    await userEvent.type(screen.getByLabelText('Display name'), 'Sam Rivera');
    await userEvent.type(screen.getByLabelText('Replacement app-specific password'), '   ');
    await userEvent.click(screen.getByLabelText('Sync this account'));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mutations()).toHaveLength(1);
    expect(JSON.parse(mutations()[0][1].body)).toEqual({ displayName: 'Sam Rivera', syncEnabled: false });
    expect(props.onUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: account.id, email: account.email }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('sends a replacement password alone so saved protocol usernames are retained', async () => {
    const props = await showModal();
    await userEvent.type(screen.getByLabelText('Replacement app-specific password'), 'new-app-password');
    await userEvent.click(screen.getByRole('button', { name: 'Test & save changes' }));
    expect(JSON.parse(mutations()[0][1].body)).toEqual({ credentials: { password: 'new-app-password' } });
    await waitFor(() => expect(screen.getByLabelText('Replacement app-specific password')).toHaveValue(''));
    expect(props.onUpdated).toHaveBeenCalledOnce();
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('sends only changed advanced fields and preserves explicit TLS settings', async () => {
    await showModal();
    await userEvent.click(screen.getByText('Advanced connection settings'));
    expect(screen.getByLabelText('IMAP username')).toHaveValue('sam');
    expect(screen.getByLabelText('SMTP username')).toHaveValue(account.email);
    await userEvent.clear(screen.getByLabelText('IMAP username'));
    await userEvent.type(screen.getByLabelText('IMAP username'), 'other-login');
    await userEvent.clear(screen.getByLabelText('SMTP port'));
    await userEvent.type(screen.getByLabelText('SMTP port'), '2525');
    await userEvent.click(screen.getByRole('button', { name: 'Test & save changes' }));
    expect(JSON.parse(mutations()[0][1].body)).toEqual({ credentials: { imapUsername: 'other-login' }, smtp: { host: 'smtp.mail.example', port: 2525, secure: false } });
  });

  it('keeps the dialog open on failed verification without displaying raw server errors', async () => {
    const props = await showModal();
    api.mockRejectedValueOnce(Object.assign(new Error('raw server error includes secret material'), { status: 400 }));
    await userEvent.type(screen.getByLabelText('Replacement app-specific password'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Test & save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save account settings');
    expect(screen.queryByText(/secret material/)).not.toBeInTheDocument();
    expect(props.onUpdated).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Test & save changes' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Replacement app-specific password')).toHaveValue('');
  });

  it('blocks duplicate saves, field changes, and dismissal while verification is running', async () => {
    const props = await showModal();
    let finish;
    api.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await userEvent.type(screen.getByLabelText('Replacement app-specific password'), 'new-password');
    await userEvent.click(screen.getByRole('button', { name: 'Test & save changes' }));
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Verifying IMAP and SMTP');
    expect(screen.getByLabelText('Display name')).toBeDisabled();
    expect(screen.getByLabelText('Replacement app-specific password')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close account settings' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove account…' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    fireEvent.submit(screen.getByRole('button', { name: 'Saving…' }).closest('form'));
    expect(mutations()).toHaveLength(1);
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => finish({ account: settings.account }));
    expect(props.onUpdated).toHaveBeenCalledOnce();
  });

  it('requires a separate removal confirmation naming the account and local data loss', async () => {
    const props = await showModal();
    await userEvent.click(screen.getByRole('button', { name: 'Remove account…' }));
    expect(screen.getByRole('heading', { name: `Remove ${account.email}?` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep account' })).toHaveFocus();
    expect(screen.getByText(/cached messages, local drafts, and analyzed status/)).toBeInTheDocument();
    expect(screen.getByText(/Email stored with your mail provider is not deleted/)).toBeInTheDocument();
    expect(mutations()).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Keep account' }));
    expect(mutations()).toEqual([]);
    expect(props.onRemoved).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Remove account…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove account and local data' }));
    expect(mutations()).toEqual([['/accounts/account-one', { method: 'DELETE' }]]);
    expect(props.onRemoved).toHaveBeenCalledWith(account.id);
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onUpdated).not.toHaveBeenCalled();
  });

  it('keeps failed removal visible and only reports removal after the server succeeds', async () => {
    const props = await showModal();
    api.mockRejectedValueOnce(new Error('unexpected backend failure'));
    await userEvent.click(screen.getByRole('button', { name: 'Remove account…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove account and local data' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not remove this account');
    expect(screen.getByRole('button', { name: 'Keep account' })).toBeEnabled();
    expect(props.onRemoved).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('blocks cancellation and duplicate removal while deletion is running', async () => {
    const props = await showModal();
    let finish;
    api.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove account…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove account and local data' }));
    expect(screen.getByRole('button', { name: 'Keep account' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Removing…' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(props.onClose).not.toHaveBeenCalled();
    expect(mutations()).toHaveLength(1);
    await act(async () => finish(null));
    expect(props.onRemoved).toHaveBeenCalledOnce();
  });

  it('can update credentials while removal is blocked by an open draft', async () => {
    await showModal({ removalBlockedReason: 'Close the open draft before removing an account.' });
    expect(screen.getByRole('button', { name: 'Remove account…' })).toBeDisabled();
    expect(screen.getByText('Close the open draft before removing an account.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Replacement app-specific password'), 'replacement');
    expect(screen.getByRole('button', { name: 'Test & save changes' })).toBeEnabled();
    expect(mutations()).toEqual([]);
  });

  it('offers retry after a load failure without enabling edits or removal', async () => {
    api.mockRejectedValueOnce(new Error('server unavailable'));
    const props = { account, onClose: vi.fn(), onUpdated: vi.fn(), onRemoved: vi.fn() };
    render(<EditAccountModal {...props} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load account settings');
    expect(screen.queryByLabelText('Replacement app-specific password')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove account…' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry loading settings' }));
    expect(await screen.findByLabelText('Replacement app-specific password')).toHaveValue('');
    expect(mutations()).toEqual([]);
  });

  it('traps keyboard focus inside the dialog and allows Escape to clear and close', async () => {
    const props = await showModal();
    await userEvent.type(screen.getByLabelText('Replacement app-specific password'), 'replacement');
    const dialog = screen.getByRole('dialog');
    within(dialog).getByRole('button', { name: 'Test & save changes' }).focus();
    await userEvent.tab();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(within(dialog).getByRole('button', { name: 'Test & save changes' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Replacement app-specific password')).toHaveValue('');
  });
});
