import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/**
 * DEK handoff between an old and a new aMail process during a deploy.
 *
 * Restarting a hosted container would otherwise leave the tenant locked until
 * they present a credential again. Instead, the running (unlocked) process
 * listens on a Unix socket inside the data volume, and a freshly started
 * process asks it for the DEK before falling back to "locked". The DEK crosses
 * the socket once, in memory, and is never written anywhere.
 *
 * Both sides must hold AMAIL_HANDOFF_SECRET (the same container environment):
 * the listener sends a nonce, the requester answers with an HMAC of it, and
 * only then is the DEK released. Without the secret the feature is off, so an
 * unrelated process with access to the volume cannot ask for keys. Self-hosted
 * installs never set these variables and the code path is inert.
 *
 * Protocol (newline-delimited, one exchange per connection):
 *   server -> client  "amail-handoff/1 <nonce-hex>"
 *   client -> server  "<hmac-sha256(secret, nonce)-hex>"
 *   server -> client  "dek <dek-hex>"   or   "denied"
 */

const PROTOCOL = 'amail-handoff/1';
const DEFAULT_TIMEOUT_MS = 3_000;

function hmac(secret, nonce) {
  return crypto.createHmac('sha256', Buffer.from(String(secret), 'utf8')).update(nonce, 'hex').digest('hex');
}

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readLine(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => finish(new Error('handoff timeout')), timeoutMs);
    function finish(error, value) {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (error) reject(error);
      else resolve(value);
    }
    function onData(chunk) {
      buffer += chunk.toString('utf8');
      if (buffer.length > 4096) return finish(new Error('handoff message too long'));
      const index = buffer.indexOf('\n');
      if (index >= 0) finish(null, buffer.slice(0, index));
    }
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error('handoff connection closed'));
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

/**
 * Node unlinks a Unix socket *by path name* when its server closes, so if two
 * processes ever shared one path the old process would delete the new one's
 * socket on exit. Each process therefore listens on its own file and the
 * configured path is a symlink that is atomically repointed at the newest
 * listener. Requesters simply connect through the symlink.
 */
function ownSocketPath(socketPath) {
  return `${socketPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
}

function removeStale(socketPath) {
  try {
    const target = fs.readlinkSync(socketPath);
    try {
      fs.unlinkSync(path.resolve(path.dirname(socketPath), target));
    } catch {
      // ignore
    }
  } catch {
    // not a symlink (or already gone)
  }
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // ignore
  }
}

/**
 * Ask a running process for the DEK. Resolves to a Buffer, or null when nobody
 * is listening, the secret does not match, or the exchange fails. A stale
 * socket left by a crashed process is removed.
 */
export async function requestHandoff({ socketPath, secret, timeoutMs = DEFAULT_TIMEOUT_MS, logger }) {
  if (!socketPath || !secret) return null;
  if (!fs.existsSync(socketPath)) {
    removeStale(socketPath);
    return null;
  }
  const socket = net.createConnection(socketPath);
  socket.setNoDelay?.(true);
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const hello = await readLine(socket, timeoutMs);
    const [protocol, nonce] = hello.split(' ');
    if (protocol !== PROTOCOL || !/^[0-9a-f]{64}$/.test(nonce || '')) throw new Error('unexpected handoff greeting');
    socket.write(`${hmac(secret, nonce)}\n`);
    const answer = await readLine(socket, timeoutMs);
    const [verb, dekHex] = answer.split(' ');
    if (verb !== 'dek' || !/^[0-9a-f]{64}$/.test(dekHex || '')) {
      logger?.warn?.({ answer: verb }, 'DEK handoff refused by the running process');
      return null;
    }
    return Buffer.from(dekHex, 'hex');
  } catch (error) {
    if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT') {
      // Nobody is listening: the link and its target are leftovers.
      removeStale(socketPath);
      return null;
    }
    logger?.warn?.({ err: error }, 'DEK handoff attempt failed');
    return null;
  } finally {
    socket.destroy();
  }
}

/**
 * Serve the DEK to a peer that proves it holds the shared secret. Start it once
 * the harness is unlocked, stop it on lock or shutdown.
 */
export function createHandoffServer({ socketPath, secret, getDek, logger, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  let server = null;
  const listenPath = socketPath ? ownSocketPath(socketPath) : null;

  async function handleConnection(socket) {
    socket.setNoDelay?.(true);
    try {
      const nonce = crypto.randomBytes(32).toString('hex');
      socket.write(`${PROTOCOL} ${nonce}\n`);
      const proof = await readLine(socket, timeoutMs);
      if (!safeEqualHex(proof, hmac(secret, nonce))) {
        logger?.warn?.('DEK handoff request rejected: bad proof');
        socket.end('denied\n');
        return;
      }
      const dek = getDek();
      if (!dek) {
        socket.end('denied\n');
        return;
      }
      socket.end(`dek ${Buffer.from(dek).toString('hex')}\n`);
      logger?.info?.('DEK handed off to a new process');
    } catch (error) {
      logger?.warn?.({ err: error }, 'DEK handoff connection failed');
      socket.destroy();
    }
  }

  return {
    socketPath,
    listening: () => Boolean(server),
    async start() {
      if (server || !socketPath || !secret) return false;
      fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      try {
        fs.unlinkSync(listenPath);
      } catch {
        // ignore
      }
      server = net.createServer(handleConnection);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(listenPath, resolve);
      });
      fs.chmodSync(listenPath, 0o600);
      // Repoint the well-known path at this process atomically. Taking it over
      // is intentional: after a handoff the successor is who future deploys ask.
      const temporary = `${listenPath}.link`;
      try {
        fs.unlinkSync(temporary);
      } catch {
        // ignore
      }
      fs.symlinkSync(path.basename(listenPath), temporary);
      fs.renameSync(temporary, socketPath);
      return true;
    },
    async stop() {
      if (!server) return;
      const closing = server;
      server = null;
      // Closing unlinks our own socket file. The shared symlink is removed only
      // if it still points at us; a successor may have taken it over.
      await new Promise((resolve) => closing.close(() => resolve()));
      try {
        if (fs.readlinkSync(socketPath) === path.basename(listenPath)) fs.unlinkSync(socketPath);
      } catch {
        // ignore
      }
    },
  };
}
