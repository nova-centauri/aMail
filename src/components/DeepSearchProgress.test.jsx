import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DeepSearchProgress } from './DeepSearchProgress.jsx';

describe('DeepSearchProgress', () => {
  it('shows real folder progress and can cancel', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <DeepSearchProgress
        status="running"
        progress={{ done: 2, total: 5, ratio: 0.4, label: 'Searching Sent on work@example.test', found: 7 }}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole('progressbar', { name: 'Deep search progress' })).toHaveAttribute('aria-valuenow', '2');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '5');
    expect(screen.getByText(/Searching Sent on work@example.test/)).toBeInTheDocument();
    expect(screen.getByText(/7 found/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
