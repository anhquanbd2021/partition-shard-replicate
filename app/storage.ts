// Placement Lab — the data-placement model.
// The same 12 rows under three arrangements: partitioning (chunks inside
// one database), sharding (rows spread across machines by hash), and
// replication (a full copy on every node). Shared by the browser UI, the
// server, and the test suite — deterministic and inspectable.

export interface Row {
  id: string;
  region: 'us' | 'eu' | 'ap';
  amount: number;
  version: number;
}

// 12 rows, four per region. `id` is the shard key; `region` is the
// partition key. Chosen so fnv1a(id) % 3 lands exactly 4 rows per shard.
export const ROWS: Row[] = [
  { id: 'row-001', region: 'us', amount: 42,  version: 1 },
  { id: 'row-002', region: 'eu', amount: 7,   version: 1 },
  { id: 'row-003', region: 'ap', amount: 91,  version: 1 },
  { id: 'row-004', region: 'us', amount: 66,  version: 1 },
  { id: 'row-005', region: 'eu', amount: 120, version: 1 },
  { id: 'row-006', region: 'ap', amount: 15,  version: 1 },
  { id: 'row-007', region: 'us', amount: 33,  version: 1 },
  { id: 'row-008', region: 'eu', amount: 58,  version: 1 },
  { id: 'row-009', region: 'ap', amount: 74,  version: 1 },
  { id: 'row-010', region: 'us', amount: 9,   version: 1 },
  { id: 'row-011', region: 'eu', amount: 101, version: 1 },
  { id: 'row-012', region: 'ap', amount: 50,  version: 1 },
];

export const REGIONS = ['us', 'eu', 'ap'] as const;

// --- Placement primitives -------------------------------------------------

// FNV-1a — a small deterministic hash. Any stable hash works; what matters
// is that the *same function* decides placement for writes and reads.
export function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type ShardAlgo = 'modulo' | 'rendezvous';
export const SHARD_ALGOS = ['modulo', 'rendezvous'] as const;

// Modulo placement: shard = hash(key) % N. Balanced, but changing N
// remaps almost every key — the classic "resharding is expensive" trap.
export function moduloShard(id: string, shardCount: number): number {
  return hashKey(id) % shardCount;
}

// Rendezvous (highest-random-weight) placement: score every candidate
// shard against the key, take the max. Adding a shard only moves the keys
// that now prefer the new shard — roughly 1/N of the data, not most of it.
// The seed keeps the lab's 3-shard spread balanced (4/4/4) on this fixture.
const RV_SEED = 69;

export function rendezvousShard(id: string, shardCount: number): number {
  let best = 0;
  let bestScore = -1;
  for (let s = 0; s < shardCount; s++) {
    const score = hashKey(`${id}|${RV_SEED}|${s}`);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}

export function placeRow(id: string, shardCount: number, algo: ShardAlgo = 'modulo'): number {
  return algo === 'rendezvous' ? rendezvousShard(id, shardCount) : moduloShard(id, shardCount);
}

// --- Arrangement 1: partitioning ------------------------------------------
// One server, one table split into partitions by `region`. Pruning works
// only when the query carries the partition key.

export interface PartitionedState {
  machines: 1;
  partitions: { name: string; rows: Row[] }[];
}

export function buildPartitioned(rows: Row[] = ROWS): PartitionedState {
  return {
    machines: 1,
    partitions: REGIONS.map(region => ({
      name: `p_${region}`,
      rows: rows.filter(r => r.region === region),
    })),
  };
}

export interface PartitionQuery {
  field: 'region' | 'amount';
  op: '=' | '>';
  value: string | number;
}

export interface QueryResult {
  pruned: boolean;
  partitionsScanned: number;
  partitionsTotal: number;
  rowsScanned: number;
  machinesTouched: number;
  matched: number;
}

export function runPartitionQuery(state: PartitionedState, q: PartitionQuery): QueryResult {
  const onKey = q.field === 'region';
  const targets = onKey
    ? state.partitions.filter(p => p.name === `p_${q.value}`)
    : state.partitions;
  const match = (r: Row) =>
    q.field === 'region' ? r.region === q.value : r.amount > Number(q.value);
  const rowsScanned = targets.reduce((n, p) => n + p.rows.length, 0);
  return {
    pruned: onKey,
    partitionsScanned: targets.length,
    partitionsTotal: state.partitions.length,
    rowsScanned,
    machinesTouched: 1,
    matched: targets.reduce((n, p) => n + p.rows.filter(match).length, 0),
  };
}

// --- Arrangement 2: sharding ----------------------------------------------
// Separate machines; a hash of the row id decides which server owns the
// row. Point lookups touch one shard; anything else fans out.

export interface ShardedState {
  shardCount: number;
  algo: ShardAlgo;
  shards: { name: string; rows: Row[] }[];
}

export function buildSharded(
  rows: Row[] = ROWS,
  shardCount = 3,
  algo: ShardAlgo = 'modulo',
): ShardedState {
  const shards = Array.from({ length: shardCount }, (_, s) => ({
    name: `shard-${s}`,
    rows: [] as Row[],
  }));
  for (const r of rows) shards[placeRow(r.id, shardCount, algo)].rows.push(r);
  return { shardCount, algo, shards };
}

export function shardOf(state: ShardedState, id: string): number {
  return placeRow(id, state.shardCount, state.algo);
}

// A point lookup carries the shard key: one hop, one shard.
export function pointLookup(state: ShardedState, id: string) {
  const s = shardOf(state, id);
  return { id, shard: s, shardsTouched: [s], networkHops: 1, rowsScanned: state.shards[s].rows.length };
}

// A query without the shard key must ask every shard — scatter-gather.
export function scatterGather(state: ShardedState) {
  return {
    shardsTouched: state.shards.map((_, s) => s),
    networkHops: state.shardCount,
    rowsScanned: state.shards.reduce((n, sh) => n + sh.rows.length, 0),
  };
}

// Joining two rows on different shards costs a network hop per pair;
// on the same shard it is a local join.
export function crossShardJoin(state: ShardedState, idA: string, idB: string) {
  const a = shardOf(state, idA);
  const b = shardOf(state, idB);
  return {
    pair: [idA, idB],
    shards: [a, b],
    colocated: a === b,
    networkHops: a === b ? 0 : 1,
  };
}

// Rebalance to a new shard count and count how many rows must move.
// `movedRows` is the cost of resharding — with modulo it is most of the
// table; with rendezvous it is only the rows the new shard attracts.
export function rebalance(state: ShardedState, newShardCount: number) {
  const next = buildSharded(state.shards.flatMap(s => s.rows), newShardCount, state.algo);
  const movedRows: string[] = [];
  for (const sh of next.shards) {
    for (const r of sh.rows) {
      if (placeRow(r.id, state.shardCount, state.algo) !== placeRow(r.id, newShardCount, state.algo)) {
        movedRows.push(r.id);
      }
    }
  }
  const total = state.shards.reduce((n, s) => n + s.rows.length, 0);
  return {
    from: state.shardCount,
    to: newShardCount,
    algo: state.algo,
    movedRows,
    moved: movedRows.length,
    total,
    movedPct: Math.round((movedRows.length / total) * 100),
    next,
  };
}

// --- Arrangement 3: replication --------------------------------------------
// Every node holds every row. Writes go to the primary and stream to
// replicas asynchronously — so a replica can answer from an older version.

export interface ReplicaNode {
  name: string;
  role: 'primary' | 'replica';
  rows: Map<string, Row>;
}

export interface ReplicatedState {
  nodes: ReplicaNode[];
  pending: { node: number; id: string; row: Row }[];
}

const clone = (r: Row): Row => ({ ...r });

export function buildReplicated(rows: Row[] = ROWS, nodeCount = 3): ReplicatedState {
  return {
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      name: i === 0 ? 'primary' : `replica-${i}`,
      role: i === 0 ? 'primary' : 'replica',
      rows: new Map(rows.map(r => [r.id, clone(r)])),
    })),
    pending: [],
  };
}

// Write lands on the primary instantly and is queued for each replica —
// the queue depth IS the replication lag.
export function replicatedWrite(state: ReplicatedState, id: string, amount: number): void {
  const primary = state.nodes[0];
  const prev = primary.rows.get(id);
  if (!prev) throw new Error(`unknown row ${id}`);
  const row = { ...prev, amount, version: prev.version + 1 };
  primary.rows.set(id, row);
  for (let n = 1; n < state.nodes.length; n++) {
    state.pending.push({ node: n, id, row: clone(row) });
  }
}

// One replication tick: every replica applies its next pending write.
export function replicateTick(state: ReplicatedState): number {
  let applied = 0;
  for (let n = 1; n < state.nodes.length; n++) {
    const idx = state.pending.findIndex(p => p.node === n);
    if (idx !== -1) {
      const p = state.pending.splice(idx, 1)[0];
      state.nodes[n].rows.set(p.id, clone(p.row));
      applied++;
    }
  }
  return applied;
}

// Read from any node. A read right after a write can hit a lagging replica
// and return a stale row — the failure mode the post warns about.
export function replicatedRead(state: ReplicatedState, nodeIndex: number, id: string) {
  const node = state.nodes[nodeIndex];
  const row = node.rows.get(id);
  const primaryVersion = state.nodes[0].rows.get(id)?.version ?? 0;
  if (!row) throw new Error(`unknown row ${id}`);
  return {
    node: node.name,
    id,
    amount: row.amount,
    version: row.version,
    primaryVersion,
    stale: row.version < primaryVersion,
  };
}

// --- The counters that tell the story --------------------------------------

export function placementSummary() {
  const sharded = buildSharded();
  const replicated = buildReplicated();
  return {
    rows: ROWS.length,
    partitioned: {
      machines: 1,
      rowsStored: ROWS.length,
      partitions: REGIONS.length,
      note: 'chunks of one table, one machine',
    },
    sharded: {
      machines: sharded.shardCount,
      rowsStored: ROWS.length,
      partitions: sharded.shardCount,
      note: 'a hash decides which machine owns each row',
    },
    replicated: {
      machines: replicated.nodes.length,
      rowsStored: ROWS.length * replicated.nodes.length,
      partitions: 1,
      note: 'every node stores every row',
    },
  };
}
