// A small Markdown renderer for the editor's Preview, covering what notes
// use: Headings, paragraphs (a line break is a line break), bold, italic,
// strikethrough, inline code, links, bullet, numbered and check lists,
// quotes, code blocks and dividers. No images, no raw HTML.
//
// Safe by construction: Every piece of text is HTML-escaped before any
// formatting is applied, and the only tags in the output are the ones built
// here. Links are kept only for http(s) and mailto addresses.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** One line or paragraph of text (already split into blocks) → HTML. */
function inline(text) {
  text = text.replace(/\u0000/g, '\uFFFD'); // the placeholder character: Never taken from the text
  const kept = []; // code spans and links, kept out of the other rules
  const keep = (html) => `\u0000${kept.push(html) - 1}\u0000`;
  let s = text.replace(/`([^`\n]+)`/g, (m, code) => keep(`<code>${esc(code)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (m, label, url) =>
    /^(https?:\/\/|mailto:)/i.test(url) ? keep(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${inlineText(label)}</a>`) : m);
  s = s.replace(/\bhttps?:\/\/[^\s<>()\u0000]+[^\s<>()\u0000.,;:!?'"]/g, (url) => keep(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`));
  s = inlineText(s);
  while (/\u0000\d+\u0000/.test(s)) s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => kept[i]); // a link label may hold a code span
  return s;
}

/** Escapes, then bold, italic and strikethrough. */
function inlineText(s) {
  return esc(s)
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=[^\s_])([^\n_]*?[^\s_])__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/\*(?=[^\s*])([^\n*]*?[^\s*])\*/g, '<em>$1</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([^\n_]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, '<del>$1</del>');
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/**
 * Markdown text → HTML. With { lines: true }, blocks carry data-line (their
 * line in the text, from 0), so a double-click in Preview can find its place.
 */
export function render(md, { lines: withLines = false, base = 0, depth = 0 } = {}) {
  if (depth > 20) return `<p>${esc(String(md))}</p>`; // quotes or lists nested deeper: Shown as plain text
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const at = (n) => (withLines ? ` data-line="${base + n}"` : '');
  const sub = (text, n) => render(text, { lines: withLines, base: base + n, depth: depth + 1 });
  const out = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) { // code block, to the closing fence (or the end)
      const body = [], start = i;
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      i++;
      out.push(`<pre${at(start + 1)}><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { out.push(`<h${h[1].length}${at(i)}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    if (/^\s*>/.test(line)) { // quote: Its lines, rendered on their own
      const body = [], start = i;
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${sub(body.join('\n'), start)}</blockquote>`);
      continue;
    }

    const first = line.match(LIST);
    if (first) { // a list: Its items, and indented lines under an item (a nested list)
      const ordered = /\d/.test(first[2]), indent = first[1].length, items = [];
      for (; i < lines.length; i++) {
        const m = lines[i].match(LIST);
        if (m && m[1].length <= indent && /\d/.test(m[2]) === ordered) items.push({ text: m[3], line: i, more: [], moreAt: 0 });
        else if (items.length && lines[i].trim() && /^\s/.test(lines[i]) && (!m || m[1].length > indent)) {
          const it = items.at(-1);
          if (!it.more.length) it.moreAt = i;
          it.more.push(lines[i].slice(indent + 2));
        }
        else break;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(({ text, line: n, more, moreAt }) => {
        const box = text.match(/^\[([ xX])\]\s+(.*)$/);
        const head = box ? `<input type="checkbox" disabled${box[1] === ' ' ? '' : ' checked'}> ${inline(box[2])}` : inline(text);
        return `<li${box ? ' class="task"' : ''}${at(n)}>${head}${more.length ? sub(more.join('\n'), moreAt) : ''}</li>`;
      }).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    const para = [], start = i; // a paragraph: Up to a blank line or another kind of block
    for (; i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>)/.test(lines[i]) && !LIST.test(lines[i]); i++) para.push(lines[i].trim());
    if (!para.length) para.push(lines[i++].trim()); // always move on
    out.push(`<p${at(start)}>${para.map((l, k) => (withLines ? `<span${at(start + k)}>${inline(l)}</span>` : inline(l))).join('<br>')}</p>`);
  }
  return out.join('\n');
}
