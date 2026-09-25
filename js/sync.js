// Sync layer: BroadcastChannel for live replication + IndexedDB as the
// shared, durable op log. Handles out-of-order / lost messages with a
// per-source reorder buffer and gap-repair requests, and handles tab
// close via bye + heartbeat liveness.

import { appendOp, getOpsBySrc } from './store.js';

const CHANNEL = 'gsb-kanban-v1';
const GAP_TIMEOUT = 150;   // ms to wait for late messages before requesting repair
const HEARTBEAT = 3000;
const PEER_TTL = 9000;

export class Sync {
  // callbacks: onOp(op, src), onCryptoError(src), onPeers(n)
  constructor(nodeId, db, cryptoClient, callbacks) {
    this.nodeId = nodeId;
    this.db = db;
    this.crypto = cryptoClient;
    this.cb = callbacks;
    this.seq = 0;
    this.expected = new Map();  // src -> next expected seq
    this.buffer = new Map();    // src -> Map(seq -> msg)
    this.gapTimers = new Map(); // src -> timeout id
    this.peers = new Map();     // src -> last seen ts
    this.channel = new BroadcastChannel(CHANNEL);
    this.channel.onmessage = (e) => this._onMessage(e.data);
    this._hb = setInterval(() => this._heartbeat(), HEARTBEAT);
    window.addEventListener('beforeunload', () => {
      this.channel.postMessage({ t: 'bye', src: this.nodeId });
    });
  }

  start(vector) {
    // vector: { src: maxSeq } rebuilt from the local op log
    for (const src of Object.keys(vector)) this.expected.set(src, vector[src] + 1);
    this.seq = vector[this.nodeId] || 0;
    this.channel.postMessage({ t: 'hello', src: this.nodeId, vector });
    this._heartbeat();
  }

  // Persist then broadcast a local op. BroadcastChannel delivers to other
  // tabs within a few ms, well under the 200ms budget.
  async send(op) {
    const blob = await this.crypto.encryptObj(op);
    const seq = ++this.seq;
    await appendOp(this.db, this.nodeId, seq, blob);
    this.channel.postMessage({ t: 'op', src: this.nodeId, seq, blob });
  }

  async _onMessage(msg) {
    if (!msg || msg.src === this.nodeId) return;
    this._touchPeer(msg.src);
    switch (msg.t) {
      case 'hello':
        this._sendMissing(msg.src, msg.vector || {});
        break;
      case 'bye':
        this.peers.delete(msg.src);
        this._emitPeers();
        break;
      case 'ping':
        break;
      case 'op':
        this._onOp(msg);
        break;
      case 'need':
        this._resend(msg);
        break;
      case 'ops':
        for (const item of msg.items) {
          await this._onOp({ t: 'op', src: msg.src, seq: item.seq, blob: item.blob });
        }
        break;
    }
  }

  _touchPeer(src) {
    this.peers.set(src, Date.now());
    this._emitPeers();
  }

  _emitPeers() {
    const now = Date.now();
    let n = 1; // self
    for (const [src, ts] of this.peers) {
      if (now - ts < PEER_TTL) n++;
      else this.peers.delete(src);
    }
    if (this.cb.onPeers) this.cb.onPeers(n);
  }

  _heartbeat() {
    this.channel.postMessage({ t: 'ping', src: this.nodeId });
    this._emitPeers();
  }

  async _onOp(msg) {
    const { src, seq } = msg;
    const expected = this.expected.get(src) || 1;
    if (seq < expected) return; // duplicate
    if (seq > expected) {
      // Out of order (or lost): buffer and schedule a gap-repair request.
      if (!this.buffer.has(src)) this.buffer.set(src, new Map());
      this.buffer.get(src).set(seq, msg);
      if (!this.gapTimers.has(src)) {
        this.gapTimers.set(src, setTimeout(() => {
          this.gapTimers.delete(src);
          const want = this.expected.get(src) || 1;
          this.channel.postMessage({ t: 'need', src: this.nodeId, from: want, to: seq - 1, about: src });
        }, GAP_TIMEOUT));
      }
      return;
    }
    await this._deliver(msg);
    // Drain anything that was buffered ahead of order.
    const buf = this.buffer.get(src);
    if (buf) {
      let next = this.expected.get(src);
      while (buf.has(next)) {
        const m = buf.get(next);
        buf.delete(next);
        await this._deliver(m);
        next = this.expected.get(src);
      }
      if (buf.size === 0) this.buffer.delete(src);
    }
  }

  async _deliver(msg) {
    this.expected.set(msg.src, msg.seq + 1);
    await appendOp(this.db, msg.src, msg.seq, msg.blob); // idempotent (put by key)
    try {
      const op = await this.crypto.decryptObj(msg.blob);
      this.cb.onOp(op, msg.src);
    } catch (err) {
      // AES-GCM auth failure => the peer encrypted with a different key.
      if (this.cb.onCryptoError) this.cb.onCryptoError(msg.src);
    }
  }

  async _resend(msg) {
    // Another tab is missing our ops (or a third tab's ops we have stored).
    const rows = await getOpsBySrc(this.db, msg.about, msg.from, msg.to);
    if (!rows.length) return;
    this.channel.postMessage({
      t: 'ops',
      src: msg.about,
      items: rows.map((r) => ({ seq: r.seq, blob: { iv: r.iv, data: r.data } })),
    });
  }

  async _sendMissing(toSrc, theirVector) {
    // Anti-entropy: push every op the newcomer lacks, per source.
    for (const src of this.expected.keys()) {
      const have = (this.expected.get(src) || 1) - 1;
      const theirs = theirVector[src] || 0;
      if (have > theirs) {
        const rows = await getOpsBySrc(this.db, src, theirs + 1);
        if (rows.length) {
          this.channel.postMessage({
            t: 'ops',
            src,
            items: rows.map((r) => ({ seq: r.seq, blob: { iv: r.iv, data: r.data } })),
          });
        }
      }
    }
  }
}
