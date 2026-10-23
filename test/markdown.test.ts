import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/shared/markdown.js';

test('headings, emphasis and code', () => {
  assert.equal(render('# Hi *there*'), '<h1 id="hi-there">Hi <em>there</em></h1>');
  assert.equal(render('**b** _i_ ~~s~~ `x<y`'), '<p><strong>b</strong> <em>i</em> <del>s</del> <code>x&lt;y</code></p>');
  assert.equal(render('```js\nlet a = 1 < 2;\n```'), '<pre><code class="language-js">let a = 1 &lt; 2;\n</code></pre>');
});

test('raw HTML and script links are neutralised', () => {
  assert.equal(render('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.match(render('[x](javascript:alert(1))'), /href="#"/);
  assert.match(render('![x](" onerror="alert(1))'), /^<p>!\[x\]\(&quot; onerror=&quot;alert\(1\)\)<\/p>$/);
});

test('links and autolinks', () => {
  assert.equal(render('[a](https://x.y "t")'), '<p><a href="https://x.y" title="t">a</a></p>');
  assert.equal(render('see https://x.y/a?b=1&c=2.'), '<p>see <a href="https://x.y/a?b=1&amp;c=2">https://x.y/a?b=1&amp;c=2</a>.</p>');
});

test('nested and task lists', () => {
  assert.equal(
    render('- a\n  - b\n- [x] c\n\n1. one\n2. two'),
    '<ul>\n<li>a\n<ul>\n<li>b</li>\n</ul></li>\n<li class="task"><input type="checkbox" disabled checked> c</li>\n</ul>\n<ol>\n<li>one</li>\n<li>two</li>\n</ol>'
  );
});

test('blockquotes, rules and tables', () => {
  assert.equal(render('> quoted\n> text'), '<blockquote>\n<p>quoted\ntext</p>\n</blockquote>');
  assert.equal(render('---'), '<hr>');
  assert.equal(
    render('| a | b |\n|---|--:|\n| 1 | 2 |'),
    '<table>\n<thead>\n<tr><th>a</th><th style="text-align:right">b</th></tr>\n</thead>\n<tbody>\n<tr><td>1</td><td style="text-align:right">2</td></tr>\n</tbody>\n</table>'
  );
});

test('hard line breaks', () => {
  assert.equal(render('a  \nb'), '<p>a<br>\nb</p>');
});
