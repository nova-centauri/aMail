import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ThreadView } from './ThreadView.jsx';

const thread = {
  id: 'design-sync',
  threadId: 'design-sync',
  subject: 'Design sync — final notes',
  folder: 'inbox',
  analyzed: true,
  messages: [
    {
      id: 'm1',
      from: { name: 'Maya Chen', email: 'maya@studio.com' },
      to: ['Sam Rivera'],
      timestamp: '2026-09-01T15:00:00.000Z',
      body: 'The desktop flow is ready.',
    },
    {
      id: 'm2',
      from: { name: 'Sam Rivera', email: 'sam@rivera.example' },
      to: ['Maya Chen'],
      timestamp: '2026-09-01T16:00:00.000Z',
      body: 'Looks excellent.\n\nOn Tue, Sep 1, 2026 at 9:00 AM Maya Chen wrote:\n> The desktop flow is ready.',
      attachments: [{ name: 'figma-invoice-july.pdf', size: '124 KB', preview: true }],
    },
  ],
};

describe('ThreadView', () => {
  it('shows each message as its own card without the quoted tail', () => {
    render(<ThreadView thread={thread} activeFolder="inbox" onBack={vi.fn()} onAction={vi.fn()} onLoadRemote={vi.fn()} onReply={vi.fn()} onReplyAll={vi.fn()} onForward={vi.fn()} onToggleStar={vi.fn()} allowPrivateImages={false} />);
    expect(screen.getByRole('heading', { name: 'Design sync — final notes' })).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.getByText('Looks excellent.')).toBeInTheDocument();
    expect(screen.queryByText(/The desktop flow is ready\./)).toBeInTheDocument();
    expect(screen.queryByText(/Maya Chen wrote/)).not.toBeInTheDocument();
  });

  it('keeps one download in flight for an attachment', async () => {
    const user = userEvent.setup();
    render(<ThreadView thread={thread} activeFolder="inbox" onBack={vi.fn()} onAction={vi.fn()} onLoadRemote={vi.fn()} onReply={vi.fn()} onReplyAll={vi.fn()} onForward={vi.fn()} onToggleStar={vi.fn()} onNotice={vi.fn()} allowPrivateImages={false} />);
    const button = screen.getByRole('button', { name: 'Download figma-invoice-july.pdf' });
    await user.click(button);
    expect(screen.getByRole('button', { name: 'Downloading figma-invoice-july.pdf' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Downloading figma-invoice-july.pdf' }));
    expect(screen.getAllByRole('button', { name: 'Downloading figma-invoice-july.pdf' })).toHaveLength(1);
  });
});
