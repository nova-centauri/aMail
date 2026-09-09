import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AccessPanel } from './AccessPanel.jsx';

describe('AccessPanel', () => {
  it('offers passkey unlock when passkeys are already registered', async () => {
    const onPasskeyLogin = vi.fn().mockResolvedValue(undefined);
    render(
      <AccessPanel
        open
        required
        currentToken=""
        onSave={vi.fn()}
        onClose={vi.fn()}
        passkeyCount={2}
        canUsePasskeys
        onPasskeyLogin={onPasskeyLogin}
      />,
    );
    expect(screen.getByRole('button', { name: /continue with passkey/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/access token/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /continue with passkey/i }));
    expect(onPasskeyLogin).toHaveBeenCalledOnce();
  });

  it('falls back to the access token form', async () => {
    render(
      <AccessPanel
        open
        required
        currentToken=""
        onSave={vi.fn()}
        onClose={vi.fn()}
        passkeyCount={1}
        canUsePasskeys
        onPasskeyLogin={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /use access token instead/i }));
    expect(screen.getByLabelText(/access token/i)).toBeInTheDocument();
  });

  it('accepts any keyslot credential when the server runs in keyslot mode', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <AccessPanel
        open
        required
        currentToken=""
        onSave={onSave}
        onClose={vi.fn()}
        passkeyCount={0}
        keyMode="keyslot"
      />,
    );
    expect(screen.getByText(/data is encrypted/i)).toBeInTheDocument();
    const field = screen.getByLabelText(/access token, passphrase, or recovery code/i);
    await userEvent.type(field, 'ABCDE-FGHJK-MNPQR-STVWX-YZ234-56789');
    await userEvent.click(screen.getByRole('button', { name: /^unlock$/i }));
    expect(onSave).toHaveBeenCalledWith('ABCDE-FGHJK-MNPQR-STVWX-YZ234-56789');
  });
});
