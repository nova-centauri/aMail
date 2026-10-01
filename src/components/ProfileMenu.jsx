import { UNIFIED_ACCOUNT } from '../mail/constants.js';
import { usePresence } from '../mail/presence.js';
import { Icon } from './Icon.jsx';
import { Avatar } from './ui.jsx';

export function ProfileMenu({ open, onClose, account, accounts, setActiveAccount, onSelectUnified, onOpenSettings, onLogout, showUnified }) {
  const presence = usePresence(open);
  if (!presence.mounted) return null;
  return (
    <>
      <button type="button" className={`profile-scrim ${presence.closing ? 'is-closing' : ''}`} onClick={onClose} aria-label="Close account menu" />
      <section className={`profile-menu ${presence.closing ? 'is-closing' : ''}`} aria-label="Account menu">
        <button type="button" className="profile-close" onClick={onClose}><Icon name="close" size={18} /></button>
        <Avatar person={account} size="hero" />
        <strong className="profile-name">{account?.name}</strong>
        <span className="profile-email">{account?.email}</span>
        <button type="button" className="manage-account-button" onClick={() => { onOpenSettings(); onClose(); }}>Manage your accounts</button>
        <div className="profile-account-list">
          {showUnified && <button type="button" onClick={() => { onSelectUnified(); onClose(); }}><Avatar person={UNIFIED_ACCOUNT} size="sm" /><span className="profile-account-copy">All inboxes</span>{account?.isUnified && <Icon name="check" size={17} />}</button>}
          {accounts.map((item) => <button type="button" key={item.id} onClick={() => { setActiveAccount(item); onClose(); }}><Avatar person={item} size="sm" /><span className="profile-account-copy">{item.email}</span>{item.id === account?.id && <Icon name="check" size={17} />}</button>)}
        </div>
        <button type="button" className="logout-button" onClick={onLogout}>
          <Icon name="logout" size={18} />
          Log out
        </button>
        <div className="profile-menu-footer">
          <span>Self-hosted · credentials stay on your server</span>
        </div>
      </section>
    </>
  );
}
