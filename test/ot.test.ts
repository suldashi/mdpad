import test from 'node:test';
import assert from 'node:assert/strict';
import * as OT from '../src/shared/ot.js';

type Rand = () => number;
interface SimClient {
  id: string;
  text: string;
  ot: OT.Client;
  toServer: OT.OpMessage[];
  fromServer: Array<{ ack: true } | { op: OT.Op }>;
}

// Small seeded PRNG so failures are reproducible.
function rng(seed: number): Rand {
  return function () {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function randomString(rand: Rand, max: number): string {
  const chars = 'abcde \n#*😀';
  let s = '';
  const n = Math.floor(rand() * max);
  for (let i = 0; i < n; i++) s += chars[Math.floor(rand() * chars.length)];
  return s;
}

function randomOp(rand: Rand, text: string): OT.Op {
  const ops: OT.Op = [];
  let left = text.length;
  while (left > 0) {
    const n = 1 + Math.floor(rand() * Math.min(left, 5));
    const r = rand();
    if (r < 0.2) OT.insert(ops, randomString(rand, 4) || 'x');
    else if (r < 0.4) { OT.del(ops, n); left -= n; }
    else { OT.retain(ops, n); left -= n; }
  }
  if (rand() < 0.3) OT.insert(ops, randomString(rand, 4) || 'y');
  return ops;
}

test('apply, insert, delete, retain', () => {
  assert.equal(OT.apply('hello world', [6, 'there ', -5]), 'hello there ');
  assert.throws(() => OT.apply('abc', [2]));
});

test('builders keep a canonical form', () => {
  const ops: OT.Op = [];
  OT.retain(ops, 2); OT.retain(ops, 3);
  OT.del(ops, 1); OT.insert(ops, 'a'); OT.insert(ops, 'b'); OT.del(ops, 2);
  assert.deepEqual(ops, [5, 'ab', -3]);
});

test('isValid rejects malformed operations', () => {
  assert.ok(OT.isValid([1, 'a', -1]));
  assert.ok(!OT.isValid('nope'));
  assert.ok(!OT.isValid([0]));
  assert.ok(!OT.isValid(['']));
  assert.ok(!OT.isValid([1.5]));
  assert.ok(!OT.isValid([{}]));
});

test('fromDiff produces an operation between two strings', () => {
  const rand = rng(1);
  for (let i = 0; i < 500; i++) {
    const a = randomString(rand, 20), b = randomString(rand, 20);
    assert.equal(OT.apply(a, OT.fromDiff(a, b)), b);
  }
});

test('compose matches applying in sequence', () => {
  const rand = rng(2);
  for (let i = 0; i < 1000; i++) {
    const s = randomString(rand, 30);
    const a = randomOp(rand, s);
    const s1 = OT.apply(s, a);
    const b = randomOp(rand, s1);
    assert.equal(OT.apply(s, OT.compose(a, b)), OT.apply(s1, b));
  }
});

test('invert undoes an operation', () => {
  const rand = rng(3);
  for (let i = 0; i < 1000; i++) {
    const s = randomString(rand, 30);
    const a = randomOp(rand, s);
    assert.equal(OT.apply(OT.apply(s, a), OT.invert(s, a)), s);
  }
});

test('transform converges', () => {
  const rand = rng(4);
  for (let i = 0; i < 2000; i++) {
    const s = randomString(rand, 30);
    const a = randomOp(rand, s), b = randomOp(rand, s);
    const [a1, b1] = OT.transform(a, b);
    assert.equal(OT.apply(OT.apply(s, a), b1), OT.apply(OT.apply(s, b), a1));
  }
});

test('transformIndex follows inserts and deletes', () => {
  assert.equal(OT.transformIndex(5, ['abc', 10]), 8);
  assert.equal(OT.transformIndex(5, [5, 'abc', 5]), 5);
  assert.equal(OT.transformIndex(5, [-3, 7]), 2);
  assert.equal(OT.transformIndex(5, [2, -6, 2]), 2);
  assert.equal(OT.transformIndex(5, [6, -4]), 5);
});

// Simulates several clients editing at random with messages delivered in
// random order across clients (but in order per connection, like a socket).
test('clients and server converge under random concurrent editing', () => {
  for (let round = 0; round < 50; round++) {
    const rand = rng(100 + round);
    const initial = randomString(rand, 20);
    const server = new OT.Server(initial, 0);
    const clients: SimClient[] = [];
    for (let c = 0; c < 3; c++) {
      clients.push({ id: 'c' + c, text: initial, ot: new OT.Client(0, initial), toServer: [], fromServer: [] });
    }

    function send(client: SimClient, msg: OT.OpMessage | null) { if (msg) client.toServer.push(msg); }

    for (let step = 0; step < 300; step++) {
      const client = clients[Math.floor(rand() * clients.length)];
      const r = rand();
      if (r < 0.4) {
        const op = randomOp(rand, client.text);
        client.text = OT.apply(client.text, op);
        send(client, client.ot.applyClient(op));
      } else if (r < 0.7 && client.toServer.length) {
        const msg = client.toServer.shift()!;
        const op = server.receive(msg.rev, msg.op, { clientId: client.id, seq: msg.seq });
        for (const other of clients) {
          other.fromServer.push(other === client ? { ack: true as const } : { op });
        }
      } else if (client.fromServer.length) {
        const msg = client.fromServer.shift()!;
        if ('ack' in msg) send(client, client.ot.serverAck());
        else client.text = OT.apply(client.text, client.ot.applyServer(msg.op));
      }
    }

    // Drain everything.
    let busy = true;
    while (busy) {
      busy = false;
      for (const client of clients) {
        while (client.toServer.length) {
          busy = true;
          const msg = client.toServer.shift()!;
          const op = server.receive(msg.rev, msg.op, { clientId: client.id, seq: msg.seq });
          for (const other of clients) other.fromServer.push(other === client ? { ack: true as const } : { op });
        }
        while (client.fromServer.length) {
          busy = true;
          const msg = client.fromServer.shift()!;
          if ('ack' in msg) send(client, client.ot.serverAck());
          else client.text = OT.apply(client.text, client.ot.applyServer(msg.op));
        }
      }
    }

    for (const client of clients) {
      assert.equal(client.text, server.text);
      assert.equal(client.ot.serverText, server.text);
      assert.equal(client.ot.rev, server.rev);
    }
  }
});

test('server rejects bad revisions and operations without changing state', () => {
  const server = new OT.Server('abc', 0);
  assert.throws(() => server.receive(1, [3]));
  assert.throws(() => server.receive(0, [5]));
  assert.throws(() => server.receive(0, 'x'));
  assert.equal(server.text, 'abc');
  assert.equal(server.rev, 0);
  server.receive(0, [3, 'd']);
  assert.deepEqual(server.since(0)!.map((e) => e.op), [[3, 'd']]);
  assert.equal(server.since(5), null);
});
