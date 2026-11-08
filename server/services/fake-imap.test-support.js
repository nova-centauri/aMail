// In-memory IMAP server for draft tests. Implements only the ImapFlow calls
// the draft paths use: list, mailboxCreate, append, getMailboxLock, search,
// fetch, fetchOne, messageDelete and status. Not loaded by production code.

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
  condstore = false,
  uidValidity = 7,
  failConnect = null,
  failAppend = null,
} = {}) {
  // Tests flip these at runtime: a thrown Error makes the next calls fail.
  const failures = { move: null, flags: null, search: null };
  const state = {
    folders: folders.map((folder) => ({ ...folder })),
    mailboxes: new Map(),
    created: [],
    appends: [],
    deletes: [],
    fetches: [],
    connects: 0,
    modseq: 1,
    uidplus,
    uidValidity,
    failures,
    moves: [],
    copies: [],
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
    state.modseq += 1;
    return uid;
  };
  // Put a message at a chosen UID, as Gmail does when it renumbers a draft.
  state.seedAt = (path, uid, raw, flags = []) => {
    const mailbox = box(path);
    mailbox.messages.set(uid, { raw: Buffer.from(raw), flags: new Set(flags), messageId: headerValue(raw, 'Message-ID') });
    mailbox.nextUid = Math.max(mailbox.nextUid, uid + 1);
    state.modseq += 1;
    return uid;
  };
  // Another client moves or deletes a message: the UID just disappears here.
  state.expunge = (path, uid) => {
    const removed = box(path).messages.get(Number(uid));
    box(path).messages.delete(Number(uid));
    state.modseq += 1;
    return removed || null;
  };
  state.place = (path, message) => {
    const target = box(path);
    const uid = target.nextUid;
    target.nextUid += 1;
    target.messages.set(uid, message);
    state.modseq += 1;
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
      this.mailbox = {
        path,
        uidValidity: BigInt(state.uidValidity),
        uidNext: mailbox.nextUid,
        exists: mailbox.messages.size,
        ...(condstore ? { highestModseq: BigInt(state.modseq) } : {}),
      };
      return { path, release: () => {} };
    }

    async search(query) {
      if (state.failures.search) throw state.failures.search;
      // A provider glitch: SEARCH ALL answers empty though the mailbox has mail.
      if (state.lieAboutSearch && query?.all) return [];
      const mailbox = box(this.mailbox.path);
      const matches = (message, part) => {
        if (part?.all) return true;
        if (Array.isArray(part?.or)) return part.or.some((item) => matches(message, item));
        const wanted = part?.header?.['message-id'];
        return wanted ? message.messageId === wanted : false;
      };
      return [...mailbox.messages.entries()]
        .filter(([, message]) => matches(message, query))
        .map(([uid]) => uid);
    }

    async messageFlagsAdd(range, flags) {
      if (state.failures.flags) throw state.failures.flags;
      const message = box(this.mailbox.path).messages.get(Number(range));
      if (!message) return false;
      for (const flag of flags) message.flags.add(flag);
      state.modseq += 1;
      return true;
    }

    async messageFlagsRemove(range, flags) {
      if (state.failures.flags) throw state.failures.flags;
      const message = box(this.mailbox.path).messages.get(Number(range));
      if (!message) return false;
      for (const flag of flags) message.flags.delete(flag);
      state.modseq += 1;
      return true;
    }

    // UID MOVE / COPY with UIDPLUS-style uidMap, like ImapFlow returns.
    async messageMove(range, destination) {
      if (state.failures.move) throw state.failures.move;
      const source = box(this.mailbox.path);
      const uid = Number(range);
      const message = source.messages.get(uid);
      if (!message) return false;
      source.messages.delete(uid);
      const target = box(destination);
      const newUid = target.nextUid;
      target.nextUid += 1;
      target.messages.set(newUid, message);
      state.modseq += 1;
      state.moves.push({ from: this.mailbox.path, uid, destination, newUid });
      return { path: this.mailbox.path, destination, uidMap: new Map([[uid, newUid]]) };
    }

    async messageCopy(range, destination) {
      if (state.failures.move) throw state.failures.move;
      const uid = Number(range);
      const message = box(this.mailbox.path).messages.get(uid);
      if (!message) return false;
      const target = box(destination);
      const newUid = target.nextUid;
      target.nextUid += 1;
      target.messages.set(newUid, { ...message, flags: new Set(message.flags) });
      state.modseq += 1;
      state.copies.push({ from: this.mailbox.path, uid, destination, newUid });
      return { path: this.mailbox.path, destination, uidMap: new Map([[uid, newUid]]) };
    }

    async* fetch(range, query = {}) {
      const mailbox = box(this.mailbox.path);
      state.fetches.push({ path: this.mailbox.path, range: String(range), source: Boolean(query.source) });
      const max = mailbox.nextUid - 1;
      const wanted = new Set();
      for (const part of String(range).split(',')) {
        const [from, to = from] = part.split(':');
        const low = Number(from);
        const high = to === '*' ? max : Number(to);
        for (let uid = low; uid <= high; uid += 1) wanted.add(uid);
      }
      for (const uid of [...wanted].sort((a, b) => a - b)) {
        const message = mailbox.messages.get(uid);
        if (!message) continue;
        yield {
          uid,
          size: message.raw.length,
          flags: message.flags,
          labels: new Set(),
          internalDate: new Date('2026-10-29T15:27:13.000Z'),
          envelope: { messageId: message.messageId, subject: headerValue(message.raw, 'Subject') },
          ...(query.source ? { source: message.raw } : {}),
        };
      }
    }

    async fetchOne(uid) {
      const message = box(this.mailbox.path).messages.get(Number(uid));
      if (!message) return false;
      return { uid: Number(uid), envelope: { messageId: message.messageId }, source: message.raw, flags: message.flags };
    }

    async messageDelete(uid) {
      const mailbox = box(this.mailbox.path);
      const existed = mailbox.messages.delete(Number(uid));
      if (existed) {
        state.deletes.push({ path: this.mailbox.path, uid: Number(uid) });
        state.modseq += 1;
      }
      return existed;
    }

    async status(path) {
      const mailbox = box(path);
      return {
        path,
        uidNext: mailbox.nextUid,
        uidValidity: BigInt(state.uidValidity),
        messages: mailbox.messages.size,
        ...(condstore ? { highestModseq: BigInt(state.modseq) } : {}),
      };
    }
  }

  return { state, FakeImapClient };
}
