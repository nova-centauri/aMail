import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { ComposeModal } from './ComposeModal.jsx';

vi.mock('../api.js', () => ({ api: vi.fn() }));

const account = { id: 'acc-1', name: 'Owner', email: 'owner@example.test' };
const contacts = [
  { name: 'Maya Chen', email: 'maya@studio.com' },
  { name: 'Avery Thompson', email: 'avery@ops.example' },
];

describe('ComposeModal', () => {
  it('attaches a file and writes formatted HTML in the message body', async () => {
    const user = userEvent.setup();
    const onSent = vi.fn();
    render(
      <ComposeModal
        account={account}
        accounts={[account]}
        contacts={contacts}
        isDemo
        onClose={vi.fn()}
        onSent={onSent}
        onDraftSaved={vi.fn()}
        onDraftRemoved={vi.fn()}
      />,
    );

    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    await user.upload(screen.getByLabelText('Choose files to attach'), file);
    expect(await screen.findByText('notes.txt')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /html/i }));
    const source = screen.getByRole('textbox', { name: 'Message HTML' });
    await user.click(source);
    await user.clear(source);
    await user.paste('<p>See <strong>docs</strong> and <a href="https://mail.example.test">mail.example.test</a></p>');
    expect(source.value).toMatch(/docs/);

    await user.type(screen.getByLabelText('Recipients'), 'friend@example.test{enter}');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSent).toHaveBeenCalled();
    const payload = onSent.mock.calls[0][0];
    expect(payload.to[0].email).toBe('friend@example.test');
    expect(payload.htmlBody).toMatch(/<strong>docs<\/strong>/);
    expect(payload.htmlBody).toContain('https://mail.example.test');
    expect(payload.textBody).toMatch(/docs/);
  });

  it('turns known people into recipient chips', async () => {
    const user = userEvent.setup();
    render(
      <ComposeModal
        account={account}
        accounts={[account]}
        contacts={contacts}
        isDemo
        onClose={vi.fn()}
        onSent={vi.fn()}
        onDraftSaved={vi.fn()}
        onDraftRemoved={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText('Recipients'), 'may');
    expect(await screen.findByRole('option', { name: /Maya Chen/i })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /Maya Chen/i }));
    expect(screen.getByTitle('maya@studio.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Maya Chen <maya@studio.com>' })).toBeInTheDocument();
  });

  it('opens a saved draft in the full writer pane', () => {
    render(
      <ComposeModal
        account={account}
        accounts={[account]}
        contacts={contacts}
        isDemo
        initialReply={{
          mode: 'draft',
          draftId: 'd1',
          to: 'maya@studio.com',
          subject: 'Design follow-up',
          htmlBody: '<p>Thanks for the notes.</p>',
          expanded: true,
        }}
        onClose={vi.fn()}
        onSent={vi.fn()}
        onDraftSaved={vi.fn()}
        onDraftRemoved={vi.fn()}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'New message' })).toHaveClass('is-expanded');
    expect(screen.getByDisplayValue('Design follow-up')).toBeInTheDocument();
  });

  it('keeps the composer open and the typed text when the mailbox around it reloads', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const props = {
      account,
      accounts: [account],
      contacts,
      isDemo: true,
      onClose,
      onSent: vi.fn(),
      onDraftSaved: vi.fn(),
      onDraftRemoved: vi.fn(),
    };
    const { rerender } = render(<ComposeModal {...props} />);
    const body = screen.getByRole('textbox', { name: 'Message body' });
    await user.click(body);
    await user.type(body, 'Still writing');
    rerender(<ComposeModal {...props} contacts={[...contacts, { name: 'New', email: 'new@example.test' }]} accounts={[{ ...account }]} />);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'New message' })).toBeInTheDocument();
    expect(body).toHaveTextContent('Still writing');
    expect(api).not.toHaveBeenCalled();
  });

  it('does not close while a recipient suggestion is dismissed, and Enter in the subject does not send', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSent = vi.fn();
    render(
      <ComposeModal
        account={account}
        accounts={[account]}
        contacts={contacts}
        isDemo
        onClose={onClose}
        onSent={onSent}
        onDraftSaved={vi.fn()}
        onDraftRemoved={vi.fn()}
      />,
    );
    await user.type(screen.getByLabelText('Recipients'), 'may');
    expect(await screen.findByRole('option', { name: /Maya Chen/i })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'New message' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Subject'), 'Notes{Enter}');
    expect(onSent).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Notes')).toBeInTheDocument();
  });

  it('fills an empty draft from a later payload and does not wipe text already typed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const base = {
      account,
      accounts: [account],
      contacts,
      isDemo: true,
      onClose,
      onSent: vi.fn(),
      onDraftSaved: vi.fn(),
      onDraftRemoved: vi.fn(),
    };
    const { rerender } = render(<ComposeModal {...base} initialReply={{ mode: 'draft', draftId: 'd1', subject: 'Hello', htmlBody: '' }} />);
    rerender(<ComposeModal {...base} initialReply={{ mode: 'draft', draftId: 'd1', subject: 'Hello', htmlBody: '<p>Filled from the cache.</p>' }} />);
    expect(await screen.findByText('Filled from the cache.')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    const body = screen.getByRole('textbox', { name: 'Message body' });
    await user.click(body);
    await user.type(body, ' mine');
    rerender(<ComposeModal {...base} initialReply={{ mode: 'draft', draftId: 'd2', subject: 'Replaced', htmlBody: '<p>Server copy</p>' }} />);
    expect(onClose).not.toHaveBeenCalled();
    expect(body).toHaveTextContent('mine');
    expect(screen.queryByText('Server copy')).not.toBeInTheDocument();
  });

  it('saves and closes a draft whose attachment has no file bytes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onDraftSaved = vi.fn();
    const onDraftRemoved = vi.fn();
    api.mockResolvedValue({
      draft: {
        id: 'draft-quote',
        subject: 'Quote follow-up',
        attachments: [{ filename: 'quote.pdf', contentType: 'application/pdf', size: 4096 }],
      },
    });
    render(
      <ComposeModal
        account={account}
        accounts={[account]}
        contacts={contacts}
        initialReply={{
          mode: 'draft',
          draftId: 'draft-quote',
          accountId: account.id,
          to: 'finance@lab.example',
          subject: 'Quote follow-up',
          htmlBody: '<p>See the quote.</p>',
          attachments: [{ filename: 'quote.pdf', contentType: 'application/pdf', size: 4096 }],
        }}
        onClose={onClose}
        onSent={vi.fn()}
        onDraftSaved={onDraftSaved}
        onDraftRemoved={onDraftRemoved}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Save and close' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api).toHaveBeenCalledWith('/drafts/draft-quote', expect.objectContaining({ method: 'PATCH' }));
    const payload = JSON.parse(api.mock.calls.at(-1)[1].body);
    expect(payload.attachments[0].filename).toBe('quote.pdf');
    expect(payload.attachments[0].content).toBeUndefined();
    expect(onDraftSaved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(onDraftRemoved).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('saves without closing or sending and updates the same draft on the next save', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSent = vi.fn();
    const onDraftSaved = vi.fn();
    api.mockImplementation(async (_path, options) => ({ draft: { id: 'saved-1', ...JSON.parse(options.body) } }));
    render(<ComposeModal account={account} accounts={[account]} contacts={contacts} onClose={onClose} onSent={onSent} onDraftSaved={onDraftSaved} onDraftRemoved={vi.fn()} />);

    const body = screen.getByRole('textbox', { name: 'Message body' });
    await user.type(body, 'Work in progress');
    // Saving must include a typed address even before Enter turns it into a chip.
    await user.type(screen.getByLabelText('Recipients'), 'reviewer@example.test');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(onDraftSaved).toHaveBeenCalledTimes(1));
    expect(api).toHaveBeenLastCalledWith('/drafts', expect.objectContaining({ method: 'POST' }));
    const payload = JSON.parse(api.mock.calls.at(-1)[1].body);
    expect(payload.textBody).toContain('Work in progress');
    expect(payload.to).toEqual([{ name: '', email: 'reviewer@example.test' }]);
    expect(onClose).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
    expect(body).toHaveTextContent('Work in progress');

    await user.type(screen.getByLabelText('Subject'), 'Updated subject');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(onDraftSaved).toHaveBeenCalledTimes(2));
    expect(api).toHaveBeenLastCalledWith('/drafts/saved-1', expect.objectContaining({ method: 'PATCH' }));
    expect(JSON.parse(api.mock.calls.at(-1)[1].body).subject).toBe('Updated subject');
    expect(onClose).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
  });

  it('keeps the writer contents and allows retry when saving fails', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onDraftSaved = vi.fn();
    api.mockRejectedValueOnce(new Error('Connection unavailable'));
    render(<ComposeModal account={account} accounts={[account]} onClose={onClose} onSent={vi.fn()} onDraftSaved={onDraftSaved} onDraftRemoved={vi.fn()} />);
    await user.type(screen.getByLabelText('Subject'), 'Do not lose this');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Draft could not be saved. Connection unavailable');
    expect(screen.getByLabelText('Subject')).toHaveValue('Do not lose this');
    expect(onClose).not.toHaveBeenCalled();
    expect(onDraftSaved).not.toHaveBeenCalled();
    api.mockResolvedValueOnce({ draft: { id: 'retry-1', subject: 'Do not lose this' } });
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(onDraftSaved).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('can save an empty draft and prevents switching accounts while the first save is pending', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onDraftSaved = vi.fn();
    let finishSave;
    api.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    const otherAccount = { id: 'acc-2', name: 'Other', email: 'other@example.test' };
    render(<ComposeModal account={account} accounts={[account, otherAccount]} onClose={onClose} onSent={vi.fn()} onDraftSaved={onDraftSaved} onDraftRemoved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByLabelText('Send from account')).toBeDisabled();
    expect(JSON.parse(api.mock.calls.at(-1)[1].body)).toMatchObject({ accountId: account.id, to: [], subject: '', textBody: '' });
    await act(async () => finishSave({ draft: { id: 'blank-1', accountId: account.id } }));
    expect(onDraftSaved).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Send from account')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();
  });
});
