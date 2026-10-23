import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLines, inline } from '../src/client/live-render.js';

// What the editor reads back from rendered HTML: all text except widgets.
function textOf(html: string): string {
  let s = html;
  let prev;
  do {
    prev = s;
    s = s.replace(/<span class="widget[^"]*" contenteditable="false">(?:(?!<span)[\s\S])*?<\/span>/g, '');
  } while (s !== prev);
  return s
    .replace(/<br>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

const SAMPLE = [
  '# Heading with *style*',
  '',
  'Some **bold**, _italic_, ~~gone~~, `code <b>`, a [link](https://x.y "t") and https://example.com/a?b=1&c=2.',
  '![pic](img.png) and ![bad](javascript:alert(1))',
  '- item',
  '  - [ ] task',
  '  - [x] done',
  '1. first',
  '> quote with **bold**',
  '> - quoted list',
  '---',
  '```js',
  'const a = 1 < 2;',
  '',
  '```',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  'escaped \\*not italic\\* and snake_case_word and 2*3*4',
  '<script>alert(1)</script>',
  '***',
  '__init__ is not bold in a_b__c'
];

test('rendering keeps every character of the source, in order', () => {
  const rendered = renderLines(SAMPLE);
  assert.equal(rendered.length, SAMPLE.length);
  rendered.forEach((r, i) => assert.equal(textOf(r.html), SAMPLE[i], `line ${i}: ${r.html}`));
});

test('random text survives rendering', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const chars = 'ab *_`~[]()!<>#-|\\:/h.x&"\'';
  for (let n = 0; n < 3000; n++) {
    let line = '';
    const len = Math.floor(rand() * 24);
    for (let k = 0; k < len; k++) line += chars[Math.floor(rand() * chars.length)];
    const [r] = renderLines([line]);
    assert.equal(textOf(r.html), line, JSON.stringify(line) + ' -> ' + r.html);
  }
});

test('line classes and widgets', () => {
  const [h, , , img, li, task, done, ol, quote, , hr, open, code, , close] = renderLines(SAMPLE);
  assert.match(h.cls, /\bh1\b/);
  assert.match(img.html, /<img src="img.png"/);
  assert.doesNotMatch(img.html, /(src|href)="javascript/);
  assert.match(li.cls, /\bul\b/);
  assert.match(task.html, /type="checkbox"/);
  assert.match(done.cls, /\bdone\b/);
  assert.match(ol.cls, /\bol\b/);
  assert.match(quote.cls, /\bquote\b/);
  assert.match(hr.cls, /\bhr\b/);
  assert.match(open.cls, /fence-open/);
  assert.equal(code.block, open.block);
  assert.equal(close.block, open.block);
  assert.match(inline('**b**'), /<strong>b<\/strong>/);
  assert.match(inline('<script>'), /&lt;script&gt;/);
});
