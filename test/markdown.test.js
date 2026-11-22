import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../app/markdown.js';

test('headings, paragraphs with line breaks, dividers', () => {
  assert.equal(render('# Title\n\nline one\nline two\n\n---'), '<h1>Title</h1>\n<p>line one<br>line two</p>\n<hr>');
  assert.equal(render('### Three ###'), '<h3>Three</h3>');
  assert.equal(render('#nospace'), '<p>#nospace</p>');
});

test('bold, italic, strikethrough, code', () => {
  assert.equal(render('**b** __b__ *i* _i_ ~~s~~ `c*d*`'), '<p><strong>b</strong> <strong>b</strong> <em>i</em> <em>i</em> <del>s</del> <code>c*d*</code></p>');
  assert.equal(render('snake_case_name and 2*3*4'), '<p>snake_case_name and 2<em>3</em>4</p>');
});

test('lists: bullets, numbers, checkboxes, nesting', () => {
  assert.equal(render('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(render('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  assert.equal(render('- [ ] todo\n- [x] done'),
    '<ul><li class="task"><input type="checkbox" disabled> todo</li><li class="task"><input type="checkbox" disabled checked> done</li></ul>');
  assert.equal(render('- a\n  - a1\n- b'), '<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>');
});

test('quotes and code blocks', () => {
  assert.equal(render('> quoted\n> **two**'), '<blockquote><p>quoted<br><strong>two</strong></p></blockquote>');
  assert.equal(render('```\n<b>x</b>\n  **y**\n```'), '<pre><code>&lt;b&gt;x&lt;/b&gt;\n  **y**</code></pre>');
});

test('links: http(s) and mailto only, also bare URLs', () => {
  assert.equal(render('[site](https://example.com/?a=1&b=2)'),
    '<p><a href="https://example.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">site</a></p>');
  assert.equal(render('see https://example.com.'),
    '<p>see <a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>.</p>');
  assert.equal(render('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
});

test('nothing typed can become HTML', () => {
  const attacks = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>',
    '[a](https://x.com/"onmouseover="alert(1))', '**<b>**', '`<i>`', '> <iframe>', '- <a href=javascript:x>',
    '[<img src=x>](https://ok.com)', 'https://x.com/<script>',
  ];
  for (const a of attacks) {
    const html = render(a);
    const tags = [...html.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]);
    assert.ok(tags.every((t) => ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'input', 'blockquote', 'h1', 'hr'].includes(t)), `${a} → ${html}`);
    assert.ok(!/<a [^>]*href="(?!https?:|mailto:)/.test(html) && !/<[^>]*\son\w+=/.test(html), `${a} → ${html}`); // no handler inside a real tag
  }
});

test('odd input never hangs and always renders', () => {
  for (const s of ['', '\n\n', '```', '>', '-', '1.', '# ', '***', '[', '](', '**', '_', '~~~\nx', '- [ ]', '  - x', '######']) {
    assert.equal(typeof render(s), 'string', JSON.stringify(s));
  }
});

test('100,000 random inputs: only our tags, only safe links, never stuck', () => {
  const bits = ['*', '**', '_', '__', '~~', '`', '```', '#', '# ', '> ', '- ', '1. ', '- [ ] ', '- [x] ', '[', ']', '(', ')',
    '<', '>', '"', "'", '&', '\n', '\n\n', '  ', 'a', 'word', 'https://x.com/a?b=1&c=2', 'javascript:alert(1)', 'mailto:a@b.c',
    '<script>', '<img src=x onerror=alert(1)>', 'onload=', '---', '\\', '|', '~~~', '\t'];
  let seed = 42;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const allowed = new Set(['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'input', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr']);
  for (let n = 0; n < 100000; n++) {
    let md = '';
    for (let k = rnd(30); k > 0; k--) md += bits[rnd(bits.length)];
    const html = render(md);
    for (const [, tag, attrs] of html.matchAll(/<\/?([a-z0-9]+)([^>]*)>/g)) {
      assert.ok(allowed.has(tag), `tag ${tag} from ${JSON.stringify(md)}`);
      assert.ok(!/\son\w+=/i.test(attrs), `handler from ${JSON.stringify(md)}`);
      const href = attrs.match(/href="([^"]*)"/)?.[1];
      if (href != null) assert.ok(/^(https?:\/\/|mailto:)/i.test(href), `href ${href} from ${JSON.stringify(md)}`);
    }
  }
});

test('with { lines: true }, blocks carry their line in the text', () => {
  const md = '# Title\n\none\ntwo\n\n- a\n  - b\n\n> q1\n> q2\n\n```\ncode\n```';
  const html = render(md, { lines: true });
  for (const [needle, line] of [['<h1 data-line="0"', 0], ['<span data-line="2">one', 2], ['<span data-line="3">two', 3],
    ['<li data-line="5">a', 5], ['<li data-line="6">b', 6], ['<span data-line="8">q1', 8], ['<span data-line="9">q2', 9], ['<pre data-line="12"', 12]]) {
    assert.ok(html.includes(needle), `${needle} (line ${line}) in ${html}`);
  }
  assert.ok(!render(md).includes('data-line'));
});
