// Crypto worker: the AES-GCM key is derived and kept only inside this
// worker (non-extractable), so the main thread never touches key material.

let key = null;

const te = new TextEncoder();
const td = new TextDecoder();

function b64encode(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(s) {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

self.onmessage = async (e) => {
  const { id, cmd } = e.data;
  try {
    if (cmd === 'derive') {
      const base = await crypto.subtle.importKey(
        'raw', te.encode(e.data.password), 'PBKDF2', false, ['deriveKey']);
      key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: b64decode(e.data.salt), iterations: 250000, hash: 'SHA-256' },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']);
      self.postMessage({ id, ok: true });
    } else if (cmd === 'encrypt') {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(e.data.plain));
      self.postMessage({ id, ok: true, iv: b64encode(iv), data: b64encode(ct) });
    } else if (cmd === 'decrypt') {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64decode(e.data.iv) }, key, b64decode(e.data.data));
      self.postMessage({ id, ok: true, plain: td.decode(pt) });
    } else if (cmd === 'genSalt') {
      self.postMessage({ id, ok: true, salt: b64encode(crypto.getRandomValues(new Uint8Array(16))) });
    } else {
      throw new Error('unknown cmd: ' + cmd);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
