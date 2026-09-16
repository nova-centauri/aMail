import { useState } from 'react';
import { folders, UNIFIED_ACCOUNT } from '../mail/constants.js';
import { accountContextMenu, flagContextMenu } from '../mail/context-menu.js';
import { demoAccounts } from '../mail/demo.js';
import { ContextMenu, useContextMenu } from './ContextMenu.jsx';
import { Icon } from './Icon.jsx';
import { Avatar, IconButton } from './ui.jsx';

export function Sidebar({ compact, mobileOpen, onCloseMobile, activeFolder, setActiveFolder, counts, onCompose, accounts, activeAccount, setActiveAccount, onSelectUnified, onOpenSettings, isDemo, onAddAccount, onEditAccount, activePersonFlag, onSelectPersonFlag, personFlags = [], onManageFlags, agentQueueActive = false, onSelectAgentQueue, onSyncAccount }) {
  const [showMore, setShowMore] = useState(false);
  const displayAccounts = accounts.length ? accounts : isDemo ? demoAccounts : [];
  const items = showMore
    ? [...folders, { id: 'all', label: 'All mail', icon: 'mail' }, { id: 'spam', label: 'Spam', icon: 'spam' }, { id: 'trash', label: 'Trash', icon: 'trash' }]
    : folders;
  const connectedCount = accounts.length;
  const { menu, openMenu, closeMenu } = useContextMenu();
  const openAccountMenu = (event, account) => openMenu(event, accountContextMenu(account, {
    active: account ? activeAccount?.id === account.id : !activeAccount,
    handlers: {
      selectAccount: (item) => { setActiveAccount(item); onCloseMobile(); },
      selectUnified: () => { onSelectUnified(); onCloseMobile(); },
      sync: onSyncAccount && !isDemo ? onSyncAccount : undefined,
      editAccount: onEditAccount && !isDemo ? (item) => { onEditAccount(item); onCloseMobile(); } : undefined,
      openSettings: () => { onOpenSettings(); onCloseMobile(); },
    },
  }));
  const openFlagMenu = (event, flag) => openMenu(event, flagContextMenu(flag, {
    active: activePersonFlag === flag.id,
    handlers: {
      select: (flagId) => { onSelectPersonFlag?.(flagId); onCloseMobile(); },
      manage: onManageFlags ? () => { onManageFlags(); onCloseMobile(); } : undefined,
    },
  }));
  return (
    <>
      {mobileOpen && <button type="button" className="sidebar-scrim" aria-label="Close navigation" onClick={onCloseMobile} />}
      <aside className={`sidebar ${compact ? 'is-compact' : ''} ${mobileOpen ? 'is-mobile-open' : ''}`}>
        <div className="sidebar-top">
          <button type="button" className="compose-button" onClick={onCompose} title="Compose" aria-label="Compose">
            <Icon name="compose" size={20} />
            <span>Compose</span>
          </button>
        </div>
        <div className="sidebar-scroll">
          <nav className="folder-nav" aria-label="Mail folders">
            {items.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => { setActiveFolder(item.id); onSelectPersonFlag?.(null); onCloseMobile(); }}
                className={`nav-item ${activeFolder === item.id && !activePersonFlag ? 'is-selected' : ''}`}
                title={compact ? item.label : undefined}
              >
                <Icon name={item.icon} size={20} />
                <span className="nav-label">{item.label}</span>
                {counts[item.id] > 0 && <span className="nav-count">{counts[item.id]}</span>}
              </button>
            ))}
            <button type="button" className="nav-item more-nav" onClick={() => setShowMore((value) => !value)} title={compact ? 'More' : undefined} aria-expanded={showMore}>
              <Icon name={showMore ? 'chevronDown' : 'chevronRight'} size={19} />
              <span className="nav-label">{showMore ? 'Less' : 'More'}</span>
            </button>
          </nav>
          <div className="agent-section">
            <div className="side-section-heading"><span>Agent</span></div>
            <nav className="folder-nav" aria-label="Agent queue">
              <button
                type="button"
                onClick={() => { onSelectAgentQueue?.(); onCloseMobile(); }}
                className={`nav-item agent-queue-nav ${agentQueueActive ? 'is-selected' : ''}`}
                title={compact ? 'Not yet analyzed' : 'Inbox mail no agent has analyzed yet'}
              >
                <Icon name="sparkles" size={20} />
                <span className="nav-label">Not yet analyzed</span>
                {counts.unanalyzed > 0 && <span className="nav-count">{counts.unanalyzed}</span>}
              </button>
            </nav>
          </div>
          <div className="flags-section">
            <div className="side-section-heading">
              <span>Flagged people</span>
              <IconButton label="Manage flagged people" onClick={() => { onManageFlags?.(); onCloseMobile(); }}><Icon name="tune" size={17} /></IconButton>
            </div>
            <nav className="folder-nav flag-nav" aria-label="Flagged people">
              {personFlags.map((flag) => (
                <button
                  type="button"
                  key={flag.id}
                  onClick={() => { onSelectPersonFlag?.(flag.id); onCloseMobile(); }}
                  onContextMenu={(event) => openFlagMenu(event, flag)}
                  className={`nav-item label-nav ${activePersonFlag === flag.id ? 'is-selected' : ''}`}
                  title={compact ? flag.label : flag.description}
                >
                  <span className="label-dot" style={{ background: flag.color }} />
                  <span className="nav-label">{flag.shortLabel || flag.label}</span>
                </button>
              ))}
              {!personFlags.length && !compact && (
                <button type="button" className="nav-item label-nav flag-empty" onClick={() => { onManageFlags?.(); onCloseMobile(); }}>
                  <Icon name="plus" size={18} />
                  <span className="nav-label">Flag a person</span>
                </button>
              )}
            </nav>
          </div>
          <div className="accounts-section">
            <div className="side-section-heading">
              <span>Accounts</span>
              <span className="account-heading-actions">
              <IconButton label="Manage accounts" onClick={() => { onOpenSettings(); onCloseMobile(); }}><Icon name="settings" size={17} /></IconButton>
              <IconButton label="Add account" onClick={() => { onAddAccount?.(); onCloseMobile(); }}><Icon name="plus" size={18} /></IconButton>
              </span>
            </div>
            {accounts.length > 0 && (
              <button type="button" className={`account-row unified-account-row ${!activeAccount ? 'is-active' : ''}`} onClick={() => { onSelectUnified(); onCloseMobile(); }} onContextMenu={(event) => openAccountMenu(event, null)} title={compact ? 'All inboxes' : undefined}>
                <Avatar person={UNIFIED_ACCOUNT} size="sm" />
                <span className="account-row-text"><strong>All inboxes</strong><small>Unified inbox</small></span>
                {!activeAccount && <Icon name="check" size={16} />}
              </button>
            )}
            {displayAccounts.map((account) => (
              <button type="button" key={account.id} className={`account-row ${activeAccount?.id === account.id ? 'is-active' : ''}`} onClick={() => { setActiveAccount(account); onCloseMobile(); }} onContextMenu={(event) => openAccountMenu(event, account)} title={compact ? account.email : undefined}>
                <Avatar person={account} size="sm" />
                <span className="account-row-text"><strong>{account.name}</strong><small>{account.email}</small></span>
                <span className={`connection-dot ${account.connected ? 'is-connected' : ''}`} title={account.connected ? 'Connected' : 'Needs attention'} />
              </button>
            ))}
            {!accounts.length && !isDemo && (
              <button type="button" className="account-row" onClick={() => { onAddAccount?.(); onCloseMobile(); }}>
                <span className="account-row-text"><strong>Connect an account</strong><small>Gmail, iCloud, or IMAP</small></span>
              </button>
            )}
          </div>
        </div>
        <div className="sidebar-foot">
        <button type="button" className="storage-card" onClick={onOpenSettings} title={compact ? 'Settings' : undefined}>
          <span className="storage-privacy-mark" aria-hidden="true"><Icon name="shield" size={16} /></span>
          <span className="storage-copy">
            <strong>{connectedCount ? `${connectedCount} account${connectedCount === 1 ? '' : 's'} connected` : isDemo ? 'Preview mailbox' : 'No accounts yet'}</strong>
            <small>Trackers blocked · private images optional</small>
          </span>
        </button>
        </div>
      </aside>
      <ContextMenu menu={menu} onClose={closeMenu} />
    </>
  );
}
