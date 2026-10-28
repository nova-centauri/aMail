import { useEffect, useMemo, useRef, useState } from 'react';
import { AccountConnectForm } from './AccountConnectForm.jsx';
import { Icon } from './Icon.jsx';
import { Avatar, IconButton } from './ui.jsx';

export const ONBOARDING_STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'accounts', label: 'Connect inboxes' },
  { id: 'agent', label: 'Connect an agent' },
  { id: 'finish', label: 'Done' },
];

export function mcpEndpointUrl(location = window.location) {
  return `${location.origin}/mcp`;
}

export function agentConfigSnippets(url, tokenPlaceholder = '<AMAIL_ACCESS_TOKEN>') {
  const headers = { Authorization: `Bearer ${tokenPlaceholder}` };
  return {
    cursor: {
      label: 'Cursor',
      hint: 'Add to ~/.cursor/mcp.json or the project .cursor/mcp.json.',
      code: JSON.stringify({ mcpServers: { amail: { url, headers } } }, null, 2),
    },
    claudeConnector: {
      label: 'Claude Custom',
      hint: 'In Claude, open Customize → Connectors → Add custom connector. OAuth keeps the aMail credential out of Claude.',
      code: [
        `Server URL: ${url}`,
        'Authentication: Sign in now',
        'OAuth client: Register automatically',
        'Client ID / secret: leave blank',
      ].join('\n'),
    },
    claude: {
      label: 'Claude Code',
      hint: 'claude mcp add --transport http amail <url> --header "Authorization: Bearer …" also works.',
      code: JSON.stringify({ mcpServers: { amail: { type: 'http', url, headers } } }, null, 2),
    },
    curl: {
      label: 'Any HTTP client',
      hint: 'The same token unlocks the REST API under /api.',
      code: [
        `curl -H "Authorization: Bearer ${tokenPlaceholder}" \\`,
        `  "${url.replace(/\/mcp$/, '')}/api/messages?folder=inbox&q=is%3Aunanalyzed"`,
      ].join('\n'),
    },
  };
}

function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="secondary-button copy-button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
    >
      <Icon name={copied ? 'check' : 'link'} size={15} /> {copied ? 'Copied' : label}
    </button>
  );
}

function StepTrack({ current }) {
  return (
    <ol className="wizard-steps" aria-label="Setup progress">
      {ONBOARDING_STEPS.map((step, index) => {
        const state = index < current ? 'is-complete' : index === current ? 'is-current' : '';
        return (
          <li key={step.id} className={state} aria-current={index === current ? 'step' : undefined}>
            <span className="wizard-step-index">{index < current ? <Icon name="check" size={13} /> : index + 1}</span>
            <span className="wizard-step-label">{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function WelcomeStep({ onNext, onSkip }) {
  return (
    <div className="wizard-body">
      <div className="wizard-hero">
        <span className="wizard-hero-mark"><Icon name="sparkles" size={26} /></span>
        <h2 id="onboarding-title">Welcome to aMail</h2>
        <p id="onboarding-subtitle">Agentic Mail keeps every inbox in one private place and gives your agents a single, authenticated door to all of it.</p>
      </div>
      <ul className="wizard-feature-list">
        <li><span className="wizard-feature-icon"><Icon name="inbox" size={18} /></span><span><strong>All of your inboxes, one workspace</strong><small>Gmail, iCloud, Outlook, Mail-in-a-Box, or any IMAP provider. Credentials are encrypted on your server and never stored in the browser.</small></span></li>
        <li><span className="wizard-feature-icon"><Icon name="branch" size={18} /></span><span><strong>One endpoint for your agents</strong><small>Claude connects with OAuth; Cursor and other MCP or HTTP clients can use a Bearer token at <code>/mcp</code>.</small></span></li>
        <li><span className="wizard-feature-icon"><Icon name="sparkles" size={18} /></span><span><strong>Analyzed, not just read</strong><small>Every message carries an agent-side flag alongside read/unread. Agents ask for <code>is:unanalyzed</code> mail, do their work, and mark it analyzed so nothing is processed twice.</small></span></li>
        <li><span className="wizard-feature-icon"><Icon name="shield" size={18} /></span><span><strong>Private by default</strong><small>Trackers are blocked, remote images load through an optional Tor relay, and the app binds to localhost unless you say otherwise.</small></span></li>
      </ul>
      <div className="wizard-footer">
        <button type="button" className="text-button" onClick={onSkip}>Skip setup</button>
        <button type="button" className="primary-button" onClick={onNext}>Get started <Icon name="chevronRight" size={16} /></button>
      </div>
    </div>
  );
}

function AccountsStep({ accounts, onAccountAdded, onNext, onBack }) {
  const [adding, setAdding] = useState(accounts.length === 0);
  const [saving, setSaving] = useState(false);
  const [sessionAdded, setSessionAdded] = useState([]);
  const connected = accounts.length ? accounts : sessionAdded;
  return (
    <div className="wizard-body">
      <div className="wizard-heading">
        <h2 id="onboarding-title">Connect your inboxes</h2>
        <p id="onboarding-subtitle">Add every mailbox you want in one place. You can always add more later from the sidebar.</p>
      </div>
      {connected.length > 0 && (
        <ul className="wizard-account-list" aria-label="Connected accounts">
          {connected.map((account) => (
            <li key={account.id}>
              <Avatar person={account} size="sm" />
              <span><strong>{account.name}</strong><small>{account.email}</small></span>
              <em className="status-pill is-connected"><Icon name="check" size={13} /> Connected</em>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <div className="wizard-account-form">
          <AccountConnectForm
            variant="embedded"
            titleId="onboarding-title"
            subtitleId="onboarding-subtitle"
            autoFocus={false}
            submitLabel="Test & connect"
            onSavingChange={setSaving}
            onCancel={connected.length ? () => setAdding(false) : undefined}
            cancelLabel="Done adding"
            onAdded={(account) => {
              setSessionAdded((current) => [...current.filter((item) => item.id !== account.id), account]);
              onAccountAdded(account);
              setAdding(false);
            }}
          />
        </div>
      ) : (
        <button type="button" className="secondary-button wizard-add-another" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> Add another inbox</button>
      )}
      <div className="wizard-footer">
        <button type="button" className="text-button" onClick={onBack} disabled={saving}>Back</button>
        <span className="wizard-footer-spacer" />
        {connected.length ? (
          <button type="button" className="primary-button" onClick={onNext} disabled={saving}>Continue <Icon name="chevronRight" size={16} /></button>
        ) : (
          <button type="button" className="text-button" onClick={onNext} disabled={saving}>Skip for now</button>
        )}
      </div>
    </div>
  );
}

function AgentStep({ serverInfo, onNext, onBack }) {
  const url = useMemo(() => mcpEndpointUrl(), []);
  const snippets = useMemo(() => agentConfigSnippets(url), [url]);
  const [tab, setTab] = useState('cursor');
  const snippet = snippets[tab];
  const authProtected = serverInfo?.authProtected !== false;
  return (
    <div className="wizard-body">
      <div className="wizard-heading">
        <h2 id="onboarding-title">Connect an agent</h2>
        <p id="onboarding-subtitle">aMail exposes every connected inbox through one MCP endpoint. Point your agent at it and it can read, triage, reply, and mark mail as analyzed.</p>
      </div>
      <div className="wizard-endpoint">
        <span className="wizard-endpoint-label">MCP endpoint</span>
        <code>{url}</code>
        <CopyButton text={url} label="Copy URL" />
      </div>
      {authProtected ? (
        <p className="wizard-note"><Icon name="lock" size={14} /> Claude Custom uses a secure sign-in page. Header-based clients can still send <code>AMAIL_ACCESS_TOKEN</code> as a Bearer token; the value is never shown here.</p>
      ) : (
        <p className="wizard-note is-warning"><Icon name="alert" size={14} /> This server has no access token configured. Set <code>AMAIL_ACCESS_TOKEN</code> before exposing it to agents or a network.</p>
      )}
      <div className="wizard-tabs" role="tablist" aria-label="Agent configuration examples">
        {Object.entries(snippets).map(([id, item]) => (
          <button type="button" role="tab" key={id} aria-selected={tab === id} className={tab === id ? 'is-selected' : ''} onClick={() => setTab(id)}>{item.label}</button>
        ))}
      </div>
      <div className="wizard-snippet" role="tabpanel">
        <pre><code>{snippet.code}</code></pre>
        <div className="wizard-snippet-foot"><small>{snippet.hint}</small><CopyButton text={snippet.code} label="Copy config" /></div>
      </div>
      <div className="wizard-analyzed-explainer">
        <span className="wizard-feature-icon"><Icon name="sparkles" size={18} /></span>
        <div>
          <strong>The analyzed flag is your agent's read/unread</strong>
          <p>Ask for <code>list_messages</code> with <code>q: "is:unanalyzed"</code>, do the work, then call <code>message_action</code> with <code>action: "analyzed"</code> and your agent's name. The sidebar's <em>Not yet analyzed</em> view shows exactly what is still waiting.</p>
        </div>
      </div>
      <div className="wizard-footer">
        <button type="button" className="text-button" onClick={onBack}>Back</button>
        <span className="wizard-footer-spacer" />
        <button type="button" className="primary-button" onClick={onNext}>Continue <Icon name="chevronRight" size={16} /></button>
      </div>
    </div>
  );
}

function FinishStep({ accounts, onFinish, onBack }) {
  return (
    <div className="wizard-body">
      <div className="wizard-hero">
        <span className="wizard-hero-mark is-success"><Icon name="check" size={26} /></span>
        <h2 id="onboarding-title">{accounts.length ? 'You are all set' : 'Setup saved'}</h2>
        <p id="onboarding-subtitle">
          {accounts.length
            ? `${accounts.length} ${accounts.length === 1 ? 'inbox is' : 'inboxes are'} syncing. New mail lands in the unified inbox and waits in “Not yet analyzed” until an agent picks it up.`
            : 'You can connect inboxes any time from the sidebar, and reopen this guide from Settings.'}
        </p>
      </div>
      <ul className="wizard-feature-list is-compact">
        <li><span className="wizard-feature-icon"><Icon name="person" size={18} /></span><span><strong>Flag the people who matter</strong><small>Settings → Flagged people creates a sidebar folder for any set of addresses. Agents can manage the same list with <code>set_flags</code>.</small></span></li>
        <li><span className="wizard-feature-icon"><Icon name="key" size={18} /></span><span><strong>Add a passkey</strong><small>One-tap unlock on this device from Settings → Passkeys; the access token stays as a fallback.</small></span></li>
        <li><span className="wizard-feature-icon"><Icon name="help" size={18} /></span><span><strong>Keyboard first</strong><small>Press <kbd>?</kbd> anywhere for shortcuts.</small></span></li>
      </ul>
      <div className="wizard-footer">
        <button type="button" className="text-button" onClick={onBack}>Back</button>
        <span className="wizard-footer-spacer" />
        <button type="button" className="primary-button" onClick={onFinish}>Open my inbox</button>
      </div>
    </div>
  );
}

export function OnboardingWizard({ accounts = [], serverInfo, onAccountAdded, onFinish, onSkip, initialStep = 0 }) {
  const [step, setStep] = useState(initialStep);
  const dialogRef = useRef(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    dialogRef.current?.querySelector('h2')?.focus?.();
    const handleKeys = (event) => {
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [contenteditable="true"]')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', handleKeys);
    return () => {
      window.removeEventListener('keydown', handleKeys);
      previousFocus?.focus?.();
    };
  }, []);
  const next = () => setStep((current) => Math.min(ONBOARDING_STEPS.length - 1, current + 1));
  const back = () => setStep((current) => Math.max(0, current - 1));
  return (
    <div className="modal-layer wizard-layer">
      <div className="modal-scrim" aria-hidden="true" />
      <section ref={dialogRef} className="onboarding-wizard" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" aria-describedby="onboarding-subtitle">
        <header className="wizard-header">
          <span className="wizard-brand"><Icon name="mail" size={18} /> aMail setup</span>
          <StepTrack current={step} />
          <IconButton label="Close setup" onClick={onSkip}><Icon name="close" /></IconButton>
        </header>
        {step === 0 && <WelcomeStep onNext={next} onSkip={onSkip} />}
        {step === 1 && <AccountsStep accounts={accounts} onAccountAdded={onAccountAdded} onNext={next} onBack={back} />}
        {step === 2 && <AgentStep serverInfo={serverInfo} onNext={next} onBack={back} />}
        {step === 3 && <FinishStep accounts={accounts} onFinish={onFinish} onBack={back} />}
      </section>
    </div>
  );
}
