import { useEffect, useRef, useState } from 'react';
import { BrandMark, Icon } from './Icon.jsx';
import { SearchOptions } from './SearchOptions.jsx';
import { Avatar, IconButton, Tooltip } from './ui.jsx';

export function Topbar({
  onToggleSidebar,
  onGoHome,
  query,
  setQuery,
  onOpenSettings,
  onLogout,
  onOpenProfile,
  onOpenShortcuts,
  searchRef,
  account,
  isDemo,
  onCommitSearch,
  deepSearchAvailable = false,
  deepSearchRunning = false,
}) {
  const [optionsOpen, setOptionsOpen] = useState(false);
  const searchWrapRef = useRef(null);
  useEffect(() => {
    if (!optionsOpen) return undefined;
    const onPointer = (event) => {
      if (!searchWrapRef.current?.contains(event.target)) setOptionsOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setOptionsOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [optionsOpen]);
  return (
    <header className="topbar">
      <Tooltip text="Toggle navigation" placement="start">
        <IconButton label="Toggle navigation" onClick={onToggleSidebar} className="top-menu">
          <Icon name="menu" />
        </IconButton>
      </Tooltip>
      <button type="button" className="brand" aria-label="aMail home" onClick={onGoHome}>
        <BrandMark />
        <span className="brand-name"><em>a</em>Mail</span>
        {isDemo && <span className="preview-pill">Preview</span>}
      </button>
      <div className="search-wrap" ref={searchWrapRef}>
        <div className={`search-shell ${optionsOpen ? 'is-open' : ''}`}>
          <Icon name="search" size={21} className="search-icon" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onCommitSearch?.();
              }
            }}
            placeholder="Search mail"
            aria-label="Search mail"
          />
          {query && (
            <IconButton label="Clear search" onClick={() => setQuery('')} className="search-clear">
              <Icon name="close" size={18} />
            </IconButton>
          )}
          {deepSearchAvailable && (
            <Tooltip text="Search every account and folder, including mail that is not downloaded yet">
              <IconButton
                label="Deep search"
                className="search-deep"
                active={deepSearchRunning}
                onClick={() => onCommitSearch?.()}
              >
                <Icon name="sparkles" size={18} />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip text="Search options">
            <IconButton
              label="Search options"
              className="search-filter"
              active={optionsOpen}
              onClick={() => setOptionsOpen((current) => !current)}
            >
              <Icon name="tune" size={20} />
            </IconButton>
          </Tooltip>
        </div>
        <SearchOptions
          open={optionsOpen}
          query={query}
          onApply={setQuery}
          onClose={() => setOptionsOpen(false)}
        />
      </div>
      <div className="top-actions">
        {onOpenShortcuts && (
          <Tooltip text="Keyboard shortcuts">
            <IconButton label="Keyboard shortcuts" onClick={onOpenShortcuts}><Icon name="help" /></IconButton>
          </Tooltip>
        )}
        <Tooltip text="Quick settings">
          <IconButton label="Quick settings" onClick={onOpenSettings}><Icon name="settings" size={22} /></IconButton>
        </Tooltip>
        <Tooltip text="Log out">
          <IconButton label="Log out of this session" onClick={onLogout}><Icon name="logout" size={22} /></IconButton>
        </Tooltip>
        <button type="button" className="account-trigger" onClick={onOpenProfile} aria-label="Open account menu">
          <Avatar person={account} size="top" />
        </button>
      </div>
    </header>
  );
}
