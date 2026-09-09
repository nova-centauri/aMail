import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { AccessPanel } from './components/AccessPanel.jsx';
import { AddAccountModal } from './components/AddAccountModal.jsx';
import { ComposeModal } from './components/ComposeModal.jsx';
import { OnboardingWizard } from './components/OnboardingWizard.jsx';
import { Icon } from './components/Icon.jsx';
import { MailList } from './components/MailList.jsx';
import { ProfileMenu } from './components/ProfileMenu.jsx';
import { SettingsPanel } from './components/SettingsPanel.jsx';
import { ShortcutCheatsheet } from './components/ShortcutCheatsheet.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import { ThreadView } from './components/ThreadView.jsx';
import { Topbar } from './components/Topbar.jsx';
import { Toast } from './components/ui.jsx';
import { DEMO_PERSON_FLAGS, EMPTY_FOLDER_COUNTS, SMART_CATEGORIES, UNIFIED_ACCOUNT } from './mail/constants.js';
import { demoAccounts, demoDraftThreads, demoMailboxThreads } from './mail/demo.js';
import { normalizeFreshDraft, pruneDismissedFreshDrafts, visibleFreshDrafts } from './mail/fresh-drafts.js';
import { countSmartCategories, filterVisibleThreads, findPersonFlag } from './mail/filter.js';
import { useLiveMailboxSync } from './mail/live-sync.js';
import { quotedComposeHtml } from './mail/html.js';
import { formatMessageDate, getArray, normalizeAccount, normalizePerson, normalizeThread, recipientArray, formatRecipients } from './mail/normalize.js';
import { collectKnownPeople } from './mail/people.js';
import { sanitizeSignatureHtml } from './mail/signature.js';
import { syncResultStatus, syncSkippedMessageCount } from './mail/sync.js';
import { authenticateWithPasskey, passkeysSupported, registerPasskey } from './passkeys.js';
import { clampIndex, shortcutAction } from './shortcuts.js';
import { getAccessToken, persistAccessToken, readDismissedFreshDrafts, readUiPrefs, writeDismissedFreshDrafts, writeUiPrefs } from './storage.js';

export default function App() {
  const initialPrefs = useMemo(() => readUiPrefs(), []);
  const [sidebarCompact, setSidebarCompact] = useState(Boolean(initialPrefs.sidebarCompact));
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [activeFolder, setActiveFolder] = useState('inbox');
  const [accounts, setAccounts] = useState([]);
  const [activeAccount, setActiveAccount] = useState(null);
  const [threads, setThreads] = useState([]);
  const [selectedThread, setSelectedThread] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [activePersonFlag, setActivePersonFlag] = useState(null);
  const [personFlags, setPersonFlags] = useState([]);
  const [opsSources, setOpsSources] = useState([]);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(Boolean(initialPrefs.onboardingDismissed));
  const [serverInfo, setServerInfo] = useState(null);
  const [mailTotal, setMailTotal] = useState(0);
  const [categoryCounts, setCategoryCounts] = useState(() => countSmartCategories([]));
  const [folderCounts, setFolderCounts] = useState(() => ({ ...EMPTY_FOLDER_COUNTS }));
  const [loading, setLoading] = useState(true);
  const [isDemo, setIsDemo] = useState(false);
  const [offline, setOffline] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeContext, setComposeContext] = useState(null);
  const [notice, setNotice] = useState('');
  const [privacy, setPrivacy] = useState({ privateImages: initialPrefs.privateImages !== false });
  const [density, setDensity] = useState(['Default', 'Comfortable', 'Compact'].includes(initialPrefs.density) ? initialPrefs.density : 'Default');
  const [accessToken, setAccessToken] = useState(() => getAccessToken());
  const [accessOpen, setAccessOpen] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [passkeyCount, setPasskeyCount] = useState(0);
  const [keyMode, setKeyMode] = useState('env');
  const [passkeys, setPasskeys] = useState([]);
  const [sessionStamp, setSessionStamp] = useState(0);
  const [demoIdentities, setDemoIdentities] = useState(() => demoAccounts.map((item) => ({ ...item })));
  const [cursorIndex, setCursorIndex] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const searchRef = useRef(null);
  const loadRequestRef = useRef(0);
  const syncInFlightRef = useRef(false);
  const demoDraftsRef = useRef([]);
  const demoDraftsSeededRef = useRef(false);
  const [savedDrafts, setSavedDrafts] = useState([]);
  const [dismissedFreshDrafts, setDismissedFreshDrafts] = useState(() => readDismissedFreshDrafts());
  const canUsePasskeys = passkeysSupported();

  const updateDensity = (value) => {
    setDensity(value);
    writeUiPrefs({ density: value });
  };

  const toggleSidebarCompact = () => {
    setSidebarCompact((current) => {
      const next = !current;
      writeUiPrefs({ sidebarCompact: next });
      return next;
    });
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 280);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const unread = Number(folderCounts.inbox) || 0;
    document.title = unread > 0 ? `(${unread}) aMail` : 'aMail';
  }, [folderCounts.inbox]);

  const openNewCompose = () => {
    setComposeContext(null);
    setComposeOpen(true);
  };

  const closeCompose = () => {
    setComposeOpen(false);
    setComposeContext(null);
  };

  const openReplyComposer = (thread, message, { replyAll = false } = {}) => {
    const subject = /^re:/i.test(thread.subject || '') ? thread.subject : `Re: ${thread.subject || '(no subject)'}`;
    const sender = message.from?.name || message.from?.email || 'the sender';
    const original = String(message.body || '').trim();
    const sentMessage = Boolean(message.isSent || thread.isSent || thread.folder === 'sent');
    const replyTo = recipientArray(message.replyTo);
    const primaryRecipients = sentMessage ? recipientArray(message.to) : replyTo.length ? replyTo : [message.from];
    const toCandidates = replyAll
      ? [...primaryRecipients, ...(!sentMessage ? recipientArray(message.to) : [])]
      : primaryRecipients.slice(0, 1);
    const identityList = accounts.length ? accounts : isDemo ? demoIdentities : [];
    const ownAddresses = new Set(identityList.map((item) => String(item.email || '').toLowerCase()).filter(Boolean));
    const seen = new Set();
    const uniqueRecipients = (values) => values.filter(Boolean).map((value) => normalizePerson(value)).filter((person) => {
      const email = String(person.email || '').toLowerCase();
      if (!email || seen.has(email) || (replyAll && ownAddresses.has(email))) return false;
      seen.add(email);
      return true;
    });
    // Keep original Cc recipients in Cc while de-duplicating them against To.
    const originalCc = replyAll ? recipientArray(message.cc) : [];
    const recipients = uniqueRecipients(toCandidates);
    const ccRecipients = uniqueRecipients(originalCc);
    if (!recipients.length && primaryRecipients[0]) recipients.push(normalizePerson(primaryRecipients[0]));
    setComposeContext({
      mode: replyAll ? 'reply-all' : 'reply',
      accountId: message.accountId || thread.accountId || null,
      to: formatRecipients(recipients),
      cc: formatRecipients(ccRecipients),
      subject,
      body: original ? `\n\nOn ${formatMessageDate(message.timestamp)}, ${sender} wrote:\n${original}` : '',
      htmlBody: (original || message.bodyHtml)
        ? quotedComposeHtml({
          date: formatMessageDate(message.timestamp),
          sender,
          html: message.bodyHtml ? sanitizeSignatureHtml(message.bodyHtml) : '',
          text: original,
        })
        : '',
      threadId: thread.threadId || thread.id,
      replyToMessageId: message.rfcMessageId || undefined,
    });
    setComposeOpen(true);
  };

  const openForwardComposer = (thread, message) => {
    const subject = /^fwd:/i.test(thread.subject || '') ? thread.subject : `Fwd: ${thread.subject || '(no subject)'}`;
    const sender = message.from?.name || message.from?.email || 'Unknown sender';
    const original = String(message.body || '').trim();
    setComposeContext({
      mode: 'forward',
      accountId: message.accountId || thread.accountId || null,
      to: '',
      subject,
      body: `\n\n---------- Forwarded message ----------\nFrom: ${sender}\nDate: ${formatMessageDate(message.timestamp)}\nSubject: ${thread.subject || '(no subject)'}\n\n${original}`,
      htmlBody: quotedComposeHtml({
        date: formatMessageDate(message.timestamp),
        sender,
        subject: thread.subject,
        html: message.bodyHtml ? sanitizeSignatureHtml(message.bodyHtml) : '',
        text: original,
        mode: 'forward',
      }),
    });
    setComposeOpen(true);
  };

  const loadMailbox = useCallback(async ({ keepSelection = true, silent = false } = {}) => {
    const requestId = ++loadRequestRef.current;
    if (!silent) setLoading(true);
    try {
      let session = null;
      try {
        session = await api('/session');
      } catch (sessionError) {
        if (sessionError.status === 401 || sessionError.status === 403) throw sessionError;
      }
      if (session?.keyMode) setKeyMode(session.keyMode);
      if (session?.protected && !session.authenticated) {
        setOffline(false);
        setAuthRequired(true);
        setAuthenticated(false);
        setAccessOpen(true);
        setPasskeyCount(Number(session.passkeys) || 0);
        setIsDemo(false);
        setAccounts([]);
        setThreads([]);
        setMailTotal(0);
        setCategoryCounts(countSmartCategories([]));
        setFolderCounts({ ...EMPTY_FOLDER_COUNTS });
        setSelectedThread(null);
        setSavedDrafts([]);
        return;
      }
      const params = new URLSearchParams({ folder: activeFolder });
      if (activeAccount?.id) params.set('accountId', activeAccount.id);
      if (activeFolder === 'inbox' && !activePersonFlag && activeCategory !== 'all') params.set('category', activeCategory);
      if (activePersonFlag) params.set('flag', activePersonFlag);
      if (debouncedQuery) params.set('q', debouncedQuery);
      const draftParams = new URLSearchParams();
      if (activeAccount?.id) draftParams.set('accountId', activeAccount.id);
      const [accountData, mailData, draftData] = await Promise.all([
        api('/accounts'),
        api(`/messages?${params.toString()}`),
        api(`/drafts${draftParams.toString() ? `?${draftParams}` : ''}`).catch(() => ({ drafts: [] })),
      ]);
      if (requestId !== loadRequestRef.current) return;
      const nextAccounts = getArray(accountData, ['accounts', 'items']).map(normalizeAccount);
      const rawThreads = getArray(mailData, ['threads', 'messages', 'items', 'data']);
      const nextThreads = rawThreads.map(normalizeThread);
      const isFreshSetup = nextAccounts.length === 0 && nextThreads.length === 0;
      if (isFreshSetup && !demoDraftsSeededRef.current) {
        demoDraftsRef.current = demoDraftThreads.map((item) => ({ ...item }));
        demoDraftsSeededRef.current = true;
      }
      const previewThreads = [...demoDraftsRef.current, ...demoMailboxThreads];
      const responseTotal = Number(mailData?.total);
      const nextCategoryCounts = mailData?.categoryCounts && typeof mailData.categoryCounts === 'object'
        ? Object.fromEntries(SMART_CATEGORIES.filter((item) => item.id !== 'all').map((item) => [item.id, Number(mailData.categoryCounts[item.id] || 0)]))
        : countSmartCategories(nextThreads);
      const nextFolderCounts = mailData?.folderCounts && typeof mailData.folderCounts === 'object'
        ? {
          inbox: Number(mailData.folderCounts.inbox) || 0,
          starred: Number(mailData.folderCounts.starred) || 0,
          snoozed: Number(mailData.folderCounts.snoozed) || 0,
          drafts: Number(mailData.folderCounts.drafts) || 0,
          unanalyzed: Number(mailData.folderCounts.unanalyzed) || 0,
        }
        : null;
      setAuthRequired(false);
      setAuthenticated(true);
      setPasskeyCount(Number(session?.passkeys) || 0);
      setOffline(false);
      setAccounts(isFreshSetup ? [] : nextAccounts);
      // Null represents the unified inbox. Preserve an explicit per-account choice,
      // but start every newly loaded mailbox with all connected accounts visible.
      setActiveAccount((current) => nextAccounts.find((item) => item.id === current?.id) || null);
      setThreads(isFreshSetup ? previewThreads : nextThreads);
      setMailTotal(isFreshSetup ? previewThreads.length : Number.isFinite(responseTotal) ? responseTotal : nextThreads.length);
      setCategoryCounts(isFreshSetup ? countSmartCategories(previewThreads) : nextCategoryCounts);
      if (isFreshSetup) {
        const preview = previewThreads;
        setFolderCounts({
          inbox: preview.filter((thread) => thread.folder === 'inbox' && thread.unread).length,
          starred: preview.filter((thread) => thread.starred).length,
          snoozed: preview.filter((thread) => thread.folder === 'snoozed').length,
          drafts: preview.filter((thread) => thread.folder === 'drafts').length,
          unanalyzed: preview.filter((thread) => thread.folder === 'inbox' && thread.analyzed === false).length,
        });
      } else if (nextFolderCounts) {
        setFolderCounts(nextFolderCounts);
      }
      setIsDemo(isFreshSetup);
      if (isFreshSetup && !onboardingDismissed) setOnboardingOpen(true);
      const nextSavedDrafts = isFreshSetup
        ? previewThreads.filter((thread) => thread.folder === 'drafts' || thread.draftId).map(normalizeFreshDraft)
        : getArray(draftData, ['drafts', 'items']).map(normalizeFreshDraft);
      setSavedDrafts(nextSavedDrafts);
      const prunedDismissals = pruneDismissedFreshDrafts(dismissedFreshDrafts, nextSavedDrafts);
      if (prunedDismissals !== dismissedFreshDrafts) {
        setDismissedFreshDrafts(prunedDismissals);
        writeDismissedFreshDrafts(prunedDismissals);
      }
      if (keepSelection && selectedThread) {
        const replacement = (isFreshSetup ? previewThreads : nextThreads).find((item) => item.id === selectedThread.id);
        setSelectedThread(replacement || null);
      } else {
        setSelectedThread(null);
      }
    } catch (error) {
      if (requestId !== loadRequestRef.current) return;
      if (error.status === 401 || error.status === 403) {
        setOffline(false);
        setAuthRequired(true);
        setAuthenticated(false);
        setAccessOpen(true);
        setIsDemo(false);
        setAccounts([]);
        setThreads([]);
        setMailTotal(0);
        setCategoryCounts(countSmartCategories([]));
        setFolderCounts({ ...EMPTY_FOLDER_COUNTS });
        setSelectedThread(null);
        setSavedDrafts([]);
      } else {
        // Keep the last confirmed mailbox intact. Preview data is only enabled
        // after a successful zero-account response, never as an outage fallback.
        setOffline(true);
        setNotice('aMail is offline. Showing the last mailbox loaded from this server.');
      }
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, [accessToken, activeAccount?.id, activeCategory, activePersonFlag, activeFolder, debouncedQuery, onboardingDismissed, selectedThread]);

  const liveSyncInboxes = useCallback(async () => {
    if (isDemo || authRequired || !authenticated) return;
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    try {
      await api('/sync', { method: 'POST', body: JSON.stringify({ mailbox: 'INBOX' }) });
    } catch {
      // Keep the current mailbox. A later tick or a manual refresh will retry.
    } finally {
      try {
        await loadMailbox({ keepSelection: true, silent: true });
      } finally {
        syncInFlightRef.current = false;
      }
    }
  }, [authRequired, authenticated, isDemo, loadMailbox]);

  useLiveMailboxSync({
    enabled: authenticated && !authRequired && !isDemo,
    onSync: liveSyncInboxes,
  });

  useEffect(() => { loadMailbox({ keepSelection: false }); }, [activeFolder, activeAccount?.id, activeCategory, activePersonFlag, debouncedQuery, accessToken, sessionStamp]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!authenticated || authRequired) return undefined;
    let cancelled = false;
    api('/flags').then((payload) => {
      if (cancelled) return;
      setPersonFlags(Array.isArray(payload?.flags) ? payload.flags : []);
      setOpsSources(Array.isArray(payload?.opsSources) ? payload.opsSources : []);
    }).catch(() => undefined);
    api('/health').then((payload) => { if (!cancelled) setServerInfo(payload || null); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [authenticated, authRequired, sessionStamp]);

  const savePersonFlags = async (flags) => {
    const payload = await api('/flags', { method: 'PUT', body: JSON.stringify({ flags }) });
    const saved = Array.isArray(payload?.flags) ? payload.flags : [];
    setPersonFlags(saved);
    if (activePersonFlag && !saved.some((flag) => flag.id === activePersonFlag)) setActivePersonFlag(null);
    setNotice(saved.length ? 'Flagged people saved.' : 'Flagged people cleared.');
    return saved;
  };

  const dismissOnboarding = () => {
    setOnboardingOpen(false);
    setOnboardingDismissed(true);
    writeUiPrefs({ onboardingDismissed: true });
  };

  useEffect(() => {
    if (!settingsOpen || authRequired) return undefined;
    let cancelled = false;
    api('/session/passkeys').then((payload) => {
      if (cancelled) return;
      const items = payload?.passkeys || [];
      setPasskeys(items);
      setPasskeyCount(items.length);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [settingsOpen, authRequired, sessionStamp]);

  useEffect(() => {
    setSelectedIds([]);
    setSelectedThread(null);
  }, [activeAccount?.id, activeCategory, activePersonFlag, activeFolder, debouncedQuery, accessToken]);

  useEffect(() => {
    if (activeFolder !== 'inbox' && activeCategory !== 'all') {
      setActiveCategory('all');
      setSelectedIds([]);
    }
    if (activeFolder !== 'inbox' && activePersonFlag) {
      setActivePersonFlag(null);
    }
  }, [activeCategory, activeFolder, activePersonFlag]);

  const syncMailbox = async (account = activeAccount) => {
    if (isDemo) {
      await loadMailbox({ keepSelection: false });
      return;
    }
    if (syncInFlightRef.current) {
      setNotice('Sync is already running.');
      return;
    }
    syncInFlightRef.current = true;
    setLoading(true);
    setNotice(account ? `Syncing ${account.email}…` : 'Syncing all connected accounts…');
    try {
      const syncPath = account?.id ? `/accounts/${encodeURIComponent(account.id)}/sync` : '/sync';
      const response = await api(syncPath, { method: 'POST', body: JSON.stringify({ mailbox: 'INBOX' }) });
      const status = syncResultStatus(response);
      const skippedMessages = syncSkippedMessageCount(response);
      if (status === 'failed') setNotice('Mailbox sync failed. Showing the latest stored mail.');
      else if (skippedMessages) setNotice(`Mailbox sync kept running; ${skippedMessages} ${skippedMessages === 1 ? 'message was' : 'messages were'} skipped by the download safety limit.`);
      else if (status === 'partial') setNotice('Mailbox sync finished with some folders unavailable.');
      else if (status === 'skipped') setNotice('Sync is disabled for this account.');
      else setNotice('Mailbox sync complete.');
    } catch {
      setNotice('Sync could not complete. Showing the latest stored mail.');
    } finally {
      try {
        await loadMailbox({ keepSelection: true });
      } finally {
        syncInFlightRef.current = false;
      }
    }
  };

  const refreshMailbox = () => syncMailbox(activeAccount);

  const effectivePersonFlags = isDemo && !personFlags.length ? DEMO_PERSON_FLAGS : personFlags;
  const visibleThreads = useMemo(() => filterVisibleThreads(threads, {
    activeFolder,
    activeCategory,
    activePersonFlag,
    personFlags: effectivePersonFlags,
    query,
  }), [threads, activeFolder, activeCategory, activePersonFlag, effectivePersonFlags, query]);
  const activeFlag = findPersonFlag(effectivePersonFlags, activePersonFlag);
  const agentQueueActive = /^is:unanalyzed$/i.test(query.trim());

  const cursorThread = visibleThreads[clampIndex(cursorIndex, visibleThreads.length)] || null;

  useEffect(() => {
    setCursorIndex((current) => clampIndex(current, visibleThreads.length));
  }, [visibleThreads]);

  useEffect(() => {
    if (!cursorThread?.id) return undefined;
    document.querySelector(`[data-thread-id="${CSS.escape(cursorThread.id)}"]`)?.scrollIntoView({ block: 'nearest' });
    return undefined;
  }, [cursorThread?.id]);

  const visibleTotal = isDemo ? visibleThreads.length : mailTotal;
  const freshDrafts = useMemo(
    () => (authenticated && !authRequired ? visibleFreshDrafts(savedDrafts, dismissedFreshDrafts) : []),
    [authenticated, authRequired, dismissedFreshDrafts, savedDrafts],
  );

  const counts = useMemo(() => ({
    inbox: folderCounts.inbox,
    starred: folderCounts.starred,
    snoozed: folderCounts.snoozed,
    drafts: folderCounts.drafts,
    unanalyzed: folderCounts.unanalyzed || 0,
  }), [folderCounts]);

  const goHome = () => {
    setActiveFolder('inbox');
    setActiveCategory('all');
    setActivePersonFlag(null);
    setQuery('');
    setSelectedThread(null);
    setSelectedIds([]);
    setMobileSidebarOpen(false);
    setSettingsOpen(false);
    setProfileOpen(false);
  };

  const selectAgentQueue = () => {
    setActiveFolder('inbox');
    setActiveCategory('all');
    setActivePersonFlag(null);
    setQuery('is:unanalyzed');
    setSelectedIds([]);
    setSelectedThread(null);
  };

  const selectPersonFlag = (flagId) => {
    if (flagId) {
      setActiveFolder('inbox');
      setActiveCategory('all');
      setActivePersonFlag(flagId);
    } else {
      setActivePersonFlag(null);
    }
    setSelectedIds([]);
    setSelectedThread(null);
  };

  const openSavedDraft = async (source, { expanded = false } = {}) => {
    const draftMessage = source.messages?.at(-1) || source;
    const draftId = source.draftId || String(source.id || '').replace(/^draft:/, '');
    let attachments = source.attachments || draftMessage.attachments || [];
    let body = draftMessage.body || source.textBody || '';
    let htmlBody = draftMessage.bodyHtml || source.htmlBody || '';
    let subject = source.subject === '(no subject)' ? '' : (source.subject || '');
    let to = formatRecipients(source.to || draftMessage.to);
    let cc = formatRecipients(source.cc || draftMessage.cc);
    let bcc = formatRecipients(source.bcc || draftMessage.bcc);
    if (!isDemo && draftId) {
      try {
        const data = await api(`/drafts/${encodeURIComponent(draftId)}`);
        const draft = data?.draft || data;
        attachments = draft?.attachments || attachments;
        body = draft?.textBody || body;
        htmlBody = draft?.htmlBody || htmlBody;
        subject = draft?.subject || subject;
        to = formatRecipients(draft?.to || source.to);
        cc = formatRecipients(draft?.cc || source.cc);
        bcc = formatRecipients(draft?.bcc || source.bcc);
      } catch {
        // The list payload is enough to keep editing if the full draft fetch fails.
      }
    }
    setComposeContext({
      mode: 'draft',
      draftId,
      accountId: source.accountId || draftMessage.accountId || null,
      threadId: source.threadId && source.threadId !== source.id && !String(source.threadId).startsWith('draft:') ? source.threadId : null,
      to,
      cc,
      bcc,
      subject,
      body,
      htmlBody: htmlBody || body,
      attachments,
      expanded,
    });
    setComposeOpen(true);
  };

  const openThread = async (thread) => {
    if (thread.folder === 'drafts' || thread.draftId) {
      await openSavedDraft(thread);
      return;
    }
    const alreadyRead = !thread.unread;
    const provisional = { ...thread, unread: false };
    setSelectedThread(provisional);
    setThreads((current) => current.map((item) => item.id === thread.id ? provisional : item));
    if (!alreadyRead) {
      setFolderCounts((current) => ({ ...current, inbox: Math.max(0, current.inbox - 1) }));
      if (!isDemo) api(`/messages/${encodeURIComponent(thread.id)}/read`, { method: 'POST' }).catch(() => undefined);
    }
    if (isDemo || thread.messages?.length > 1) return;
    try {
      const data = await api(`/threads/${encodeURIComponent(thread.threadId)}`);
      const raw = {
        ...(data?.thread || data || {}),
        messages: data?.messages || data?.thread?.messages || [],
      };
      const detailed = normalizeThread(raw);
      setSelectedThread(detailed);
      setThreads((current) => current.map((item) => item.id === detailed.id ? { ...item, ...detailed } : item));
    } catch {
      // The compact list payload remains a valid reader view.
    }
  };

  const toggleStar = (thread) => {
    const next = { ...thread, starred: !thread.starred };
    setThreads((current) => current.map((item) => item.id === thread.id ? next : item));
    setSelectedThread((current) => current?.id === thread.id ? next : current);
    setFolderCounts((current) => ({
      ...current,
      starred: Math.max(0, current.starred + (next.starred ? 1 : -1)),
    }));
    if (!isDemo) api(`/messages/${encodeURIComponent(thread.id)}/star`, { method: 'POST', body: JSON.stringify({ starred: next.starred }) }).catch(() => setNotice('Could not update the star.'));
  };

  const applyAction = (action, targetIds = selectedIds) => {
    if (!targetIds.length && selectedThread) targetIds = [selectedThread.id];
    if (!targetIds.length) return;
    const affected = new Set(targetIds);
    if (action === 'unread') {
      setThreads((current) => current.map((item) => affected.has(item.id) ? { ...item, unread: true } : item));
      setSelectedThread((current) => current && affected.has(current.id) ? { ...current, unread: true } : current);
    } else if (action === 'read') {
      setThreads((current) => current.map((item) => affected.has(item.id) ? { ...item, unread: false } : item));
    } else if (action === 'analyzed' || action === 'unanalyzed') {
      const analyzed = action === 'analyzed';
      const patch = { analyzed, unanalyzedCount: analyzed ? 0 : 1, analyzedBy: analyzed ? 'you' : null, analyzedAt: analyzed ? new Date().toISOString() : null };
      const update = (item) => affected.has(item.id) ? { ...item, ...patch } : item;
      setThreads((current) => agentQueueActive && analyzed ? current.filter((item) => !affected.has(item.id)) : current.map(update));
      setSelectedThread((current) => current && affected.has(current.id) ? { ...current, ...patch } : current);
    } else if (['archive', 'trash', 'spam', 'snooze'].includes(action)) {
      setThreads((current) => current.filter((item) => !affected.has(item.id)));
      if (selectedThread && affected.has(selectedThread.id)) setSelectedThread(null);
    }
    setSelectedIds([]);
    const labels = {
      archive: 'Conversation archived',
      trash: 'Conversation moved to Trash',
      spam: 'Conversation reported as spam',
      snooze: 'Conversation snoozed until tomorrow',
      unread: 'Marked as unread',
      read: 'Marked as read',
      analyzed: 'Marked as analyzed',
      unanalyzed: 'Marked as not yet analyzed',
    };
    setNotice(labels[action] || 'Updated');
    if (['archive', 'trash', 'spam', 'snooze', 'unread', 'read', 'analyzed', 'unanalyzed'].includes(action)) {
      setFolderCounts((current) => {
        // Keep badges roughly honest after optimistic local actions until the
        // next full mailbox load replaces them with server totals.
        const delta = targetIds.length;
        if (action === 'analyzed') return { ...current, unanalyzed: Math.max(0, (current.unanalyzed || 0) - delta) };
        if (action === 'unanalyzed') return { ...current, unanalyzed: (current.unanalyzed || 0) + delta };
        if (action === 'unread') return { ...current, inbox: current.inbox + delta };
        if (action === 'read') return { ...current, inbox: Math.max(0, current.inbox - delta) };
        if (action === 'snooze') return { ...current, snoozed: current.snoozed + delta, inbox: Math.max(0, current.inbox - delta) };
        if (['archive', 'trash', 'spam'].includes(action)) return { ...current, inbox: Math.max(0, current.inbox - delta) };
        return current;
      });
    }
    if (!isDemo && labels[action]) {
      const body = action === 'analyzed' ? JSON.stringify({ by: 'human' }) : undefined;
      void Promise.all(targetIds.map((id) => api(`/messages/${encodeURIComponent(id)}/${action}`, { method: 'POST', ...(body ? { body } : {}) })))
        .then((results) => {
          const outcomes = results.flatMap((result) => result?.messages || (result?.message ? [result.message] : []))
            .map((message) => message?.remoteSync)
            .filter(Boolean);
          const failed = outcomes.find((outcome) => outcome.status === 'failed');
          const unsynced = outcomes.find((outcome) => ['local-only', 'skipped'].includes(outcome.status));
          if (failed) setNotice(`${labels[action] || 'Updated'} locally; IMAP did not confirm the change.`);
          else if (unsynced && !['snooze', 'analyzed', 'unanalyzed'].includes(action)) setNotice(`${labels[action] || 'Updated'} locally; the provider change was not available.`);
          else if (action === 'snooze') setNotice(labels.snooze);
        })
        .catch(() => setNotice('The local view was updated; the server action failed.'));
    }
  };

  useEffect(() => {
    const handleKeys = (event) => {
      // Open context menus own their keys (arrows, Enter, Escape, typeahead).
      if (event.target?.closest?.('[role="menu"]')) return;
      const action = shortcutAction(event);
      if (!action) return;
      if (composeOpen && action !== 'escape' && action !== 'help') return;
      event.preventDefault();
      const focused = cursorThread || selectedThread || visibleThreads[0] || null;
      if (action === 'compose') openNewCompose();
      if (action === 'search') searchRef.current?.focus();
      if (action === 'help') setShortcutsOpen((value) => !value);
      if (action === 'escape') {
        if (shortcutsOpen) { setShortcutsOpen(false); return; }
        if (composeOpen) return;
        setSettingsOpen(false);
        setProfileOpen(false);
        setMobileSidebarOpen(false);
        setAccessOpen(false);
        setSelectedThread(null);
      }
      if (action === 'next' || action === 'previous') {
        const delta = action === 'next' ? 1 : -1;
        if (selectedThread) {
          const index = visibleThreads.findIndex((thread) => thread.id === selectedThread.id);
          const next = visibleThreads[clampIndex((index < 0 ? 0 : index) + delta, visibleThreads.length)];
          if (next) void openThread(next);
          return;
        }
        setCursorIndex((current) => clampIndex((current < 0 ? 0 : current) + delta, visibleThreads.length));
      }
      if (action === 'open' && focused) void openThread(focused);
      if (action === 'back') setSelectedThread(null);
      if (action === 'select' && focused) {
        setSelectedIds((current) => current.includes(focused.id) ? current.filter((id) => id !== focused.id) : [...current, focused.id]);
      }
      if (action === 'archive' && focused) applyAction('archive', selectedIds.length ? selectedIds : [focused.id]);
      if (action === 'trash' && focused) applyAction('trash', selectedIds.length ? selectedIds : [focused.id]);
      if (action === 'star' && focused) toggleStar(focused);
      if (action === 'reply' && focused) {
        const target = selectedThread?.id === focused.id ? selectedThread : focused;
        const message = target.messages?.at(-1) || target;
        openReplyComposer(target, message);
      }
    };
    window.addEventListener('keydown', handleKeys);
    return () => window.removeEventListener('keydown', handleKeys);
  }, [composeOpen, shortcutsOpen, cursorThread, selectedThread, visibleThreads, selectedIds]);

  const loadRemoteContent = async (message) => {
    try {
      const response = !isDemo ? await api(`/messages/${encodeURIComponent(message.id)}/remote-content`, { method: 'POST' }) : null;
      const hydrated = response?.message || response;
      const update = (thread) => ({ ...thread, messages: thread.messages.map((item) => item.id === message.id ? { ...item, remoteContentLoaded: true, bodyHtml: hydrated?.htmlBody || item.bodyHtml } : item) });
      setThreads((current) => current.map(update));
      setSelectedThread((current) => update(current));
      setNotice('Remote content loaded through the privacy relay.');
    } catch {
      setNotice('Remote content could not be loaded privately.');
    }
  };

  const sendMessage = (payload, localOnly, senderAccount, result) => {
    const from = senderAccount || activeAccount || accounts[0] || demoAccounts[0];
    const deliveredMessage = result?.message && typeof result.message === 'object' ? result.message : null;
    const delivery = result?.delivery || deliveredMessage?.delivery;
    const sentThread = normalizeThread({
      id: deliveredMessage?.id ? `sent-${deliveredMessage.id}` : `sent-${Date.now()}`,
      threadId: deliveredMessage?.threadId,
      accountId: deliveredMessage?.accountId || payload.accountId,
      subject: deliveredMessage?.subject || payload.subject || '(no subject)',
      snippet: deliveredMessage?.snippet || payload.textBody,
      from,
      timestamp: deliveredMessage?.sentAt || new Date().toISOString(),
      folder: 'sent',
      messages: [deliveredMessage || { ...payload, id: `sent-message-${Date.now()}`, from, timestamp: new Date().toISOString(), isSent: true }],
    });
    setThreads((current) => [sentThread, ...current]);
    setNotice(localOnly
      ? 'Message saved in the local preview.'
      : delivery?.status === 'partial'
        ? `Partially delivered: ${delivery.acceptedCount || 0} accepted, ${delivery.rejectedCount || 0} rejected.`
        : 'Message sent');
  };

  const draftSaved = (draft, senderAccount, localOnly) => {
    const id = String(draft?.id || `preview-${Date.now()}`);
    const replacesExisting = threads.some((item) => item.draftId === id || item.id === `draft:${id}`);
    const accountId = String(draft?.accountId || senderAccount?.id || '');
    const timestamp = draft?.updatedAt || new Date().toISOString();
    const draftThread = normalizeThread({
      id: `draft:${id}`,
      draftId: id,
      threadId: draft?.threadId || `draft:${id}`,
      accountId,
      folder: 'drafts',
      subject: draft?.subject || '(no subject)',
      snippet: String(draft?.textBody || '').replace(/\s+/g, ' ').slice(0, 170),
      from: senderAccount,
      to: draft?.to || [],
      cc: draft?.cc || [],
      bcc: draft?.bcc || [],
      timestamp,
      updatedAt: timestamp,
      attachments: draft?.attachments || [],
      messages: [{
        id: `draft-message:${id}`,
        accountId,
        from: senderAccount,
        to: draft?.to || [],
        cc: draft?.cc || [],
        bcc: draft?.bcc || [],
        textBody: draft?.textBody || '',
        htmlBody: draft?.htmlBody || '',
        attachments: draft?.attachments || [],
        timestamp,
      }],
    });
    if (localOnly) demoDraftsRef.current = [draftThread, ...demoDraftsRef.current.filter((item) => item.draftId !== id)];
    setThreads((current) => [draftThread, ...current.filter((item) => item.draftId !== id && item.id !== `draft:${id}`)]);
    setSavedDrafts((current) => [normalizeFreshDraft({ ...draft, id, accountId, updatedAt: timestamp }), ...current.filter((item) => item.id !== id && item.draftId !== id)]);
    if (!replacesExisting) {
      setFolderCounts((current) => ({ ...current, drafts: current.drafts + 1 }));
      if (!localOnly && activeFolder === 'drafts') setMailTotal((current) => current + 1);
    }
    setNotice(localOnly ? 'Draft saved in this preview.' : 'Draft saved.');
  };

  const draftRemoved = (draftId) => {
    const id = String(draftId);
    const existed = threads.some((item) => item.draftId === id || item.id === `draft:${id}`)
      || demoDraftsRef.current.some((item) => item.draftId === id || item.id === `draft:${id}`)
      || savedDrafts.some((item) => item.id === id || item.draftId === id);
    demoDraftsRef.current = demoDraftsRef.current.filter((item) => item.draftId !== id && item.id !== `draft:${id}`);
    setThreads((current) => current.filter((item) => item.draftId !== id && item.id !== `draft:${id}`));
    setSavedDrafts((current) => current.filter((item) => item.id !== id && item.draftId !== id));
    if (existed) {
      setFolderCounts((current) => ({ ...current, drafts: Math.max(0, current.drafts - 1) }));
      if (!isDemo && activeFolder === 'drafts') setMailTotal((current) => Math.max(0, current - 1));
    }
    setSelectedThread((current) => current?.draftId === id || current?.id === `draft:${id}` ? null : current);
    if (composeContext?.draftId === id) closeCompose();
  };

  const dismissFreshDraft = (draft) => {
    const id = String(draft?.id || draft?.draftId || '');
    if (!id) return;
    const next = { ...dismissedFreshDrafts, [id]: new Date().toISOString() };
    setDismissedFreshDrafts(next);
    writeDismissedFreshDrafts(next);
  };

  const deleteFreshDraft = async (draft) => {
    const id = String(draft?.draftId || draft?.id || '');
    if (!id) return;
    if (!isDemo) {
      try {
        await api(`/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch (requestError) {
        setNotice(requestError.status === 401 || requestError.status === 403
          ? 'Unlock aMail before deleting this draft.'
          : `The draft could not be deleted. ${requestError.message || 'Try again when the server is available.'}`);
        return;
      }
    }
    draftRemoved(id);
    setNotice('Draft deleted.');
  };

  const lockSession = async () => {
    persistAccessToken('');
    setProfileOpen(false);
    setSettingsOpen(false);
    setComposeOpen(false);
    setComposeContext(null);
    setAddAccountOpen(false);
    try {
      await api('/session', { method: 'DELETE' });
    } catch {
      // Still drop local state if the cookie-clear request fails.
    }
    setAccessToken('');
    setAuthenticated(false);
    setAuthRequired(true);
    setAccessOpen(true);
    setAccounts([]);
    setThreads([]);
    setSelectedThread(null);
    setSelectedIds([]);
    setMailTotal(0);
    setCategoryCounts(countSmartCategories([]));
    setFolderCounts({ ...EMPTY_FOLDER_COUNTS });
    setSavedDrafts([]);
    setIsDemo(false);
    setOffline(false);
    setNotice('Signed out of this browser session.');
  };

  const unlockServer = async (token) => {
    // In keyslot mode a passphrase or recovery code also unlocks, but only a
    // real bearer token is worth keeping for the Authorization header; the
    // session cookie carries the rest.
    const keepAsBearer = keyMode !== 'keyslot' || /^amk1_/.test(token);
    persistAccessToken(keepAsBearer ? token : '');
    setAccessToken(keepAsBearer ? token : '');
    if (!token) {
      setAuthRequired(false);
      setAccessOpen(false);
      return;
    }
    const session = await api('/session', { method: 'POST', body: JSON.stringify({ accessToken: token }) });
    if (session?.protected && !session.authenticated) throw new Error('That token did not unlock this server.');
    setAuthRequired(false);
    setAuthenticated(true);
    setAccessOpen(false);
    setSessionStamp((value) => value + 1);
    setNotice(passkeyCount ? 'aMail unlocked for this browser session.' : 'Unlocked. Add a passkey in Settings for one-tap sign-in.');
  };

  const loginWithPasskey = async () => {
    await authenticateWithPasskey();
    persistAccessToken('');
    setAccessToken('');
    setAuthRequired(false);
    setAuthenticated(true);
    setAccessOpen(false);
    setSessionStamp((value) => value + 1);
    setNotice('Unlocked with passkey.');
  };

  const addPasskey = async () => {
    const result = await registerPasskey(`Passkey ${new Date().toLocaleDateString()}`);
    const created = result?.passkey;
    if (created) {
      setPasskeys((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setPasskeyCount((count) => count + 1);
    }
    setNotice('Passkey added. You can use it to unlock this inbox.');
    return result;
  };

  const deletePasskey = async (id) => {
    await api(`/session/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setPasskeys((current) => current.filter((item) => item.id !== id));
    setPasskeyCount((count) => Math.max(0, count - 1));
    setNotice('Passkey removed.');
  };

  const saveAccountSignature = async (accountId, signature) => {
    if (isDemo) {
      const previous = demoIdentities.find((item) => item.id === accountId);
      if (!previous) return;
      const next = { ...previous, signature };
      setDemoIdentities((current) => current.map((item) => item.id === accountId ? next : item));
      setActiveAccount((current) => current?.id === accountId ? next : current);
      setNotice('Signature saved in this preview.');
      return;
    }
    const previous = accounts.find((item) => item.id === accountId);
    if (!previous) return;
    const optimistic = { ...previous, signature };
    setAccounts((current) => current.map((item) => item.id === accountId ? optimistic : item));
    setActiveAccount((current) => current?.id === accountId ? optimistic : current);
    try {
      const result = await api(`/accounts/${encodeURIComponent(accountId)}`, { method: 'PATCH', body: JSON.stringify({ signature }) });
      const saved = normalizeAccount(result?.account || result || optimistic);
      setAccounts((current) => current.map((item) => item.id === accountId ? saved : item));
      setActiveAccount((current) => current?.id === accountId ? saved : current);
      setNotice('Signature saved.');
    } catch {
      setAccounts((current) => current.map((item) => item.id === accountId ? previous : item));
      setActiveAccount((current) => current?.id === accountId ? previous : current);
      setNotice('Could not save the signature.');
    }
  };

  const accountAdded = (account) => {
    setOffline(false);
    setAccounts((current) => [...current.filter((item) => item.id !== account.id), account]);
    setActiveAccount(null);
    setIsDemo(false);
    setNotice(`${account.email} connected. Syncing mail…`);
    void (async () => {
      try {
        const response = await api(`/accounts/${encodeURIComponent(account.id)}/sync`, { method: 'POST', body: JSON.stringify({ mailbox: 'INBOX' }) });
        const status = syncResultStatus(response);
        if (status === 'failed') setNotice(`${account.email} is connected, but initial sync failed.`);
        else if (status === 'partial') setNotice(`${account.email} is connected. Some folders could not sync yet.`);
        else if (status === 'skipped') setNotice(`${account.email} is connected. Sync is disabled for this account.`);
        else setNotice(`${account.email} synced.`);
      } catch {
        setNotice(`${account.email} is connected. Initial sync could not complete yet.`);
      } finally {
        await loadMailbox({ keepSelection: false });
      }
    })();
  };

  const hasConnectedAccounts = accounts.length > 0;
  const displayAccount = activeAccount || (hasConnectedAccounts ? UNIFIED_ACCOUNT : isDemo ? demoIdentities[0] : UNIFIED_ACCOUNT);
  const identityAccounts = hasConnectedAccounts ? accounts : isDemo ? demoIdentities : [];
  const composeAccount = activeAccount || identityAccounts[0] || null;
  const composeContacts = useMemo(
    () => collectKnownPeople(identityAccounts, threads, isDemo ? demoMailboxThreads : []),
    [identityAccounts, threads, isDemo],
  );

  const densityClass = density === 'Comfortable' ? 'density-comfortable-ui' : density === 'Compact' ? 'density-compact-ui' : '';

  return (
    <div className={`mail-app ${sidebarCompact ? 'sidebar-compact' : ''} ${selectedThread ? 'thread-open' : ''} ${densityClass}`.trim()}>
      <Topbar
        onToggleSidebar={() => (window.innerWidth <= 840 ? setMobileSidebarOpen((value) => !value) : toggleSidebarCompact())}
        onGoHome={goHome}
        query={query}
        setQuery={setQuery}
        onOpenSettings={() => setSettingsOpen(true)}
        onLogout={lockSession}
        onOpenProfile={() => setProfileOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        searchRef={searchRef}
        account={displayAccount}
        isDemo={isDemo}
      />
      <Sidebar
        compact={sidebarCompact}
        mobileOpen={mobileSidebarOpen}
        onCloseMobile={() => setMobileSidebarOpen(false)}
        activeFolder={activeFolder}
        setActiveFolder={setActiveFolder}
        counts={counts}
        onCompose={() => { openNewCompose(); setMobileSidebarOpen(false); }}
        accounts={accounts}
        activeAccount={activeAccount}
        setActiveAccount={setActiveAccount}
        onSelectUnified={() => setActiveAccount(null)}
        onOpenSettings={() => setSettingsOpen(true)}
        onAddAccount={() => setAddAccountOpen(true)}
        activePersonFlag={activePersonFlag}
        onSelectPersonFlag={selectPersonFlag}
        personFlags={effectivePersonFlags}
        onManageFlags={() => setSettingsOpen(true)}
        agentQueueActive={agentQueueActive}
        onSelectAgentQueue={selectAgentQueue}
        onSyncAccount={(account) => { void syncMailbox(account); }}
        isDemo={isDemo}
      />
      <main className="mail-workspace">
        {offline ? <div className="demo-banner offline-banner" role="status"><Icon name="eyeOff" size={16} /><span>Offline — showing the last mailbox loaded from this server.</span><button type="button" onClick={() => loadMailbox({ keepSelection: true })}>Retry</button></div> : isDemo && <div className="demo-banner"><Icon name="shield" size={16} /><span>Preview mailbox — connect your first account to replace this sample data.</span><button type="button" onClick={() => setOnboardingOpen(true)}>Get started</button></div>}
        {activePersonFlag && !offline && (
          <div className="demo-banner flag-banner" role="status">
            <Icon name="person" size={16} />
            <span>
              Flagged: {activeFlag?.label || activePersonFlag}
              {' · '}
              {(activeFlag?.emails || []).join(', ')}
            </span>
            <button type="button" onClick={() => setActivePersonFlag(null)}>Clear flag</button>
          </div>
        )}
        <div className="mail-split">
          <MailList
            threads={visibleThreads}
            totalCount={visibleTotal}
            categoryCounts={categoryCounts}
            selectedThread={selectedThread}
            cursorThreadId={cursorThread?.id}
            loading={loading}
            folder={activeFolder}
            query={query}
            activeCategory={activeCategory}
            setActiveCategory={(category) => { setActiveCategory(category); setActivePersonFlag(null); setSelectedIds([]); }}
            selectedIds={selectedIds}
            setSelectedIds={setSelectedIds}
            onOpenThread={openThread}
            onToggleStar={toggleStar}
            onRefresh={refreshMailbox}
            onBulkAction={applyAction}
            onCompose={openNewCompose}
            onClearSearch={() => setQuery('')}
            hideSmartFilters={Boolean(activePersonFlag)}
            freshDrafts={freshDrafts}
            onOpenFreshDraft={(draft) => { void openSavedDraft(draft, { expanded: true }); }}
            onDismissFreshDraft={dismissFreshDraft}
            onDeleteFreshDraft={(draft) => { void deleteFreshDraft(draft); }}
            onViewAllDrafts={() => { setActiveFolder('drafts'); setActiveCategory('all'); setActivePersonFlag(null); setQuery(''); setSelectedThread(null); setSelectedIds([]); }}
            onReply={(thread) => openReplyComposer(thread, thread.messages?.at(-1) || thread)}
            onForward={(thread) => openForwardComposer(thread, thread.messages?.at(-1) || thread)}
            onNotice={setNotice}
          />
          {selectedThread ? <ThreadView key={selectedThread.id} thread={selectedThread} activeFolder={activeFolder} onBack={() => setSelectedThread(null)} onAction={applyAction} onLoadRemote={loadRemoteContent} onReply={openReplyComposer} onReplyAll={(thread, message) => openReplyComposer(thread, message, { replyAll: true })} onForward={openForwardComposer} onToggleStar={toggleStar} onNotice={setNotice} allowPrivateImages={privacy.privateImages} /> : null}
        </div>
      </main>
      {composeOpen && <ComposeModal key={composeContext?.draftId || composeContext?.mode || 'compose'} account={composeAccount} accounts={identityAccounts} contacts={composeContacts} isDemo={isDemo} initialReply={composeContext} onClose={closeCompose} onSent={sendMessage} onDraftSaved={draftSaved} onDraftRemoved={draftRemoved} />}
      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        accounts={identityAccounts}
        activeAccount={activeAccount}
        setActiveAccount={setActiveAccount}
        privacy={privacy}
        setPrivacy={setPrivacy}
        density={density}
        setDensity={updateDensity}
        onAddAccount={() => setAddAccountOpen(true)}
        onUnlock={() => setAccessOpen(true)}
        onSaveSignature={saveAccountSignature}
        showUnified={hasConnectedAccounts}
        passkeys={passkeys}
        passkeysSupported={canUsePasskeys}
        onAddPasskey={addPasskey}
        onDeletePasskey={deletePasskey}
        personFlags={personFlags}
        onSavePersonFlags={savePersonFlags}
        opsSources={opsSources}
        serverInfo={serverInfo}
        onOpenOnboarding={() => { setSettingsOpen(false); setOnboardingOpen(true); }}
        isDemo={isDemo}
      />
      <ProfileMenu open={profileOpen} onClose={() => setProfileOpen(false)} account={displayAccount} accounts={identityAccounts} setActiveAccount={setActiveAccount} onSelectUnified={() => setActiveAccount(null)} onOpenSettings={() => setSettingsOpen(true)} onLogout={lockSession} showUnified={hasConnectedAccounts} />
      {addAccountOpen && <AddAccountModal onClose={() => setAddAccountOpen(false)} onAdded={accountAdded} />}
      {onboardingOpen && authenticated && !authRequired && (
        <OnboardingWizard
          accounts={accounts}
          serverInfo={serverInfo}
          onAccountAdded={accountAdded}
          onFinish={dismissOnboarding}
          onSkip={dismissOnboarding}
        />
      )}
      <AccessPanel
        open={accessOpen}
        required={authRequired}
        currentToken={accessToken}
        onSave={unlockServer}
        onClose={() => setAccessOpen(false)}
        passkeyCount={passkeyCount}
        canUsePasskeys={canUsePasskeys}
        onPasskeyLogin={loginWithPasskey}
        authenticated={authenticated}
        onRegisterPasskey={authenticated ? addPasskey : undefined}
        keyMode={keyMode}
      />
      <ShortcutCheatsheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <Toast notice={notice} onClose={() => setNotice('')} />
    </div>
  );
}
