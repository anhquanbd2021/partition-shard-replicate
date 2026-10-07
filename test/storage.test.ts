import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  ROWS,
  buildPartitioned,
  runPartitionQuery,
  buildSharded,
  pointLookup,
  scatterGather,
  crossShardJoin,
  rebalance,
  buildReplicated,
  replicatedWrite,
  replicateTick,
  replicatedRead,
  placementSummary,
} from '../app/storage.ts';
import { createStaticServer } from '../app/server.ts';

test('the counters tell the story: 12 vs 12 vs 36 rows, 1 vs 3 machines', () => {
  const s = placementSummary();
  assert.equal(s.partitioned.machines, 1);
  assert.equal(s.partitioned.rowsStored, 12);
  assert.equal(s.sharded.machines, 3);
  assert.equal(s.sharded.rowsStored, 12);
  assert.equal(s.replicated.machines, 3);
  assert.equal(s.replicated.rowsStored, 36);
});

test('partitioning: a query on the partition key prunes; off the key it scans all', () => {
  const state = buildPartitioned();
  assert.equal(state.machines, 1);
  assert.deepEqual(state.partitions.map(p => p.rows.length), [4, 4, 4]);

  const pruned = runPartitionQuery(state, { field: 'region', op: '=', value: 'eu' });
  assert.equal(pruned.pruned, true);
  assert.equal(pruned.partitionsScanned, 1);
  assert.equal(pruned.rowsScanned, 4);
  assert.equal(pruned.machinesTouched, 1, 'pruning still runs on one machine');

  const scanned = runPartitionQuery(state, { field: 'amount', op: '>', value: 60 });
  assert.equal(scanned.pruned, false);
  assert.equal(scanned.partitionsScanned, 3, 'no partition key → every partition scanned');
  assert.equal(scanned.rowsScanned, 12);
});

test('sharding: a hash splits rows evenly across machines; lookups touch one shard', () => {
  const state = buildSharded(ROWS, 3, 'modulo');
  assert.deepEqual(state.shards.map(s => s.rows.length), [4, 4, 4]);

  const hit = pointLookup(state, 'row-004');
  assert.equal(hit.networkHops, 1);
  assert.equal(hit.shardsTouched.length, 1);

  const scatter = scatterGather(state);
  assert.equal(scatter.networkHops, 3, 'no shard key → fan out to every shard');
  assert.equal(scatter.rowsScanned, 12);
});

test('sharding: a cross-shard join pays a network hop per row pair', () => {
  const state = buildSharded(ROWS, 3, 'modulo');
  const j = crossShardJoin(state, 'row-001', 'row-007');
  assert.equal(j.colocated, false, 'fixture pair must live on different shards');
  assert.equal(j.networkHops, 1);
});

test('the failure mode: modulo rebalancing moves most rows; rendezvous moves few', () => {
  const modulo = buildSharded(ROWS, 3, 'modulo');
  const rbMod = rebalance(modulo, 4);
  assert.equal(rbMod.total, 12);
  assert.equal(rbMod.moved, 8, 'hash % N remaps most keys when N changes');
  assert.ok(rbMod.movedPct > 50);

  const rv = buildSharded(ROWS, 3, 'rendezvous');
  const rbRv = rebalance(rv, 4);
  assert.equal(rbRv.moved, 2, 'rendezvous only moves rows the new shard attracts');
  assert.ok(rbRv.movedPct < 30);
});

test('replication: every node stores every row; a fresh write is stale on replicas', () => {
  const state = buildReplicated(ROWS, 3);
  assert.equal(state.nodes.length, 3);
  for (const n of state.nodes) assert.equal(n.rows.size, 12, 'nothing is split');

  replicatedWrite(state, 'row-005', 140);

  const fresh = replicatedRead(state, 0, 'row-005');
  assert.equal(fresh.version, 2);
  assert.equal(fresh.stale, false);

  const lagging = replicatedRead(state, 2, 'row-005');
  assert.equal(lagging.version, 1, 'replica still serves the old row');
  assert.equal(lagging.stale, true, 'read-your-writes is violated on a lagging replica');

  replicateTick(state);
  const caughtUp = replicatedRead(state, 2, 'row-005');
  assert.equal(caughtUp.stale, false);
  assert.equal(caughtUp.version, 2);
});

async function listen() {
  const server = createStaticServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

test('/health, /version, /api/summary, /app/storage.js, and 404', async () => {
  const server = await listen();
  const port = server.address().port;
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok');

    const version = await fetch(`http://127.0.0.1:${port}/version`);
    const meta = await version.json();
    assert.equal(meta.name, 'partition-shard-replicate-demo');

    const summary = await fetch(`http://127.0.0.1:${port}/api/summary`);
    assert.equal(summary.status, 200);
    const s = await summary.json();
    assert.equal(s.replicated.rowsStored, 36);
    assert.equal(s.partitioned.machines, 1);

    const model = await fetch(`http://127.0.0.1:${port}/app/storage.js`);
    assert.equal(model.status, 200);
    const src = await model.text();
    assert.match(src, /export function buildSharded/, 'browser gets the same stripped model');
    assert.doesNotMatch(src, /interface Row/, 'type annotations are stripped');

    for (const path of ['/', '/tokens.css', '/app/app.js', '/api/rows']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(res.status, 200, path);
    }

    for (const path of ['/package.json', '/app/storage.ts', '/nope']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(res.status, 404, path);
    }
  } finally {
    server.close();
  }
});
