// Line diff (Myers' O(ND) algorithm) and helpers for turning text changes
// into small operations.

import * as OT from './ot.js';

// A run of lines that are the same in both inputs: a[aStart + i] === b[bStart + i].
export interface Match {
  aStart: number;
  bStart: number;
  length: number;
}

// The runs of equal lines, in order, in a shortest edit script from a to b.
export function matchLines(a: string[], b: string[]): Match[] {
  // Trim the common start and end first; most diffs are small.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const matches: Match[] = [];
  if (pre) matches.push({ aStart: 0, bStart: 0, length: pre });
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  for (const m of myers(A, B)) matches.push({ aStart: m.aStart + pre, bStart: m.bStart + pre, length: m.length });
  if (suf) matches.push({ aStart: a.length - suf, bStart: b.length - suf, length: suf });
  return matches;
}

function myers(a: string[], b: string[]): Match[] {
  const n = a.length, m = b.length;
  if (n === 0 || m === 0) return [];
  const max = n + m;
  const offset = max;
  let v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  // Walk back through the trace to recover the diagonal runs.
  const runs: Match[] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : vd[offset + prevK];
    const prevY = prevX - prevK;
    const startX = d === 0 ? 0 : prevK === k + 1 ? prevX : prevX + 1;
    const startY = startX - k;
    if (x > startX) runs.push({ aStart: startX, bStart: startY, length: x - startX });
    x = prevX;
    y = d === 0 ? 0 : prevY;
  }
  return runs.reverse();
}

// Splits text into lines that keep their newline, so the pieces add up to
// exactly the text.
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}

// An operation from `a` to `b` that changes only what differs, line by line
// and then character by character within changed lines. Unlike a single
// prefix/suffix replace, separate edits stay separate, which keeps
// concurrent edits elsewhere in the text intact.
export function diffOp(a: string, b: string): OT.Op {
  const al = splitLines(a), bl = splitLines(b);
  const ops: OT.Op = [];
  let ai = 0, bi = 0; // lines consumed so far
  const advance = (aEnd: number, bEnd: number, same: boolean) => {
    let from = '', to = '';
    for (; ai < aEnd; ai++) from += al[ai];
    for (; bi < bEnd; bi++) to += bl[bi];
    if (same) OT.retain(ops, from.length);
    else {
      for (const c of OT.fromDiff(from, to)) {
        if (typeof c === 'string') OT.insert(ops, c);
        else if (c > 0) OT.retain(ops, c);
        else OT.del(ops, -c);
      }
    }
  };
  for (const m of matchLines(al, bl)) {
    advance(m.aStart, m.bStart, false);
    advance(m.aStart + m.length, m.bStart + m.length, true);
  }
  advance(al.length, bl.length, false);
  return ops;
}

interface Hunk {
  pa: number; pb: number; // replaced lines in prev
  na: number; nb: number; // replacement lines in next
}

// `prev` and `next` are two versions of a text, and `base` is a variant of
// `prev` that differs only in formatting details (for example a Markdown
// editor writing "-" where the file has "*"). Applies the prev→next change
// to `base`, keeping base's own form wherever the change didn't touch it.
export function rebaseEdit(base: string, prev: string, next: string): string {
  if (base === prev) return next;
  const P = splitLines(prev), N = splitLines(next), B = splitLines(base);

  // Line boundaries of prev that have a known counterpart in base.
  // Where prev and base differ by the same number of lines, the lines are
  // taken to correspond one to one (the usual case for reformatting).
  const map = new Map<number, number>();
  let pp = 0, bp = 0;
  const gap = (pEnd: number, bEnd: number) => {
    if (pEnd - pp === bEnd - bp) for (let t = 0; t <= pEnd - pp; t++) map.set(pp + t, bp + t);
    map.set(pp, bp);
    map.set(pEnd, bEnd);
  };
  for (const r of matchLines(P, B)) {
    gap(r.aStart, r.bStart);
    for (let t = 0; t <= r.length; t++) map.set(r.aStart + t, r.bStart + t);
    pp = r.aStart + r.length;
    bp = r.bStart + r.length;
  }
  gap(P.length, B.length);

  const hunks: Hunk[] = [];
  let pi = 0, ni = 0;
  for (const r of matchLines(P, N)) {
    if (r.aStart > pi || r.bStart > ni) hunks.push({ pa: pi, pb: r.aStart, na: ni, nb: r.bStart });
    pi = r.aStart + r.length;
    ni = r.bStart + r.length;
  }
  if (pi < P.length || ni < N.length) hunks.push({ pa: pi, pb: P.length, na: ni, nb: N.length });

  // Widen each change to boundaries that exist in base, merging changes
  // that run into each other. Lines outside changes are equal in prev and
  // next, so widening moves both sides together.
  const out: Hunk[] = [];
  for (let i = 0; i < hunks.length; i++) {
    let h = { ...hunks[i] };
    while (!map.has(h.pa)) { h.pa--; h.na--; }
    const last = out[out.length - 1];
    if (last && h.pa < last.pb) {
      out.pop();
      h = { pa: last.pa, na: last.na, pb: h.pb, nb: h.nb };
    }
    for (;;) {
      while (!map.has(h.pb)) { h.pb++; h.nb++; }
      const following = hunks[i + 1];
      if (following && h.pb > following.pa) {
        h.pb = Math.max(h.pb, following.pb);
        h.nb = h.pb + (following.nb - following.pb);
        i++;
        continue;
      }
      break;
    }
    out.push(h);
  }

  let result = '';
  let bi = 0;
  for (const h of out) {
    result += B.slice(bi, map.get(h.pa)).join('') + N.slice(h.na, h.nb).join('');
    bi = map.get(h.pb)!;
  }
  return result + B.slice(bi).join('');
}
