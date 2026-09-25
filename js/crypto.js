// Main-thread RPC client for the crypto worker.

export class CryptoClient {
  constructor() {
    this.worker = new Worker('js/crypto-worker.js');
    this.seq = 0;
    this.pending = new Map();
    this.worker.onmessage = (e) => {
      const { id, ok, error, ...rest } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (ok) p.resolve(rest);
      else p.reject(new Error(error || 'crypto error'));
    };
  }

  _call(cmd, payload) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, cmd, ...payload });
    });
  }

  genSalt() {
    return this._call('genSalt', {}).then((r) => r.salt);
  }

  derive(password, salt) {
    return this._call('derive', { password, salt });
  }

  encryptObj(obj) {
    return this._call('encrypt', { plain: JSON.stringify(obj) })
      .then((r) => ({ iv: r.iv, data: r.data }));
  }

  decryptObj(blob) {
    return this._call('decrypt', { iv: blob.iv, data: blob.data })
      .then((r) => JSON.parse(r.plain));
  }
}
