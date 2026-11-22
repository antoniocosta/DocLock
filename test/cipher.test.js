import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newKey, rekey, keyFor, newDecoy, sameKey, sameDecoy, seal, open, unlock, fill, CipherError, START, END, SLOT } from '../app/cipher.js';
import { findBlock } from '../app/docmodel.js';

const k = await newKey('correct horse');
const decoy = await newDecoy('My first bike, was red!', 'fake key 5Kb8kLf9', k);
const body = (block) => Uint8Array.from(atob(block.split('\n').slice(2, -1).join('')), (c) => c.charCodeAt(0));
const slots = (block) => [body(block).subarray(0, SLOT), body(block).subarray(SLOT)].map((s) => Buffer.from(s).toString('hex'));

test('round trip, also unicode, empty and long text', async () => {
  for (const t of ['', 'hello', 'ação ✓ 😀\nline 2', 'lone \ud800 surrogate', 'x'.repeat(200000)]) assert.deepEqual(await open(await seal(t, k), k), { text: t, decoy: null });
});

test('block format, and unlock with the password from the block alone', async () => {
  const b = await seal('secret', k);
  assert.ok(b.startsWith(START + '\nv3.600000.') && b.endsWith('\n' + END));
  const block = findBlock(`intro\n${b}\noutro\n`);
  assert.equal(block.armoured, b);
  assert.equal((await unlock(block.armoured, 'correct horse')).result.text, 'secret');
  await assert.rejects(unlock(block.armoured, 'wrong'), (e) => e instanceof CipherError && e.code === 'password');
});

test('a flip in the text’s slot is refused, one in the random slot is harmless; any change to the v3 line is refused', async () => {
  const b = await seal('secret', k), lines = b.split('\n');
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  const first = [...lines], last = [...lines];
  first[2] = flip(first[2], 3);
  last[lines.length - 3] = flip(last[lines.length - 3], 3);
  const results = await Promise.all([first, last].map((l) => open(l.join('\n'), k).then(() => 'opened', (e) => e.code)));
  assert.deepEqual(results.sort(), ['opened', 'password'], 'a flip in the text’s slot is refused; one in the random slot changes nothing');
  const other = crypto.getRandomValues(new Uint8Array(16)), h = [...lines];
  h[1] = `v3.600000.${Buffer.from(other).toString('base64')}`; // another salt on the v3 line: The same key no longer opens it
  await assert.rejects(open(h.join('\n'), { ...k, salt: other }), (e) => e.code === 'password');
  for (const bad of [b.replace('v3.', 'v4.'), b.replace('v3.600000.', 'v3.9000000.'), b.replace('v3.600000.', 'v3.1.'), lines.slice(0, -2).concat(END).join('\n'), b.replace(/(v3\.\d+)\.[^\n]+/, '$1.AAAA')]) {
    await assert.rejects(open(bad, k), (e) => e.code === 'format');
  }
});

test('a key with a different salt is refused clearly', async () => {
  const other = await newKey('correct horse');
  await assert.rejects(open(await seal('x', other), k), (e) => e.code === 'other-key');
});

test('a text too long for one doc is refused, and fill() says how full', async () => {
  const noise = Array.from({ length: 60000 }, () => Math.random().toString(36).slice(2, 10)).join(' ');
  await assert.rejects(seal(noise, k), (e) => e.code === 'too-long');
  assert.ok(await fill({ text: noise }) > 1);
  const few = await fill({ text: 'hello' });
  assert.ok(few > 0 && few < 0.01);
  assert.ok(await fill({ text: 'hello', decoy }) > few, 'a decoy takes its share');
  await assert.rejects(seal({ text: 'short', decoy: { ...decoy, text: noise } }, k), (e) => e.code === 'too-long', 'a decoy text too long for its own slot');
});

test('a doc from before the decoy (v2) still opens', async () => {
  const v2 = '#####  DocLock encrypted text (AES-256-GCM, PBKDF2-SHA-256): https://github.com/antoniocosta/DocLock\nv2.600000.KfmnoVWvvd3GxIk0H7HXNg==.m/kHp/kFsZbXydjJ\nmlSE5gwoFj2zab7OER/0vLwxbVTDx2I3MXxmOBzV7MstJBHRlnI0fIVLZeA=\n#####  End encrypted text';
  const { k: old, result } = await unlock(findBlock(v2).armoured, 'old password');
  assert.deepEqual(result, { text: 'written before the decoy ✓', decoy: null });
  await assert.rejects(unlock(findBlock(v2).armoured, 'nope'), (e) => e.code === 'password');
  assert.equal((await open(await seal(result, old), old)).text, result.text, 'and is rewritten as v3 with the same key');
});

test('decoy: each password opens its own text', async () => {
  const b = await seal({ text: 'the real text', decoy }, k);
  assert.deepEqual(await open(b, k), { text: 'the real text', decoy });
  const d = await unlock(findBlock(b).armoured, 'My first bike, was red!');
  assert.deepEqual(d.result, { text: 'fake key 5Kb8kLf9', decoy: null }, 'the decoy knows nothing of the real text');
  await assert.rejects(unlock(findBlock(b).armoured, 'neither'), (e) => e.code === 'password');
});

test('decoy: a slot that is not what the save wrote is reported (tampered), and the copy kept with the text is what opens', async () => {
  const b = await seal({ text: 'the real text', decoy }, k), dk = await rekey(decoy.password, k);
  assert.equal((await open(b, k)).tampered, undefined);
  assert.equal((await open(await seal('one text', k), k)).tampered, undefined, 'no decoy, nothing to compare');
  const lines = b.split('\n'), put = (i, slot) => { const both = body(b); both.set(slot, i * SLOT); return [...lines.slice(0, 2), Buffer.from(both).toString('base64'), lines.at(-1)].join('\n'); };
  // Their slot is put where the decoy was (the other place holds the real text: There the doc no longer opens).
  const swapped = async (theirs) => {
    const results = [];
    for (const i of [0, 1]) for (const j of [0, 1]) results.push(await open(put(i, body(theirs).subarray(j * SLOT, (j + 1) * SLOT)), k).catch(() => null));
    return results.filter(Boolean);
  };
  for (const [what, theirs] of [
    ['edited', await seal('edited by someone', dk)],
    ['given a decoy of its own', await seal({ text: decoy.text, decoy: await newDecoy('a third password', 'x', k) }, dk)],
    ['under another password', await seal(decoy.text, await rekey('not the decoy password', k))],
  ]) {
    const opened = await swapped(theirs);
    assert.ok(opened.length >= 2, what);
    for (const r of opened) assert.deepEqual(r, { text: 'the real text', decoy, tampered: true }, what);
  }
  const same = (await swapped(await seal(decoy.text, dk))).filter((r) => !r.tampered);
  assert.equal(same.length, 1, 'the same text sealed again with the decoy key is what a save writes');
  assert.equal((await unlock(findBlock(b).armoured, decoy.password)).result.tampered, undefined, 'the decoy password sees an ordinary doc');
});

test('decoy: a doc with one looks like a doc without', async () => {
  const plain = await seal('short', k), withDecoy = await seal({ text: 'short', decoy }, k);
  const long = await seal({ text: Array.from({ length: 3000 }, () => Math.random().toString(36)).join(' '), decoy }, k);
  assert.equal(plain.length, withDecoy.length);
  assert.equal(plain.length, long.length, 'the length says nothing of what is inside');
  assert.equal(plain.split('\n')[1], withDecoy.split('\n')[1], 'the same v3 line');
  assert.equal(body(plain).length, 2 * SLOT);
});

test('decoy: every save changes both slots, in either order', async () => {
  for (const content of [{ text: 'same', decoy }, { text: 'same', decoy: null }]) {
    const seen = new Set(), where = new Set();
    for (let i = 0; i < 24; i++) {
      const b = await seal(content, k);
      for (const s of slots(b)) { assert.ok(!seen.has(s.slice(0, 64)), 'no slot is written twice'); seen.add(s.slice(0, 64)); }
      where.add(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: body(b).subarray(0, 12), additionalData: new TextEncoder().encode(b.split('\n')[1]) }, k.key, body(b).subarray(12, SLOT)).then(() => 'first', () => 'second'));
    }
    assert.equal(where.size, 2, 'the text is sometimes first, sometimes second');
  }
});

test('decoy: saving with the decoy password leaves only the decoy', async () => {
  const b = await seal({ text: 'the real text', decoy }, k);
  const d = await unlock(findBlock(b).armoured, 'My first bike, was red!');
  const after = await seal(d.result, d.k); // what any unlock writes back
  assert.equal(after.length, b.length);
  assert.equal((await open(after, d.k)).text, 'fake key 5Kb8kLf9');
  await assert.rejects(open(after, k), (e) => e.code === 'password', 'the real text is gone from this version');
  assert.equal((await open(b, k)).text, 'the real text', 'and still in the older one');
});

test('decoy: its password must not be the doc’s own; a changed password keeps the salt', async () => {
  assert.equal(await sameKey(decoy, k), false);
  assert.equal(await sameKey(await newDecoy('correct horse', '', k), k), true);
  const next = await rekey('a new password', k);
  assert.deepEqual([...next.salt], [...k.salt]);
  const b = await seal({ text: 'kept', decoy }, next);
  assert.equal(b.split('\n')[1], (await seal('x', k)).split('\n')[1], 'the v3 line does not show the change');
  assert.deepEqual(await open(b, next), { text: 'kept', decoy });
  assert.equal((await unlock(findBlock(b).armoured, 'My first bike, was red!')).result.text, 'fake key 5Kb8kLf9', 'the decoy still opens');
  await assert.rejects(open(b, k), (e) => e.code === 'password');
});

test('a block stuffed with blank lines is refused at once (the doc can be edited by others)', async () => {
  const [first, header, ...rest] = (await seal('x', k)).split('\n');
  const stuffed = [first, header, '\n'.repeat(200000) + '!', ...rest].join('\n'), t = Date.now();
  await assert.rejects(open(stuffed, k), (e) => e.code === 'format');
  assert.ok(Date.now() - t < 5000, `${Date.now() - t} ms`); // quadratic or worse would take minutes
  assert.equal((await open([first, '', `  ${header}  `, '', ...rest].join('\n'), k)).text, 'x', 'stray blank lines and spaces are fine');
});

test('decoy: passwords that differ only in how an accent is written are the same password', async () => {
  const composed = 'caf\u00e9 au lait', decomposed = 'cafe\u0301 au lait';
  assert.notEqual(composed, decomposed);
  const key = await newKey(composed);
  assert.equal(await sameKey(await newDecoy(decomposed, '', key), key), true);
  assert.equal(composed.normalize('NFC'), decomposed.normalize('NFC'), 'what the app compares before making a decoy');
});

test('keyFor gives the block’s key without opening it; old and new layouts are not mixed up', async () => {
  const b = await seal('x', k);
  assert.equal((await open(b, await keyFor(b, 'correct horse'))).text, 'x');
  await assert.rejects(open(b, await keyFor(b, 'wrong')), (e) => e.code === 'password');
  const lines = b.split('\n');
  await assert.rejects(open([lines[0], lines[1] + '.m/kHp/kFsZbXydjJ', ...lines.slice(2)].join('\n'), k), (e) => e.code === 'format', 'v3 with an IV on its line');
  await assert.rejects(open([lines[0], lines[1].replace('v3.', 'v2.'), ...lines.slice(2)].join('\n'), k), (e) => e.code === 'format', 'v2 without one');
  assert.ok(sameDecoy(null, null) && sameDecoy(decoy, { raw: decoy.raw, text: decoy.text, password: decoy.password }) && !sameDecoy(decoy, null) && !sameDecoy(decoy, { ...decoy, text: 'other' }));
});

test('findBlock: a second block is refused', async () => {
  const b = await seal('x', k);
  assert.equal(findBlock(b).armoured, b);
  assert.throws(() => findBlock(b + '\n' + b), /more than one/);
});
