// In-memory IMAP server for draft tests. Implements only the ImapFlow calls
// the draft paths use: list, mailboxCreate, append, getMailboxLock, search,
// fetchOne, messageDelete and status. Not loaded by production code.

function headerValue(raw, name) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  const head = text.split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[ \t]+/g, ' ');
  const match = head.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'));
  return match ? match[1].trim() : null;
}

export function createFakeImapServer({
  folders = [
    { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' },
    { path: 'Sent', name: 'Sent', specialUse: '\\Sent' },
    { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts' },
  ],
  uidplus = true,
  uidValidity = 7,
  failConnect = null,
  failAppend = null,
} = {}) {
  const state = {
    folders: folders.map((folder) => ({ ...folder })),
    mailboxes: new Map(),
    created: [],
    appends: [],
    deletes: [],
    connects: 0,
    uidplus,
    uidValidity,
  };
  const box = (path) => {
    if (!state.mailboxes.has(path)) state.mailboxes.set(path, { nextUid: 1, messages: new Map() });
    return state.mailboxes.get(path);
  };
  for (const folder of state.folders) box(folder.path);

  state.seed = (path, raw, flags = []) => {
    const mailbox = box(path);
    const uid = mailbox.nextUid;
    mailbox.nextUid += 1;
    mailbox.messages.set(uid, { raw: Buffer.from(raw), flags: new Set(flags), messageId: headerValue(raw, 'Message-ID') });
    return uid;
  };
  state.messages = (path) => [...box(path).messages.entries()].map(([uid, message]) => ({
    uid,
    flags: [...message.flags],
    messageId: message.messageId,
    raw: message.raw.toString('utf8'),
    header: (name) => headerValue(message.raw, name),
  }));

  class FakeImapClient {
    constructor(options) {
      this.options = options;
      this.mailbox = null;
      this.capabilities = new Map();
    }

    on() { return this; }

    off() { return this; }

    async connect() {
      state.connects += 1;
      if (failConnect) throw failConnect;
    }

    async logout() {}

    close() {}

    async list() {
      return state.folders.map((folder) => ({ ...folder }));
    }

    async mailboxCreate(path) {
      state.folders.push({ path, name: path, specialUse: null });
      state.created.push(path);
      box(path);
      return { path, created: true };
    }

    async append(path, raw, flags = [], date = null) {
      if (failAppend) throw failAppend;
      if (!state.folders.some((folder) => folder.path === path)) throw new Error('NO [TRYCREATE] Mailbox does not exist');
      const uid = state.seed(path, raw, flags);
      state.appends.push({ path, uid, flags: [...flags], date, raw: Buffer.from(raw).toString('utf8') });
      return state.uidplus ? { destination: path, uid, uidValidity: BigInt(state.uidValidity) } : { destination: path };
    }

    async getMailboxLock(path) {
      box(path);
      const mailbox = state.mailboxes.get(path);
      this.mailbox = { path, uidValidity: BigInt(state.uidValidity), uidNext: mailbox.nextUid, exists: mailbox.messages.size };
      return { path, release: () => {} };
    }

    async search(query) {
      const mailbox = box(this.mailbox.path);
      const wanted = query?.header?.['message-id'];
      return [...mailbox.messages.entries()]
        .filter(([, message]) => (query?.all ? true : (wanted ? message.messageId === wanted : false)))
        .map(([uid]) => uid);
    }

    async fetchOne(uid) {
      const message = box(this.mailbox.path).messages.get(Number(uid));
      if (!message) return false;
      return { uid: Number(uid), envelope: { messageId: message.messageId }, source: message.raw, flags: message.flags };
    }

    async messageDelete(uid) {
      const mailbox = box(this.mailbox.path);
      const existed = mailbox.messages.delete(Number(uid));
      if (existed) state.deletes.push({ path: this.mailbox.path, uid: Number(uid) });
      return existed;
    }

    async status(path) {
      const mailbox = box(path);
      return { path, uidNext: mailbox.nextUid, uidValidity: BigInt(state.uidValidity), messages: mailbox.messages.size };
    }
  }

  return { state, FakeImapClient };
}
