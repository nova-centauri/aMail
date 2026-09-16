import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel.jsx';

const account = {
  id: 'me',
  name: 'Sam Rivera',
  email: 'sam@rivera.example',
  signature: 'Best,\nSam',
  connected: true,
};

describe('SettingsPanel signature editor', () => {
  it('opens editing for the exact account without changing the selected inbox', async () => {
    const onEditAccount = vi.fn();
    const setActiveAccount = vi.fn();
    render(<SettingsPanel open onClose={vi.fn()} accounts={[account]} activeAccount={null} setActiveAccount={setActiveAccount} privacy={{ privateImages: true }} setPrivacy={vi.fn()} density="Default" setDensity={vi.fn()} onAddAccount={vi.fn()} onEditAccount={onEditAccount} onUnlock={vi.fn()} onSaveSignature={vi.fn()} showUnified />);
    await userEvent.click(screen.getByRole('button', { name: `Edit account ${account.email}` }));
    expect(onEditAccount).toHaveBeenCalledWith(account);
    expect(setActiveAccount).not.toHaveBeenCalled();
  });

  it('does not offer account mutations for preview identities', () => {
    render(<SettingsPanel open onClose={vi.fn()} accounts={[account]} activeAccount={account} setActiveAccount={vi.fn()} privacy={{ privateImages: true }} setPrivacy={vi.fn()} density="Default" setDensity={vi.fn()} onAddAccount={vi.fn()} onEditAccount={vi.fn()} onUnlock={vi.fn()} onSaveSignature={vi.fn()} isDemo />);
    expect(screen.queryByRole('button', { name: `Edit account ${account.email}` })).not.toBeInTheDocument();
  });

  it('opens the HTML and visual editors for the selected account', async () => {
    render(
      <SettingsPanel
        open
        onClose={vi.fn()}
        accounts={[account]}
        activeAccount={account}
        setActiveAccount={vi.fn()}
        privacy={{ privateImages: true }}
        setPrivacy={vi.fn()}
        density="Default"
        setDensity={vi.fn()}
        onAddAccount={vi.fn()}
        onUnlock={vi.fn()}
        onSaveSignature={vi.fn()}
        showUnified={false}
      />,
    );
    expect(screen.getByRole('heading', { name: /signature/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /visual/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: /upload html/i })).toBeEnabled();
    await userEvent.click(screen.getByRole('tab', { name: /html/i }));
    expect(screen.getByRole('textbox', { name: 'Signature HTML' })).toHaveValue('Best,\nSam');
  });
});
