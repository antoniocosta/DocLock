// For the tests: What someone who holds the decoy password, and a tool of
// their own, can do to a doc. The slot their password opens is replaced by
// one with other content; the other slot is left byte for byte.

import { keyFor, seal, open, SLOT } from '../app/cipher.js';

/** @param {string} block the doc's block @param {string|object} content what their slot will hold (as for seal) */
export async function tamper(block, decoyPassword, content) {
  const lines = block.split('\n');
  const bytes = (b) => Uint8Array.from(atob(b.split('\n').slice(2, -1).join('')), (c) => c.charCodeAt(0));
  const build = (both) => [lines[0], lines[1], ...Buffer.from(both).toString('base64').match(/.{1,64}/g), lines.at(-1)].join('\n');
  const k = await keyFor(block, decoyPassword), theirs = await seal(content, k);
  const slotOf = async (b) => { // the slot without which the decoy password opens nothing
    for (const i of [0, 1]) {
      const both = bytes(b);
      both.fill(0, i * SLOT, (i + 1) * SLOT);
      if (!(await open(build(both), k).catch(() => null))) return i;
    }
    throw new Error('the decoy password does not open this block');
  };
  const both = bytes(block), from = await slotOf(theirs);
  both.set(bytes(theirs).subarray(from * SLOT, (from + 1) * SLOT), (await slotOf(block)) * SLOT);
  return build(both);
}
