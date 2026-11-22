// Google Docs documents: link parsing, tabs, body text by document index,
// and the one encrypted block. Pure functions.

import { START, END } from './cipher.js';

/** Stands for anything in the body that is not text (tables, images…). */
export const NON_TEXT = '\uE907'; // a private-use character

export class DocError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DocError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new DocError(code, message); };

const ID = /^[\w-]{25,}$/;

/** A docs.google.com link (any form) or a bare ID → { docId, tabId }. */
export function parseDocLink(input) {
  const s = String(input || '').trim();
  if (ID.test(s)) return { docId: s, tabId: null };
  let url;
  try { url = new URL(s); } catch { fail('link', "That's not a Google Docs link."); }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') fail('link', 'Use a link starting with https://docs.google.com/document/.');
  const m = url.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([\w-]+)/);
  if (!m || !ID.test(m[1])) fail('link', 'That link has no doc ID.');
  const tab = url.searchParams.get('tab') || new URLSearchParams(url.hash.slice(1)).get('tab');
  return { docId: m[1], tabId: /^t\.[\w.-]+$/.test(tab || '') ? tab : null };
}

export const docLink = (docId, tabId) => `https://docs.google.com/document/d/${docId}/edit${tabId ? `?tab=${tabId}` : ''}`;

/** All tabs, children after their parent. */
const allTabs = (tabs = []) => tabs.flatMap((t) => [t, ...allTabs(t.childTabs)]);

/** The tab named in the link, else the first (documents.get with includeTabsContent). */
export function pickTab(doc, tabId) {
  const tabs = allTabs(doc.tabs);
  const t = tabId ? tabs.find((x) => x.tabProperties?.tabId === tabId) : tabs[0];
  return t || fail('tabs', tabId ? "The link's tab isn't in this doc." : 'This doc has no tabs.');
}

/** Body text where text[i] is the character at document index i. */
export function bodyText(body) {
  const content = body?.content || [];
  const chars = new Array(content.at(-1)?.endIndex || 1).fill(NON_TEXT);
  for (const pe of content.flatMap((el) => el.paragraph?.elements || [])) {
    const text = pe.textRun?.content;
    if (text == null) continue;
    const start = pe.startIndex || 0;
    if (start + text.length !== pe.endIndex) fail('structure', 'This doc has an unexpected structure.');
    for (let i = 0; i < text.length; i++) chars[start + i] = text[i];
  }
  return chars.join('');
}

/**
 * The one encrypted block, from its first ##### line to the end of its last
 * ({ start, end, armoured }). start/end are document indexes.
 */
export function findBlock(text) {
  const start = text.indexOf(START);
  if (start < 0) fail('no-block', 'No encrypted text in this doc.');
  const endAt = text.indexOf(END, start);
  if (endAt < 0) fail('no-end', 'The encrypted text is cut off.');
  const end = endAt + END.length, armoured = text.slice(start, end);
  if (text.includes(START, end)) fail('many-blocks', 'This doc has more than one encrypted block. DocLock handles only one.');
  if (armoured.includes(NON_TEXT)) fail('structure', 'The encrypted text has a table or image inside it.');
  return { start, end, armoured };
}

/** What DocLock needs from a documents.get response. */
export function readEncryptedDoc(doc, tabId) {
  const tab = pickTab(doc, tabId);
  const text = bodyText(tab.documentTab?.body || fail('tabs', 'That tab is empty.'));
  return {
    docId: doc.documentId,
    title: doc.title,
    revisionId: doc.revisionId,
    tabId: tab.tabProperties.tabId,
    tabTitle: tab.tabProperties.title,
    tabCount: allTabs(doc.tabs).length,
    linkTab: tab === allTabs(doc.tabs)[0] ? null : tab.tabProperties.tabId, // the first tab is the doc itself: One recent, with or without ?tab=
    block: findBlock(text),
    text,
  };
}

/** One atomic batchUpdate swapping the block, refused if the doc changed since revisionId. */
export const replaceBlockRequest = ({ revisionId, tabId, block }, newArmoured) => ({
  requests: [
    { deleteContentRange: { range: { startIndex: block.start, endIndex: block.end, tabId } } },
    { insertText: { location: { index: block.start, tabId }, text: newArmoured } },
  ],
  writeControl: { requiredRevisionId: revisionId },
});
