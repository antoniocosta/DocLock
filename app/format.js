// The editor's formatting bar: Each action wraps the selection (or the
// current lines) in Markdown. Text goes in through the browser's own
// insertion, so Undo (Ctrl/⌘+Z) still works.

/** Replaces [start, end) with text, then selects [selStart, selEnd) (relative to start). */
function put(ta, start, end, text, selStart = text.length, selEnd = selStart) {
  ta.focus();
  ta.setSelectionRange(start, end);
  if (!document.execCommand('insertText', false, text)) { // older browsers: no undo step, same result
    ta.setRangeText(text, start, end);
    ta.dispatchEvent(new Event('input'));
  }
  ta.setSelectionRange(start + selStart, start + selEnd);
}

/** Toggles a marker around the selection: **bold**, _italic_, `code`. */
function wrap(ta, mark, placeholder) {
  const { value: v, selectionStart: s, selectionEnd: e } = ta;
  if (v.slice(s - mark.length, s) === mark && v.slice(e, e + mark.length) === mark) { // already wrapped: Unwrap
    return put(ta, s - mark.length, e + mark.length, v.slice(s, e), 0, e - s);
  }
  const text = v.slice(s, e) || placeholder;
  put(ta, s, e, mark + text + mark, mark.length, mark.length + text.length);
}

const PREFIX = /^(#{1,6} |> |[-*+] \[[ xX]\] |[-*+] |\d+[.)] )/;

/** Sets or toggles a prefix on every selected line: Headings, quotes, lists. */
function lines(ta, next) {
  const { value: v, selectionStart: s, selectionEnd: e } = ta;
  const start = v.lastIndexOf('\n', s - 1) + 1;
  const nl = v.indexOf('\n', e > s && v[e - 1] === '\n' ? e - 1 : e); // a selection ending at a line start leaves that line out
  const end = nl < 0 ? v.length : nl;
  const block = v.slice(start, end).split('\n');
  const text = block.map((l, i) => { const old = l.match(PREFIX)?.[0] ?? ''; return next(old, i, block) + l.slice(old.length); }).join('\n');
  put(ta, start, end, text, text.length);
}

const all = (block, re) => block.every((l) => re.test(l));

export const actions = {
  bold: (ta) => wrap(ta, '**', 'bold text'),
  italic: (ta) => wrap(ta, '_', 'italic text'),
  strike: (ta) => wrap(ta, '~~', 'struck text'),
  heading: (ta) => lines(ta, (old) => { // # → ## → ### → none
    const level = /^#+ $/.test(old) ? old.length - 1 : 0;
    return level >= 3 ? '' : '#'.repeat(level + 1) + ' ';
  }),
  quote: (ta) => lines(ta, (old, i, block) => (all(block, /^> /) ? '' : '> ')),
  bullets: (ta) => lines(ta, (old, i, block) => (all(block, /^[-*+] (?!\[)/) ? '' : '- ')),
  numbers: (ta) => lines(ta, (old, i, block) => (all(block, /^\d+[.)] /) ? '' : `${i + 1}. `)),
  checklist: (ta) => lines(ta, (old, i, block) => (all(block, /^[-*+] \[[ xX]\] /) ? '' : '- [ ] ')),
  code: (ta) => {
    const { value: v, selectionStart: s, selectionEnd: e } = ta;
    if (!v.slice(s, e).includes('\n')) return wrap(ta, '`', 'code');
    const text = '```\n' + v.slice(s, e).replace(/\n$/, '') + '\n```';
    put(ta, s, e, text);
  },
  link: (ta) => {
    const { value: v, selectionStart: s, selectionEnd: e } = ta;
    const label = v.slice(s, e) || 'link text', text = `[${label}](https://)`;
    put(ta, s, e, text, label.length + 3, text.length - 1); // the address selected, ready to paste over
  },
};
