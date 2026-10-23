import test from 'node:test';
import assert from 'node:assert/strict';
import { diffOp, matchLines, rebaseEdit } from '../src/shared/diff.js';
import * as OT from '../src/shared/ot.js';

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
}

test('diffOp turns one text into another', () => {
  const rand = rng(11);
  const words = ['a', 'b', 'c', '\n', '\n', 'x y', '# h', ''];
  for (let i = 0; i < 3000; i++) {
    const make = () => Array.from({ length: Math.floor(rand() * 12) }, () => words[Math.floor(rand() * words.length)]).join('');
    const a = make(), b = make();
    const op = diffOp(a, b);
    assert.equal(OT.apply(a, op), b, JSON.stringify([a, b, op]));
  }
});

test('diffOp keeps separate changes separate', () => {
  const a = 'one\ntwo\nthree\nfour\nfive\n';
  const b = 'ONE\ntwo\nthree\nfour\nfive!\n';
  const op = diffOp(a, b);
  assert.equal(OT.apply(a, op), b);
  // A concurrent edit in the middle survives untouched.
  const mine = OT.fromDiff(a, 'one\ntwo\nthree, 3\nfour\nfive\n');
  const [, theirs] = OT.transform(mine, op);
  assert.equal(OT.apply('one\ntwo\nthree, 3\nfour\nfive\n', theirs), 'ONE\ntwo\nthree, 3\nfour\nfive!\n');
});

test('matchLines finds the longest common runs', () => {
  const m = matchLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']);
  assert.deepEqual(m, [{ aStart: 0, bStart: 0, length: 1 }, { aStart: 2, bStart: 2, length: 2 }]);
});

test('rebaseEdit applies an edit without reformatting untouched lines', () => {
  const base = '* a\n* b\n\nSome __bold__ text\n\nend\n';
  const prev = '- a\n- b\n\nSome **bold** text\n\nend\n';
  assert.equal(rebaseEdit(base, prev, '- a\n- b\n\nSome **bold** text\n\nthe end\n'), '* a\n* b\n\nSome __bold__ text\n\nthe end\n');
  // Editing a line that was written differently takes the new form for that line only.
  assert.equal(rebaseEdit(base, prev, '- a\n- b!\n\nSome **bold** text\n\nend\n'), '* a\n- b!\n\nSome __bold__ text\n\nend\n');
  assert.equal(rebaseEdit(base, prev, 'new\n- a\n- b\n\nSome **bold** text\n\nend\n'), 'new\n* a\n* b\n\nSome __bold__ text\n\nend\n');
});

test('rebaseEdit agrees with plain edits when nothing differs', () => {
  const rand = rng(5);
  const words = ['a\n', 'b\n', '* c\n', '- c\n', '\n', 'x'];
  for (let i = 0; i < 2000; i++) {
    const make = () => Array.from({ length: Math.floor(rand() * 8) }, () => words[Math.floor(rand() * words.length)]).join('');
    const base = make(), prev = make(), next = make();
    assert.equal(rebaseEdit(prev, prev, next), next);
    const out = rebaseEdit(base, prev, next);
    if (prev === next) assert.equal(out, base, JSON.stringify([base, prev, next]));
  }
});
