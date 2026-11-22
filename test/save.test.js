import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveText, openEarlier, SaveError } from '../app/save.js';
import { readEncryptedDoc } from '../app/docmodel.js';
import { GoogleError } from '../app/gdocs.js';
import { newKey, rekey, newDecoy, seal, open, unlock, START, END } from '../app/cipher.js';
import { tamper } from '../dev/tamper.mjs';

const key = await newKey('test password');

// A fake Docs API holding one tab as plain text (index i = character i,
// index 0 the section break). It applies batchUpdate like Google does and
// enforces requiredRevisionId.
function fakeGoogle(initialText) {
  let text = '\u0000' + initialText; // placeholder for the section break at index 0
  let rev = 1;
  const calls = { get: 0, update: 0 };
  const hooks = { beforeUpdate: null, afterUpdate: null, beforeGet: null };
  const asDoc = () => {
    const content = [{ endIndex: 1, sectionBreak: {} }];
    let i = 1;
    for (const line of text.slice(1).split(/(?<=\n)/)) {
      if (!line) continue;
      content.push({ startIndex: i, endIndex: i + line.length, paragraph: { elements: [{ startIndex: i, endIndex: i + line.length, textRun: { content: line } }] } });
      i += line.length;
    }
    return { documentId: 'doc1', title: 'Test', revisionId: `r${rev}`, tabs: [{ tabProperties: { tabId: 't.0', title: 'Tab 1' }, documentTab: { body: { content } }, childTabs: [] }] };
  };
  const api = {
    calls, hooks,
    get text() { return text.slice(1); },
    editElsewhere(fn) { text = '\u0000' + fn(text.slice(1)); rev++; },
    async getDocument() {
      calls.get++;
      if (hooks.beforeGet) await hooks.beforeGet();
      return JSON.parse(JSON.stringify(asDoc()));
    },
    async batchUpdate(docId, body) {
      calls.update++;
      if (hooks.beforeUpdate) await hooks.beforeUpdate(body);
      if (body.writeControl.requiredRevisionId !== `r${rev}`) {
        throw new GoogleError('conflict', 'Google refused the request (The required revision ID does not match).', 400);
      }
      for (const r of body.requests) {
        if (r.deleteContentRange) {
          const { startIndex, endIndex } = r.deleteContentRange.range;
          assert.ok(endIndex < text.length, 'must not delete the final newline');
          text = text.slice(0, startIndex) + text.slice(endIndex);
        } else if (r.insertText) {
          const at = r.insertText.location.index;
          text = text.slice(0, at) + r.insertText.text + text.slice(at);
        }
      }
      rev++;
      if (hooks.afterUpdate) await hooks.afterUpdate();
      return { documentId: docId, replies: [{}, {}], writeControl: { requiredRevisionId: `r${rev}` } };
    },
  };
  return api;
}

function fakeStore() {
  const backups = [];
  return { backups, async addBackup(b) { backups.push(b); } };
}

const docWith = async (plain, k = key) => `My notes\n\n${await seal(plain, k)}\n\nFooter text\n`;

async function openSession(g) {
  return { docId: 'doc1', tabId: null, key, info: readEncryptedDoc(await g.getDocument('doc1'), null) };
}

async function docPlain(g) {
  return (await open(readEncryptedDoc(await g.getDocument('doc1'), null).block.armoured, key)).text;
}

test('a normal save replaces only the block and verifies it', async () => {
  const g = fakeGoogle(await docWith('old text'));
  const st = fakeStore();
  const session = await openSession(g);
  const oldArmour = session.info.block.armoured;
  const r = await saveText({ session, text: 'new text ✓ 😀', google: g, store: st });
  assert.equal(await docPlain(g), 'new text ✓ 😀');
  assert.ok(g.text.startsWith('My notes\n\n' + START));
  assert.ok(g.text.endsWith(END + '\n\nFooter text\n'));
  assert.equal(st.backups.length, 2, 'the doc as it was, and as it was saved');
  assert.equal(st.backups[0].armoured, oldArmour);
  assert.equal(st.backups[1].armoured, r.info.block.armoured);
  assert.equal(r.info.revisionId, 'r2');
  assert.equal(r.retried, false);
  assert.equal(g.calls.update, 1);
});

test('saving twice in a row uses the new revision', async () => {
  const g = fakeGoogle(await docWith('v1'));
  const session = await openSession(g);
  session.info = (await saveText({ session, text: 'v2', google: g, store: fakeStore() })).info;
  session.info = (await saveText({ session, text: 'v3', google: g, store: fakeStore() })).info;
  assert.equal(await docPlain(g), 'v3');
});

test('long texts and empty text save correctly', async () => {
  const g = fakeGoogle(await docWith('short'));
  const session = await openSession(g);
  const long = 'This is just a test. '.repeat(1000);
  session.info = (await saveText({ session, text: long, google: g, store: fakeStore() })).info;
  assert.equal(await docPlain(g), long);
  await saveText({ session, text: '', google: g, store: fakeStore() });
  assert.equal(await docPlain(g), '');
});

test('an edit elsewhere in the doc is not a conflict: retried on the new revision', async () => {
  const g = fakeGoogle(await docWith('mine'));
  const session = await openSession(g);
  g.editElsewhere((t) => t.replace('My notes', 'My notes, edited on the phone'));
  const r = await saveText({ session, text: 'mine, edited', google: g, store: fakeStore() });
  assert.equal(r.retried, true);
  assert.equal(await docPlain(g), 'mine, edited');
  assert.ok(g.text.startsWith('My notes, edited on the phone'));
});

test('a change to the encrypted block itself is a conflict and nothing is written', async () => {
  const g = fakeGoogle(await docWith('original'));
  const session = await openSession(g);
  const theirs = await docWith('changed on another device');
  g.editElsewhere(() => theirs);
  await assert.rejects(saveText({ session, text: 'my edit', google: g, store: fakeStore() }),
    (e) => e instanceof SaveError && e.code === 'conflict' && e.theirsText === 'changed on another device');
  assert.equal(g.text, theirs, 'their version untouched');
});

test('a conflict with a different password still refuses, and says so', async () => {
  const g = fakeGoogle(await docWith('original'));
  const session = await openSession(g);
  const other = await docWith('other', await newKey('new password'));
  g.editElsewhere(() => other);
  await assert.rejects(saveText({ session, text: 'mine', google: g, store: fakeStore() }),
    (e) => e.code === 'conflict' && e.theirsText === null && !!e.theirsError);
});

test('resolving a conflict by saving on their revision works and backs theirs up', async () => {
  const g = fakeGoogle(await docWith('original'));
  const st = fakeStore();
  const session = await openSession(g);
  const theirs = await docWith('theirs');
  g.editElsewhere(() => theirs);
  let conflict;
  try { await saveText({ session, text: 'mine', google: g, store: st }); } catch (e) { conflict = e; }
  session.info = conflict.theirs;
  await saveText({ session, text: 'mine', google: g, store: st });
  assert.equal(await docPlain(g), 'mine');
  assert.equal((await open(st.backups.at(-2).armoured, key)).text, 'theirs');
  assert.equal((await open(st.backups.at(-1).armoured, key)).text, 'mine');
});

test('a lost response after a successful write still counts as saved', async () => {
  const g = fakeGoogle(await docWith('before'));
  const session = await openSession(g);
  g.hooks.afterUpdate = async () => { g.hooks.afterUpdate = null; throw new GoogleError('network', 'Could not reach Google.'); };
  await saveText({ session, text: 'after', google: g, store: fakeStore() });
  assert.equal(await docPlain(g), 'after');
  assert.equal(g.calls.update, 1, 'not written twice');
});

test('a write that never reached Google is reported as not saved', async () => {
  const g = fakeGoogle(await docWith('before'));
  const session = await openSession(g);
  g.hooks.beforeUpdate = async () => { throw new GoogleError('network', 'Could not reach Google.'); };
  await assert.rejects(saveText({ session, text: 'after', google: g, store: fakeStore() }), (e) => e.code === 'not-saved');
  assert.equal(await docPlain(g), 'before');
});

test('an expired sign-in stops the save before anything is written', async () => {
  const g = fakeGoogle(await docWith('before'));
  const session = await openSession(g);
  g.hooks.beforeUpdate = async () => { throw new GoogleError('auth', 'The Google sign-in expired.', 401); };
  await assert.rejects(saveText({ session, text: 'after', google: g, store: fakeStore() }), (e) => e.code === 'auth');
  assert.equal(await docPlain(g), 'before');
});

test('if the doc does not read back as saved, the save fails loudly', async () => {
  const g = fakeGoogle(await docWith('before'));
  const session = await openSession(g);
  // damaged ciphertext after the write: one character changed in each slot
  const flip = (c) => (c === 'A' ? 'B' : 'A');
  g.hooks.afterUpdate = async () => { g.editElsewhere((t) => t.replace(/(v3\.[^\n]+\n)(.)/, (m, h, c) => h + flip(c)).replace(/(.)(.{10}\n#####  End)/, (m, c, rest) => flip(c) + rest)); };
  await assert.rejects(saveText({ session, text: 'after', google: g, store: fakeStore() }), (e) => e.code === 'verify-mismatch');
});

test('a failing local backup does not block the save but is reported', async () => {
  const g = fakeGoogle(await docWith('before'));
  const session = await openSession(g);
  const r = await saveText({ session, text: 'after', google: g, store: { addBackup: async () => { throw new Error('quota'); } } });
  assert.equal(r.backupFailed, true);
  assert.equal(await docPlain(g), 'after');
});

// ---------------------------------------------------------------- decoy

test('decoy: a save keeps the decoy beside the text, and every save rewrites the whole block', async () => {
  const g = fakeGoogle(await docWith('before'));
  const session = await openSession(g);
  const decoy = await newDecoy('My first bike, was red!', 'fake key', key);
  const r = await saveText({ session, text: 'after', decoy, google: g, store: fakeStore() });
  assert.deepEqual(await open(r.info.block.armoured, key), { text: 'after', decoy });
  assert.equal((await unlock(r.info.block.armoured, 'My first bike, was red!')).result.text, 'fake key');
  const again = await saveText({ session: { ...session, info: r.info }, text: 'after', decoy, google: g, store: fakeStore() }); // nothing changed: An unlock's save
  const lines = (b) => b.split('\n').slice(2, -1);
  const [one, two] = [lines(r.info.block.armoured), lines(again.info.block.armoured)];
  assert.equal(one.length, two.length);
  assert.ok(one.every((l, i) => l !== two[i]), 'no line of either slot is the same');
  assert.equal(r.info.block.armoured.length, session.info.block.armoured.length, 'with or without a decoy, the same length');
});

test('decoy: unlocking with it leaves only the decoy; the older version still has the text', async () => {
  const decoy = await newDecoy('My first bike, was red!', 'fake key', key);
  const g = fakeGoogle(`My notes\n\n${await seal({ text: 'the real text', decoy }, key)}\n\nFooter text\n`);
  const before = g.text;
  const info = readEncryptedDoc(await g.getDocument('doc1'), null);
  const d = await unlock(info.block.armoured, 'My first bike, was red!');
  await saveText({ session: { docId: 'doc1', key: d.k, info }, text: d.result.text, decoy: d.result.decoy, google: g, store: fakeStore() });
  assert.equal((await open(readEncryptedDoc(await g.getDocument('doc1'), null).block.armoured, d.k)).text, 'fake key');
  await assert.rejects(docPlain(g), (e) => e.code === 'password', 'the real password opens nothing now');
  g.editElsewhere(() => before); // Google Docs: Version history → Restore this version
  assert.equal(await docPlain(g), 'the real text');
});

test('decoy: a conflict shows their text and keeps their decoy', async () => {
  const g = fakeGoogle(await docWith('before'));
  const session = await openSession(g);
  const decoy = await newDecoy('My first bike, was red!', 'fake key', key);
  const theirs = await seal({ text: 'theirs', decoy }, key);
  g.editElsewhere((t) => t.replace(session.info.block.armoured, theirs));
  await assert.rejects(saveText({ session, text: 'mine', google: g, store: fakeStore() }),
    (e) => e.code === 'conflict' && e.theirsText === 'theirs' && e.theirsDecoy.text === 'fake key');
});

test('decoy: a doc whose decoy was changed with another tool is never written over', async () => {
  const decoy = await newDecoy('My first bike, was red!', 'fake key', key);
  const g = fakeGoogle(await docWith({ text: 'before', decoy }));
  const session = await openSession(g);
  const trap = await tamper(session.info.block.armoured, decoy.password, 'fake key, one letter changed');
  assert.equal((await unlock(trap, decoy.password)).result.text, 'fake key, one letter changed');
  assert.deepEqual(await open(trap, key), { text: 'before', decoy, tampered: true });
  g.editElsewhere((t) => t.replace(session.info.block.armoured, trap));
  const text = g.text, st = fakeStore();
  // the real text and the decoy's copy are as this session last saw them: Without the check, a silent retry
  await assert.rejects(saveText({ session, text: 'after', decoy, base: { text: 'before', decoy }, google: g, store: st }), (e) => e instanceof SaveError && e.code === 'tampered');
  await assert.rejects(saveText({ session, text: 'before', decoy, base: { text: 'before', decoy }, google: g, store: st }), (e) => e.code === 'tampered');
  assert.equal(g.text, text, 'left as they made it');
  // changed right after a save's write, before its check: The save says so, and its doc is no base for the next one
  const g2 = fakeGoogle(await docWith({ text: 'before', decoy })), s2 = await openSession(g2);
  g2.hooks.afterUpdate = async () => {
    g2.hooks.afterUpdate = null;
    const now = readEncryptedDoc(await g2.getDocument('doc1'), null).block.armoured, changed = await tamper(now, decoy.password, 'fake key, changed');
    g2.editElsewhere((t) => t.replace(now, changed));
  };
  await assert.rejects(saveText({ session: s2, text: 'after', decoy, google: g2, store: st }), (e) => e.code === 'tampered');
  assert.equal(g2.calls.update, 1);
});

test('a text too long for one doc is refused before anything is written', async () => {
  const g = fakeGoogle(await docWith('before'));
  const session = await openSession(g);
  const noise = Array.from({ length: 60000 }, () => Math.random().toString(36).slice(2, 10)).join(' ');
  await assert.rejects(saveText({ session, text: noise, google: g, store: fakeStore() }), (e) => e.code === 'too-long');
  assert.equal(g.calls.update, 0);
  assert.equal(await docPlain(g), 'before');
});

test('an unlock elsewhere (the same content, encrypted again) is no conflict', async () => {
  const g = fakeGoogle(await docWith('before'));
  const session = await openSession(g);
  g.editElsewhere((t) => t.replace(session.info.block.armoured, '@@')); // placeholder, filled below
  const again = await seal('before', key);
  g.editElsewhere((t) => t.replace('@@', again));
  const r = await saveText({ session, text: 'after', base: { text: 'before', decoy: null }, google: g, store: fakeStore() });
  assert.equal(r.retried, true);
  assert.equal(await docPlain(g), 'after');
  // without knowing what was last read, or when their text really differs, it stays a conflict
  const g2 = fakeGoogle(await docWith('before')), s2 = await openSession(g2);
  const changed = await seal('changed elsewhere', key);
  g2.editElsewhere((t) => t.replace(s2.info.block.armoured, changed));
  await assert.rejects(saveText({ session: s2, text: 'after', base: { text: 'before', decoy: null }, google: g2, store: fakeStore() }), (e) => e.code === 'conflict');
});

test('an unlock elsewhere is a conflict when the decoy differs, and when the doc never stops changing', async () => {
  const decoy = await newDecoy('My first bike, was red!', 'fake key', key);
  const g = fakeGoogle(await docWith('before')), session = await openSession(g);
  const withDecoy = await seal({ text: 'before', decoy }, key);
  g.editElsewhere((t) => t.replace(session.info.block.armoured, withDecoy));
  await assert.rejects(saveText({ session, text: 'after', base: { text: 'before', decoy: null }, google: g, store: fakeStore() }),
    (e) => e.code === 'conflict' && e.theirsDecoy.text === 'fake key');
  // encrypted again before every one of our writes: Given up after three tries, nothing overwritten
  const g2 = fakeGoogle(await docWith('before')), s2 = await openSession(g2);
  g2.hooks.beforeUpdate = async () => { const now = readEncryptedDoc(await g2.getDocument('doc1'), null).block.armoured, again = await seal('before', key); g2.editElsewhere((t) => t.replace(now, again)); };
  await assert.rejects(saveText({ session: s2, text: 'after', base: { text: 'before', decoy: null }, google: g2, store: fakeStore() }), (e) => e.code === 'conflict');
  assert.equal(g2.calls.update, 3);
  assert.equal(await docPlain(g2), 'before');
});

test('openEarlier: the newest kept version that the key opens', async () => {
  const other = await newKey('another password');
  const backups = [
    { at: 1, armoured: await seal('oldest', key) },
    { at: 2, armoured: await seal('newer', key) },
    { at: 3, armoured: await seal('not mine', other) }, // another salt
    { at: 4, armoured: 'damaged' },
  ];
  const found = await openEarlier(backups, key);
  assert.equal(found.backup.at, 2);
  assert.deepEqual(found.result, { text: 'newer', decoy: null });
  assert.equal(await openEarlier(backups.slice(2), key), null);
  assert.equal(await openEarlier([], key), null);
  // after a decoy unlock: The decoy's key opens the newest, the real key the one before
  const decoy = await newDecoy('My first bike, was red!', 'fake key', key), real = await seal({ text: 'real', decoy }, key);
  const d = await unlock(real, 'My first bike, was red!'), kept = [{ at: 1, armoured: real }, { at: 2, armoured: await seal(d.result, d.k) }];
  assert.equal((await openEarlier(kept, key)).result.text, 'real');
  assert.equal((await openEarlier(kept, d.k)).backup.at, 2);
  // a version someone changed with another tool is not the one to bring back: The one before has the same text
  const trap = { at: 3, armoured: await tamper(real, decoy.password, 'fake key, changed') };
  assert.equal((await openEarlier([{ at: 1, armoured: real }, trap], key)).backup.at, 1);
  assert.equal(await openEarlier([trap], key), null);
});

test('a password change on a doc changed elsewhere still shows their version (readKey)', async () => {
  const next = await rekey('a new password', key);
  // an unlock elsewhere, under the old password: No conflict, the doc ends up under the new one
  const g = fakeGoogle(await docWith('before')), session = await openSession(g);
  const again = await seal('before', key);
  g.editElsewhere((t) => t.replace(session.info.block.armoured, again));
  const r = await saveText({ session: { ...session, key: next }, text: 'before', base: { text: 'before', decoy: null }, readKey: key, google: g, store: fakeStore() });
  assert.equal((await open(r.info.block.armoured, next)).text, 'before');
  // a newer text elsewhere: A conflict that shows it, nothing overwritten
  const g2 = fakeGoogle(await docWith('before')), s2 = await openSession(g2);
  const newer = await seal('newer, from the phone', key);
  g2.editElsewhere((t) => t.replace(s2.info.block.armoured, newer));
  await assert.rejects(saveText({ session: { ...s2, key: next }, text: 'before', base: { text: 'before', decoy: null }, readKey: key, google: g2, store: fakeStore() }),
    (e) => e.code === 'conflict' && e.theirsText === 'newer, from the phone');
  assert.equal(await docPlain(g2), 'newer, from the phone');
});
