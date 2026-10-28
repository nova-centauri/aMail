import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.js', () => ({ api: vi.fn() }));

import { api } from '../api.js';
import { agentConfigSnippets, OnboardingWizard } from './OnboardingWizard.jsx';

describe('agentConfigSnippets', () => {
  it('points every client at the same MCP endpoint without leaking a token', () => {
    const snippets = agentConfigSnippets('https://mail.example.com/mcp');
    expect(JSON.parse(snippets.cursor.code).mcpServers.amail.url).toBe('https://mail.example.com/mcp');
    expect(JSON.parse(snippets.claude.code).mcpServers.amail.headers.Authorization).toBe('Bearer <AMAIL_ACCESS_TOKEN>');
    expect(snippets.claudeConnector.code).toContain('Authentication: Sign in now');
    expect(snippets.claudeConnector.code).toContain('OAuth client: Register automatically');
    expect(snippets.curl.code).toContain('https://mail.example.com/api/messages?folder=inbox&q=is%3Aunanalyzed');
    expect(Object.values(snippets).some((snippet) => /[0-9a-f]{32}/i.test(snippet.code))).toBe(false);
  });
});

describe('OnboardingWizard', () => {
  beforeEach(() => {
    api.mockReset();
  });

  it('walks welcome → inboxes → agent → done and reports skips separately from finishing', async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    const onSkip = vi.fn();
    render(<OnboardingWizard accounts={[]} serverInfo={{ authProtected: true }} onAccountAdded={vi.fn()} onFinish={onFinish} onSkip={onSkip} />);
    expect(screen.getByRole('heading', { name: /welcome to amail/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /get started/i }));

    expect(screen.getByRole('heading', { name: /connect your inboxes/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /gmail/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^continue/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: /skip for now/i }));

    expect(screen.getByRole('heading', { name: /connect an agent/i })).toBeInTheDocument();
    expect(screen.getByText(`${window.location.origin}/mcp`)).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /claude code/i }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('"type": "http"');
    await user.click(screen.getByRole('button', { name: /copy config/i }));
    expect(await window.navigator.clipboard.readText()).toContain('/mcp');
    await user.click(screen.getByRole('button', { name: /^continue/i }));

    expect(screen.getByRole('heading', { name: /setup saved/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /open my inbox/i }));
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('connects an inbox from inside the wizard and lists it before continuing', async () => {
    const user = userEvent.setup();
    const onAccountAdded = vi.fn();
    api.mockResolvedValue({ account: { id: 'acc-1', email: 'you@gmail.com', displayName: 'You', connected: true } });
    render(<OnboardingWizard accounts={[]} serverInfo={{ authProtected: true }} onAccountAdded={onAccountAdded} onFinish={vi.fn()} onSkip={vi.fn()} initialStep={1} />);
    await user.click(screen.getByRole('button', { name: /gmail/i }));
    await user.type(screen.getByLabelText(/email address/i), 'you@gmail.com');
    await user.type(screen.getByLabelText(/app password/i), 'abcd efgh ijkl mnop');
    await user.click(screen.getByRole('button', { name: /test & connect/i }));

    expect(api).toHaveBeenCalledWith('/accounts', expect.objectContaining({ method: 'POST' }));
    const payload = JSON.parse(api.mock.calls[0][1].body);
    expect(payload.credentials.password).toBe('abcdefghijklmnop');
    expect(payload.imap.host).toBe('imap.gmail.com');
    expect(onAccountAdded).toHaveBeenCalledWith(expect.objectContaining({ id: 'acc-1', email: 'you@gmail.com' }));
    const list = await screen.findByRole('list', { name: /connected accounts/i });
    expect(within(list).getByText('you@gmail.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^continue/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /add another inbox/i })).toBeInTheDocument();
  });

  it('warns when the server has no access token configured', () => {
    render(<OnboardingWizard accounts={[]} serverInfo={{ authProtected: false }} onAccountAdded={vi.fn()} onFinish={vi.fn()} onSkip={vi.fn()} initialStep={2} />);
    expect(screen.getByText(/no access token configured/i)).toBeInTheDocument();
  });
});
