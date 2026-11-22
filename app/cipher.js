// The encryption, all with the browser's Web Crypto.
//
// Key = PBKDF2-SHA-256(NFC password, random 16-byte salt, 600,000
// iterations) → AES-256-GCM. The block in the doc:
//
//   #####  DocLock encrypted text (AES-256-GCM, PBKDF2-SHA-256): https://github.com/antoniocosta/DocLock
//   v3.<iterations>.<salt base64>
//   <two slots of 32,768 bytes each, base64, 64 per line>
//   #####  End encrypted text
//
// A slot is a random 12-byte IV, then the ciphertext and its 16-byte tag,
// with the v3 line authenticated as additional data. Inside: A 4-byte
// length, the text as deflated JSON ({"t": text}), and zeros up to the
// slot's size, so every doc is the same length whatever it holds.
//
// One slot holds the text. The other holds a decoy (another text, under
// another password) or, in most docs, random bytes: The two look the same,
// so nobody can show that a doc has a decoy. Each save puts the slots in a
// random order with fresh IVs. A text that has a decoy carries it along
// ({"t", "d": {"p": its password, "k": its key, "t": its text}}); a decoy
// knows nothing of the text beside it. DocLock writes the two together, so
// a decoy slot that is not exactly its copy was changed with another tool:
// open() says so (tampered), and the app then writes nothing.
// docs/decoy.md explains the design.
//
// A key is { key: CryptoKey (not extractable), salt, iterations }. The salt
// stays with the doc (a save reuses it), so the doc's password is never
// kept. A decoy is different: Its password and key travel inside the real
// text, so they are in the page while that text is open.
//
// Docs from before the decoy (v2: One ciphertext, the IV on the v2 line)
// are still read; the first unlock rewrites them as v3.

export const START = '#####  DocLock encrypted text (AES-256-GCM, PBKDF2-SHA-256): https://github.com/antoniocosta/DocLock';
export const END = '#####  End encrypted text';
const ITERATIONS = 600000;
export const SLOT = 32768;
const ROOM = SLOT - 12 - 16 - 4; // deflated bytes that fit in a slot

export class CipherError extends Error {
  /** @param {'password'|'format'|'other-key'|'too-long'} code */
  constructor(code, message) {
    super(message);
    this.name = 'CipherError';
    this.code = code;
  }
}

const subtle = globalThis.crypto.subtle, utf8 = new TextEncoder();
const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const through = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
const aes = (raw) => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

const pbkdf2 = (password, usage) => subtle.importKey('raw', utf8.encode(password.normalize('NFC')), 'PBKDF2', false, [usage]);
async function derive(password, salt, iterations) {
  const key = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, await pbkdf2(password, 'deriveKey'), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { key, salt, iterations };
}

/** A key with a fresh salt, for a new doc. */
export const newKey = (password) => derive(password, random(16), ITERATIONS);
/** Another password for the same doc: The salt stays. */
export const rekey = (password, k) => derive(password, k.salt, k.iterations);
/** A decoy for the doc that k opens: { password, text, raw } (raw: Its key, base64). */
export async function newDecoy(password, text, k) {
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: k.salt, iterations: k.iterations }, await pbkdf2(password, 'deriveBits'), 256);
  return { password, text, raw: b64(new Uint8Array(bits)) };
}
/** True when the decoy's password is the doc's own. */
export async function sameKey(decoy, k) {
  const iv = random(12), data = await subtle.encrypt({ name: 'AES-GCM', iv }, k.key, random(1));
  return subtle.decrypt({ name: 'AES-GCM', iv }, await aes(unb64(decoy.raw)), data).then(() => true, () => false);
}

const HEADER = /^v([23])\.(\d{1,8})\.([A-Za-z0-9+/=]{1,64})(?:\.([A-Za-z0-9+/=]{1,64}))?$/;
/** The block's parts. It comes from a doc others may edit: Read line by line, in time that grows with its length only. */
function parse(block) {
  const damaged = () => new CipherError('format', 'The encrypted text looks damaged.');
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean), m = (lines[1] || '').match(HEADER);
  if (lines.length < 3 || !lines[0].startsWith('#####  ') || lines.at(-1) !== END || !m) throw new CipherError('format', 'The encrypted text is damaged or cut off.');
  const version = Number(m[1]), iterations = Number(m[2]), body = lines.slice(2, -1).join('');
  if (iterations !== ITERATIONS || (version === 2) !== (m[4] != null) || /[^A-Za-z0-9+/=]/.test(body)) throw damaged(); // the one count DocLock has ever written
  let p;
  try { p = { version, header: m[0], iterations, salt: unb64(m[3]), iv: m[4] && unb64(m[4]), data: unb64(body) }; } catch { throw damaged(); } // bad base64
  if (p.salt.length !== 16 || (version === 2 ? p.iv.length !== 12 : p.data.length !== 2 * SLOT)) throw damaged();
  return p;
}

/** { text, decoy } → the padded bytes a slot encrypts. */
async function pack({ text, decoy }) {
  const json = JSON.stringify(decoy ? { t: text, d: { p: decoy.password, k: decoy.raw, t: decoy.text } } : { t: text });
  const packed = await through(utf8.encode(json), new CompressionStream('deflate-raw'));
  if (packed.length > ROOM) throw new CipherError('too-long', 'This text is too long for one doc. Shorten it, or move part of it to another doc.');
  const out = new Uint8Array(ROOM + 4);
  new DataView(out.buffer).setUint32(0, packed.length);
  out.set(packed, 4);
  return out;
}
async function unpack(bytes) {
  const damaged = new CipherError('format', 'The encrypted text looks damaged.');
  const length = bytes.length === ROOM + 4 ? new DataView(bytes.buffer, bytes.byteOffset).getUint32(0) : Infinity;
  if (length > ROOM) throw damaged;
  let o;
  try { o = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await through(bytes.subarray(4, 4 + length), new DecompressionStream('deflate-raw')))); } catch { throw damaged; }
  const strings = (...v) => v.every((x) => typeof x === 'string');
  if (!strings(o?.t) || (o.d != null && !strings(o.d.p, o.d.t, o.d.k))) throw damaged;
  return { text: o.t, decoy: o.d ? { password: o.d.p, text: o.d.t, raw: o.d.k } : null };
}

async function slot(content, key, header) {
  const iv = random(12);
  const data = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(header) }, key, await pack(content)));
  const out = new Uint8Array(SLOT);
  out.set(iv);
  out.set(data, 12);
  return out;
}
const unslot = (bytes, key, header) => subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: utf8.encode(header) }, key, bytes.subarray(12))
  .then((plain) => new Uint8Array(plain), () => null);

/** How full the doc is with this content: 1 = full. */
export const fill = async (content) => (await pack(content).then((p) => new DataView(p.buffer).getUint32(0), (e) => { if (e.code === 'too-long') return ROOM + 1; throw e; })) / ROOM;

/**
 * Encrypts { text, decoy } (or just a text) into a block for the doc (no
 * trailing newline). Without a decoy the other slot is random bytes.
 */
export async function seal(content, k) {
  if (typeof content === 'string') content = { text: content, decoy: null };
  const header = `v3.${k.iterations}.${b64(k.salt)}`;
  const mine = await slot(content, k.key, header);
  const other = content.decoy ? await slot({ text: content.decoy.text, decoy: null }, await aes(unb64(content.decoy.raw)), header) : random(SLOT);
  const both = new Uint8Array(2 * SLOT);
  const first = random(1)[0] & 1; // the order says nothing
  both.set(first ? mine : other);
  both.set(first ? other : mine, SLOT);
  return `${START}\n${header}\n${b64(both).match(/.{1,64}/g).join('\n')}\n${END}`;
}

/** Decrypts a block with a key. @returns {Promise<{text: string, decoy: object|null, tampered?: true}>} tampered: The decoy's slot is not what a save wrote */
export async function open(block, k) {
  const p = parse(block);
  if (!same(p.salt, k.salt)) throw new CipherError('other-key', 'This doc was re-encrypted elsewhere. Lock and unlock it again.');
  const wrong = () => new CipherError('password', 'Wrong password, or the doc is damaged.');
  if (p.version === 2) {
    const plain = await unslot(new Uint8Array([...p.iv, ...p.data]), k.key, p.header);
    if (!plain) throw wrong();
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(plain), decoy: null };
  }
  // Both slots are always tried, so the time taken says nothing either.
  const [a, b] = await Promise.all([unslot(p.data.subarray(0, SLOT), k.key, p.header), unslot(p.data.subarray(SLOT), k.key, p.header)]);
  if (!a && !b) throw wrong();
  const content = await unpack(a || b);
  if (content.decoy) { // every save writes the decoy's slot from the copy kept with the text: Its text, alone
    const its = await (async () => unpack(await unslot(a ? p.data.subarray(SLOT) : p.data.subarray(0, SLOT), await aes(unb64(content.decoy.raw)), p.header)))().catch(() => null);
    if (its?.text !== content.decoy.text || its.decoy) content.tampered = true; // not DocLock's work: A save would undo it, and show the second password
  }
  return content;
}

/** The key this password gives for this block, whether or not it opens it. */
export function keyFor(block, password) {
  const p = parse(block);
  return derive(password, p.salt, p.iterations);
}
/** Password → key for this block, and its content. Throws on a wrong password. */
export async function unlock(block, password) {
  const k = await keyFor(block, password);
  return { k, result: await open(block, k) };
}
/** True when two decoys (or none) are the same. */
export const sameDecoy = (a, b) => a?.password === b?.password && a?.text === b?.text && a?.raw === b?.raw;
