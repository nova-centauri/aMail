import { render, screen, waitFor } from '@testing-library/react';
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
    const payload = JSON.parse(api.mock.calls[0][1].body);
    expect(payload.attachments[0].filename).toBe('quote.pdf');
    expect(payload.attachments[0].content).toBeUndefined();
    expect(onDraftSaved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(onDraftRemoved).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
