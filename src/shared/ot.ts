// Operational transformation for plain text, shared by the server and the
// browser.
//
// An operation is an array of components that walks over the whole document:
//   positive integer n   retain n characters
//   negative integer -n  delete n characters
//   non-empty string s   insert s
//
// Lengths are counted in UTF-16 code units, the same unit JavaScript strings
// and <textarea> selections use.

export type Component = number | string;
export type Op = Component[];

export interface OpMessage {
  rev: number;
  seq: number;
  op: Op;
}

export interface HistoryEntry {
  op: Op;
  clientId: string | null;
  seq: number | null;
}

function isRetain(c: Component | undefined): c is number { return typeof c === 'number' && c > 0; }
function isDelete(c: Component | undefined): c is number { return typeof c === 'number' && c < 0; }
function isInsert(c: Component | undefined): c is string { return typeof c === 'string'; }

// Builders. They keep operations in a canonical form: adjacent components of
// the same kind are merged, and an insert next to a delete always comes first.
export function retain(ops: Op, n: number): Op {
  if (n <= 0) return ops;
  const last = ops[ops.length - 1];
  if (isRetain(last)) ops[ops.length - 1] = last + n;
  else ops.push(n);
  return ops;
}

export function insert(ops: Op, s: string): Op {
  if (!s) return ops;
  const n = ops.length;
  const last = ops[n - 1];
  const prev = ops[n - 2];
  if (isInsert(last)) {
    ops[n - 1] = last + s;
  } else if (isDelete(last)) {
    if (isInsert(prev)) ops[n - 2] = prev + s;
    else { ops[n] = last; ops[n - 1] = s; }
  } else {
    ops.push(s);
  }
  return ops;
}

export function del(ops: Op, n: number): Op {
  if (n <= 0) return ops;
  const last = ops[ops.length - 1];
  if (isDelete(last)) ops[ops.length - 1] = last - n;
  else ops.push(-n);
  return ops;
}

// Checks an operation that came from an untrusted source.
export function isValid(op: unknown): op is Op {
  if (!Array.isArray(op)) return false;
  for (const c of op) {
    if (typeof c === 'string') { if (c.length === 0) return false; }
    else if (!Number.isSafeInteger(c) || c === 0) return false;
  }
  return true;
}

// Length of the document the operation applies to.
export function baseLength(op: Op): number {
  let n = 0;
  for (const c of op) {
    if (isRetain(c)) n += c;
    else if (isDelete(c)) n -= c;
  }
  return n;
}

// Length of the document after the operation is applied.
export function targetLength(op: Op): number {
  let n = 0;
  for (const c of op) {
    if (isRetain(c)) n += c;
    else if (isInsert(c)) n += c.length;
  }
  return n;
}

export function isNoop(op: Op): boolean {
  return op.every(isRetain);
}

export function apply(text: string, op: Op): string {
  if (baseLength(op) !== text.length) {
    throw new Error(`Operation base length ${baseLength(op)} does not match document length ${text.length}`);
  }
  const out: string[] = [];
  let pos = 0;
  for (const c of op) {
    if (isRetain(c)) { out.push(text.slice(pos, pos + c)); pos += c; }
    else if (isInsert(c)) out.push(c);
    else pos -= c;
  }
  return out.join('');
}

// Returns the operation that undoes `op`, given the text `op` was applied to.
export function invert(text: string, op: Op): Op {
  const ops: Op = [];
  let pos = 0;
  for (const c of op) {
    if (isRetain(c)) { retain(ops, c); pos += c; }
    else if (isInsert(c)) del(ops, c.length);
    else { insert(ops, text.slice(pos, pos - c)); pos -= c; }
  }
  return ops;
}

// compose(a, b) has the same effect as applying a and then b.
export function compose(a: Op, b: Op): Op {
  if (targetLength(a) !== baseLength(b)) {
    throw new Error('compose: the first operation\'s target length must equal the second\'s base length');
  }
  const ops: Op = [];
  let i = 0, j = 0;
  let x: Component | undefined = a[i++], y: Component | undefined = b[j++];
  for (;;) {
    if (x === undefined && y === undefined) break;
    if ((typeof x === 'number' && x < 0)) { del(ops, -x); x = a[i++]; continue; }
    if (isInsert(y)) { insert(ops, y); y = b[j++]; continue; }
    if (x === undefined || y === undefined) throw new Error('compose: operations do not line up');

    if ((typeof x === 'number' && x > 0) && (typeof y === 'number' && y > 0)) {
      if (x > y) { retain(ops, y); x -= y; y = b[j++]; }
      else if (x === y) { retain(ops, x); x = a[i++]; y = b[j++]; }
      else { retain(ops, x); y -= x; x = a[i++]; }
    } else if (isInsert(x) && (typeof y === 'number' && y < 0)) {
      if (x.length > -y) { x = x.slice(-y); y = b[j++]; }
      else if (x.length === -y) { x = a[i++]; y = b[j++]; }
      else { y += x.length; x = a[i++]; }
    } else if (isInsert(x) && (typeof y === 'number' && y > 0)) {
      if (x.length > y) { insert(ops, x.slice(0, y)); x = x.slice(y); y = b[j++]; }
      else if (x.length === y) { insert(ops, x); x = a[i++]; y = b[j++]; }
      else { insert(ops, x); y -= x.length; x = a[i++]; }
    } else if ((typeof x === 'number' && x > 0) && (typeof y === 'number' && y < 0)) {
      if (x > -y) { del(ops, -y); x += y; y = b[j++]; }
      else if (x === -y) { del(ops, -y); x = a[i++]; y = b[j++]; }
      else { del(ops, x); y += x; x = a[i++]; }
    }
  }
  return ops;
}

// transform(a, b) takes two operations made concurrently on the same text
// and returns [a', b'] so that apply(apply(t, a), b') === apply(apply(t, b), a').
// When both insert at the same position, a's text goes first.
export function transform(a: Op, b: Op): [Op, Op] {
  if (baseLength(a) !== baseLength(b)) {
    throw new Error('transform: both operations must have the same base length');
  }
  const a1: Op = [], b1: Op = [];
  let i = 0, j = 0;
  let x: Component | undefined = a[i++], y: Component | undefined = b[j++];
  for (;;) {
    if (x === undefined && y === undefined) break;
    if (isInsert(x)) { insert(a1, x); retain(b1, x.length); x = a[i++]; continue; }
    if (isInsert(y)) { retain(a1, y.length); insert(b1, y); y = b[j++]; continue; }
    if (x === undefined || y === undefined) throw new Error('transform: operations do not line up');

    let n: number;
    if ((typeof x === 'number' && x > 0) && (typeof y === 'number' && y > 0)) {
      if (x > y) { n = y; x -= y; y = b[j++]; }
      else if (x === y) { n = x; x = a[i++]; y = b[j++]; }
      else { n = x; y -= x; x = a[i++]; }
      retain(a1, n); retain(b1, n);
    } else if ((typeof x === 'number' && x < 0) && (typeof y === 'number' && y < 0)) {
      // Both deleted the same text; neither needs to delete it again.
      if (-x > -y) { x -= y; y = b[j++]; }
      else if (x === y) { x = a[i++]; y = b[j++]; }
      else { y -= x; x = a[i++]; }
    } else if ((typeof x === 'number' && x < 0) && (typeof y === 'number' && y > 0)) {
      if (-x > y) { n = y; x += y; y = b[j++]; }
      else if (-x === y) { n = y; x = a[i++]; y = b[j++]; }
      else { n = -x; y += x; x = a[i++]; }
      del(a1, n);
    } else if ((typeof x === 'number' && x > 0) && (typeof y === 'number' && y < 0)) {
      if (x > -y) { n = -y; x += y; y = b[j++]; }
      else if (x === -y) { n = x; x = a[i++]; y = b[j++]; }
      else { n = x; y += x; x = a[i++]; }
      del(b1, n);
    }
  }
  return [a1, b1];
}

// Moves a cursor position across an operation. Text inserted exactly at the
// cursor ends up after it.
export function transformIndex(index: number, op: Op): number {
  let pos = 0, out = index;
  for (const c of op) {
    if (pos > index) break;
    if (isRetain(c)) pos += c;
    else if (isInsert(c)) { if (pos < index) out += c.length; }
    else { out -= Math.min(-c, index - pos); pos -= c; }
  }
  return out;
}

// The smallest single-replacement operation that turns a into b.
export function fromDiff(a: string, b: string): Op {
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) { endA--; endB--; }
  const ops: Op = [];
  retain(ops, start);
  insert(ops, b.slice(start, endB));
  del(ops, endA - start);
  retain(ops, a.length - endA);
  return ops;
}

// Server side of the central-server protocol. Clients send operations tagged
// with the revision they were made against; the server transforms them past
// everything that happened since and applies them.
export class Server {
  text: string;
  rev: number;
  history: HistoryEntry[] = [];
  historyStart: number;
  maxHistory: number;

  constructor(text: string, rev = 0, maxHistory = 2000) {
    this.text = text;
    this.rev = rev;
    this.historyStart = rev;
    this.maxHistory = maxHistory;
  }

  // Applies a client's operation and returns the transformed operation that
  // was applied. Throws without changing state if the operation is bad.
  receive(rev: number, op: unknown, meta?: { clientId?: string | null; seq?: number | null }): Op {
    if (!isValid(op)) throw new Error('Invalid operation');
    if (!Number.isSafeInteger(rev) || rev < this.historyStart || rev > this.rev) {
      throw new Error(`Revision ${rev} is out of range`);
    }
    let applied: Op = op;
    for (let k = rev - this.historyStart; k < this.history.length; k++) {
      applied = transform(applied, this.history[k].op)[0];
    }
    this.text = apply(this.text, applied);
    this.history.push({ op: applied, clientId: meta?.clientId ?? null, seq: meta?.seq ?? null });
    this.rev++;
    if (this.history.length > this.maxHistory) {
      const drop = this.history.length - this.maxHistory;
      this.history.splice(0, drop);
      this.historyStart += drop;
    }
    return applied;
  }

  // History entries after `rev`, or null when they are no longer kept.
  since(rev: unknown): HistoryEntry[] | null {
    if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < this.historyStart || rev > this.rev) return null;
    return this.history.slice(rev - this.historyStart);
  }
}

// Client side of the protocol. It holds at most one operation in flight
// (`outstanding`) and collects further local edits in `buffer` until the
// server acknowledges it.
export class Client {
  rev: number;
  serverText: string; // the document at `rev`, without local edits
  outstanding: Op | null = null;
  outstandingSeq = 0;
  buffer: Op | null = null;
  seq: number;

  constructor(rev: number, text: string, seq = 0) {
    this.rev = rev;
    this.serverText = text;
    this.seq = seq;
  }

  // Records a local edit. Returns a message to send, or null.
  applyClient(op: Op): OpMessage | null {
    if (isNoop(op)) return null;
    if (this.outstanding) {
      this.buffer = this.buffer ? compose(this.buffer, op) : op;
      return null;
    }
    this.outstanding = op;
    this.outstandingSeq = ++this.seq;
    return this.message();
  }

  // The server applied our outstanding operation. Returns the next message to
  // send, or null.
  serverAck(): OpMessage | null {
    if (!this.outstanding) throw new Error('Acknowledgement without an operation in flight');
    this.serverText = apply(this.serverText, this.outstanding);
    this.rev++;
    this.outstanding = this.buffer;
    this.buffer = null;
    if (!this.outstanding) return null;
    this.outstandingSeq = ++this.seq;
    return this.message();
  }

  // Another client's operation arrived. Returns the operation to apply to the
  // local text.
  applyServer(op: Op): Op {
    this.serverText = apply(this.serverText, op);
    this.rev++;
    if (this.outstanding) {
      const p = transform(this.outstanding, op);
      this.outstanding = p[0];
      op = p[1];
      if (this.buffer) {
        const q = transform(this.buffer, op);
        this.buffer = q[0];
        op = q[1];
      }
    }
    return op;
  }

  // The message for the operation in flight, for sending or re-sending.
  message(): OpMessage | null {
    if (!this.outstanding) return null;
    return { rev: this.rev, seq: this.outstandingSeq, op: this.outstanding };
  }

  // All local edits the server has not applied yet, as one operation.
  pending(): Op | null {
    if (!this.outstanding) return null;
    return this.buffer ? compose(this.outstanding, this.buffer) : this.outstanding;
  }
}
