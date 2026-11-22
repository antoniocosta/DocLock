// The save pipeline. Nothing here touches the DOM; Google and the local
// store are passed in so the tests can drive it with fakes.
//
//  1. Encrypt, then decrypt in memory and compare: Never write something
//     that does not decrypt back to the editor text.
//  2. Back up the doc's current ciphertext locally.
//  3. One atomic batchUpdate (delete block + insert block) pinned to the
//     revision that was read. If Google refuses or the answer is lost,
//     re-read: Our block already there = saved; block unchanged but newer
//     revision = the edit was elsewhere in the doc, retry; block changed =
//     conflict, nothing is written, unless it holds the same content only
//     encrypted again (an unlock elsewhere): Retry on it. A block whose
//     decoy was changed with another tool (cipher.js) is never written over.
//  4. Re-read the doc and decrypt it. Only a match counts as saved, and
//     only when its decoy is as it was written.
//  5. Back up what was saved too, so the newest local backup is always
//     this browser's last save.

import { seal, open, sameDecoy } from './cipher.js';
import { readEncryptedDoc, replaceBlockRequest } from './docmodel.js';

export class SaveError extends Error {
  /**
   * @param {'verify-before'|'conflict'|'tampered'|'not-saved'|'verify-after'|'verify-mismatch'} code
   *   verify-after: Written, but the doc could not be read back; verify-mismatch: Read back, and it is not what was saved.
   *   saveText also rejects with a CipherError ('too-long') or a GoogleError ('auth') before anything is written.
   * @param {object} [extra] for 'conflict': theirs (info), theirsText (string|null), theirsDecoy, theirsError
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'SaveError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const MAX_ATTEMPTS = 3;

/**
 * @param {object} p
 * @param {{docId: string, key: object, info: object}} p.session
 *   key: from cipher.js; info: what readEncryptedDoc returned when the doc was last read.
 * @param {string} p.text editor text to save
 * @param {object|null} [p.decoy] the doc's decoy (cipher.js), saved beside the text
 * @param {object} [p.readKey] the key the doc is under now, when the session's is a new one being saved (a password change)
 * @param {{text: string, decoy: object|null}} [p.base] what this session last read or saved: A doc that still
 *   holds exactly that, only encrypted again (an unlock elsewhere), is no conflict
 * @param {{getDocument: Function, batchUpdate: Function}} p.google
 * @param {{addBackup: Function}} p.store
 * @param {(step: string) => void} [p.onStep]
 * @returns {Promise<{info: object, backupFailed: boolean, retried: boolean}>}
 */
export async function saveText({ session, text, decoy = null, base = null, readKey = session.key, google, store, onStep = () => {} }) {
  const { docId, key } = session;
  let info = session.info;

  onStep('Encrypting…');
  const armoured = await seal({ text, decoy }, key); // too long for one doc: Throws here, nothing written
  const matches = async (block) => { // decrypts back to exactly what is being saved
    try { const o = await open(block, key); return o.text === text && sameDecoy(o.decoy, decoy); } catch { return false; }
  };
  if (!(await matches(armoured))) {
    throw new SaveError('verify-before', 'Encryption check failed. Nothing was saved; your text is still here.');
  }

  let backupFailed = false;
  try {
    await store.addBackup({ docId, tabId: info.tabId, armoured: info.block.armoured, revisionId: info.revisionId, title: info.title });
  } catch {
    backupFailed = true; // Google's version history still has the old text
  }

  const reread = async () => readEncryptedDoc(await google.getDocument(docId), info.tabId);

  let retried = false;
  for (let attempt = 1; ; attempt++) {
    onStep(attempt === 1 ? 'Saving…' : 'Saving again…');
    let writeError = null;
    try {
      await google.batchUpdate(docId, replaceBlockRequest(info, armoured));
    } catch (e) {
      writeError = e;
    }
    if (!writeError) break;
    if (writeError.code === 'auth') throw writeError; // nothing written; caller signs in again

    let now;
    try { now = await reread(); } catch { throw writeError; }
    if (now.block.armoured === armoured) break; // the write did land
    if (now.block.armoured !== info.block.armoured) {
      let theirsText = null, theirsDecoy = null, theirsError = null, tampered = false;
      try { ({ text: theirsText, decoy: theirsDecoy, tampered } = await open(now.block.armoured, readKey)); } catch (e) { theirsError = e; }
      if (tampered) throw new SaveError('tampered', 'Not saved: This doc was changed with another tool.');
      if (base && !theirsError && attempt < MAX_ATTEMPTS && theirsText === base.text && sameDecoy(theirsDecoy, base.decoy)) {
        info = now; // the same content, freshly encrypted by an unlock elsewhere
        retried = true;
        continue;
      }
      throw new SaveError('conflict', 'This doc was changed elsewhere. Nothing was overwritten.',
        { theirs: now, theirsText, theirsDecoy, theirsError });
    }
    if (now.revisionId === info.revisionId || attempt >= MAX_ATTEMPTS) {
      throw new SaveError('not-saved', `Not saved: ${writeError.message} Your text is still here.`, { cause: writeError });
    }
    info = now; // edited elsewhere in the doc; our block is intact
    retried = true;
  }

  onStep('Checking…');
  let after;
  try {
    after = await reread();
  } catch (e) {
    throw new SaveError('verify-after', `Probably saved, but couldn't check it (${e.message}). Reload to see.`, { cause: e });
  }
  if ((await open(after.block.armoured, key).catch(() => null))?.tampered) { // changed with another tool since the write: Not a base for the next save
    throw new SaveError('tampered', 'This doc was changed with another tool.');
  }
  if (!(await matches(after.block.armoured))) {
    throw new SaveError('verify-mismatch', 'The saved doc doesn’t match. Your text is still here, and the old version is backed up.', { after });
  }
  try {
    await store.addBackup({ docId, tabId: info.tabId, armoured: after.block.armoured, revisionId: after.revisionId, title: after.title });
  } catch { /* the doc itself holds it */ }
  return { info: after, backupFailed, retried };
}

/**
 * The newest kept ciphertext (store.getBackups: oldest first) that this key opens, with its content;
 * null when there is none. For a password that opens nothing in the doc as it is now.
 * A version whose decoy was changed with another tool is passed over, for the newest one before it.
 */
export async function openEarlier(backups, key) {
  for (const b of [...backups].reverse()) {
    const result = await open(b.armoured, key).catch(() => null); // another key, or damaged
    if (result && !result.tampered) return { backup: b, result };
  }
  return null;
}
