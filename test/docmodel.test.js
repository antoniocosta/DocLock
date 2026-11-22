import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDocLink, docLink, pickTab, bodyText, findBlock, readEncryptedDoc,
  replaceBlockRequest, DocError, NON_TEXT,
} from '../app/docmodel.js';
import { newKey, seal, open } from '../app/cipher.js';

const key = await newKey('pw');

const ID = '1Exampl3DocIdForTests_abcdefghijklmnopqrstu';

// Builds a Docs API body the way documents.get returns it: a section break
// at index 0, then one paragraph per line, indexes in UTF-16 code units.
// An item {table: n} stands for a non-text element n units long.
function makeBody(items) {
  const content = [{ endIndex: 1, sectionBreak: {} }];
  let i = 1;
  for (const item of items) {
    if (typeof item === 'object') {
      content.push({ startIndex: i, endIndex: i + item.table, table: {} });
      i += item.table;
      continue;
    }
    const elements = [];
    // split a line into two runs to make sure runs are joined correctly
    const parts = item.length > 6 ? [item.slice(0, 3), item.slice(3)] : [item];
    let j = i;
    for (const p of parts) {
      elements.push({ startIndex: j, endIndex: j + p.length, textRun: { content: p, textStyle: {} } });
      j += p.length;
    }
    content.push({ startIndex: i, endIndex: j, paragraph: { elements } });
    i = j;
  }
  return { content };
}
const lines = (text) => text.split(/(?<=\n)/);
const makeDoc = (tabs) => ({ documentId: ID, title: 'test', revisionId: 'rev-1', tabs });
const makeTab = (tabId, title, items, childTabs = []) => ({
  tabProperties: { tabId, title, index: 0 }, documentTab: { body: makeBody(items) }, childTabs,
});

test('parseDocLink accepts the usual link forms and bare IDs', () => {
  const cases = [
    [`https://docs.google.com/document/d/${ID}/edit`, null],
    [`https://docs.google.com/document/d/${ID}/edit?usp=sharing`, null],
    [`https://docs.google.com/document/d/${ID}`, null],
    [`https://docs.google.com/document/u/1/d/${ID}/edit#heading=h.abc`, null],
    [`https://docs.google.com/document/d/${ID}/edit?tab=t.0`, 't.0'],
    [`https://docs.google.com/document/d/${ID}/edit?tab=t.k3x9v1ab2c`, 't.k3x9v1ab2c'],
    [`  https://docs.google.com/document/d/${ID}/view  `, null],
    [ID, null],
  ];
  for (const [input, tabId] of cases) assert.deepEqual(parseDocLink(input), { docId: ID, tabId }, input);
});

test('parseDocLink rejects other links', () => {
  for (const bad of ['', 'hello', 'http://docs.google.com/document/d/' + ID, 'https://evil.example/document/d/' + ID,
    'https://docs.google.com/spreadsheets/d/' + ID, 'https://docs.google.com/document/d/short/edit']) {
    assert.throws(() => parseDocLink(bad), DocError, bad);
  }
});

test('docLink', () => {
  assert.equal(docLink(ID), `https://docs.google.com/document/d/${ID}/edit`);
  assert.equal(docLink(ID, 't.0'), `https://docs.google.com/document/d/${ID}/edit?tab=t.0`);
});

test('pickTab: first tab by default, nested tabs by id', () => {
  const doc = makeDoc([makeTab('t.0', 'One', ['a\n']), makeTab('t.1', 'Two', ['b\n'], [makeTab('t.2', 'Child', ['c\n'])])]);
  assert.equal(pickTab(doc, null).tabProperties.tabId, 't.0');
  assert.equal(pickTab(doc, 't.2').tabProperties.title, 'Child');
  assert.throws(() => pickTab(doc, 't.9'), DocError);
});

test('bodyText maps characters to document indexes, non-text as placeholders', () => {
  const body = makeBody(['hello\n', { table: 5 }, 'world 😀\n']);
  const text = bodyText(body);
  assert.equal(text[0], NON_TEXT);
  assert.equal(text.slice(1, 7), 'hello\n');
  assert.equal(text.slice(7, 12), NON_TEXT.repeat(5));
  assert.equal(text.slice(12), 'world 😀\n');
  assert.equal(text.length, body.content.at(-1).endIndex);
});

test('findBlock finds the block among other text', async () => {
  const b = await seal('secret notes', key);
  const doc = makeDoc([makeTab('t.0', 'Tab 1', ['Intro paragraph\n', ...lines(b + '\n'), '\n', 'after\n'])]);
  const r = readEncryptedDoc(doc, null);
  assert.equal(r.block.armoured, b);
  assert.equal(r.text.slice(r.block.start, r.block.end), b);
  assert.equal((await open(r.block.armoured, key)).text, 'secret notes');
  assert.equal(r.revisionId, 'rev-1');
  assert.equal(r.tabId, 't.0');
});

test('findBlock refuses no block, two blocks, a cut-off block, or non-text inside', async () => {
  const b = await seal('abc', key), cut = b.indexOf('\nv3.') + 20; // inside the block, past the first line
  const cases = {
    'no-block': ['just text\n'],
    'many-blocks': [...lines(b + '\n'), ...lines(b + '\n')],
    'no-end': lines(b.slice(0, b.lastIndexOf('\n')) + '\n'),
    structure: [b.slice(0, cut) + '\n', { table: 4 }, b.slice(cut) + '\n'],
  };
  for (const [code, items] of Object.entries(cases)) {
    assert.throws(() => findBlock(bodyText(makeBody(items))), (e) => e instanceof DocError && e.code === code, code);
  }
});

test('replaceBlockRequest targets exactly the block and pins the revision', async () => {
  const doc = makeDoc([makeTab('t.0', 'Tab 1', ['Keep me\n', ...lines(await seal('old', key) + '\n'), 'After\n'])]);
  const r = readEncryptedDoc(doc, 't.0');
  const next = await seal('new text', key);
  const req = replaceBlockRequest(r, next);
  assert.deepEqual(req.writeControl, { requiredRevisionId: 'rev-1' });
  const [del, ins] = req.requests;
  assert.deepEqual(del.deleteContentRange.range, { startIndex: r.block.start, endIndex: r.block.end, tabId: 't.0' });
  assert.deepEqual(ins.insertText.location, { index: r.block.start, tabId: 't.0' });
  assert.ok(!ins.insertText.text.endsWith('\n'));
  // Applying the request to the text gives the new block, the rest intact.
  const after = r.text.slice(0, r.block.start) + ins.insertText.text + r.text.slice(r.block.end);
  assert.ok(after.includes('Keep me\n' + next + '\nAfter\n'));
  assert.equal((await open(findBlock(after).armoured, key)).text, 'new text');
});
