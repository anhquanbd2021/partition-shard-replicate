// app.js — DOM wiring for Placement Lab.
// Plain JavaScript on purpose: browsers cannot strip TypeScript types and
// this project has no build step, so the UI glue is the documented .js
// exception. The domain model it imports (/app/storage.js) is generated
// from app/storage.ts by the server — the same module the tests exercise.

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
} from '/app/storage.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// --- Shared rendering ------------------------------------------------------

const dot = (row, extra = '') =>
  `<span class="dot ${row.region} ${extra}" title="${esc(row.id)} · ${row.region} · $${row.amount} · v${row.version}" data-row="${esc(row.id)}">${esc(row.id.slice(-2))}</span>`;

function setResult(el, html, bad = false) {
  el.innerHTML = html;
  el.classList.toggle('bad', bad);
}

// --- Summary counters (served by the API — the server runs this model) -----

async function renderSummary() {
  let s;
  try {
    s = await (await fetch('/api/summary')).json();
  } catch {
    s = placementSummary();
  }
  $('sumPMachines').textContent = s.partitioned.machines;
  $('sumPRows').textContent = s.partitioned.rowsStored;
  $('sumSMachines').textContent = s.sharded.machines;
  $('sumSRows').textContent = s.sharded.rowsStored;
  $('sumRMachines').textContent = s.replicated.machines;
  $('sumRRows').textContent = s.replicated.rowsStored;
}

// --- 1 · Partitioning ------------------------------------------------------

const partState = buildPartitioned();
let lastPartQuery = null;

function renderPartitions() {
  const onKey = lastPartQuery?.field === 'region';
  const keyPart = onKey ? `p_${lastPartQuery.value}` : null;
  const parts = partState.partitions.map(p => {
    const cls = !lastPartQuery ? 'part'
      : p.name === keyPart ? 'part hit'
      : !onKey ? 'part scanned' : 'part';
    return `<div class="${cls}"><div class="pname">${esc(p.name)} · ${p.rows.length} rows</div>
      <div class="dots">${p.rows.map(r => dot(r)).join('')}</div></div>`;
  }).join('');
  $('partViz').innerHTML = `<div class="server"><div class="sname">db-1 — the only machine (1 CPU · 1 disk)</div>${parts}</div>`;
}

function runPartition(field, op, value, label) {
  lastPartQuery = { field, op, value };
  const r = runPartitionQuery(partState, lastPartQuery);
  renderPartitions();
  const prunedMsg = r.pruned
    ? `Pruned ${r.partitionsTotal - r.partitionsScanned} of ${r.partitionsTotal} partitions — scanned ${r.rowsScanned} rows on 1 machine.`
    : `No partition key in the query — scanned all ${r.partitionsScanned}/${r.partitionsTotal} partitions, all ${r.rowsScanned} rows. Partitioning bought nothing here.`;
  setResult($('partResult'), `${esc(label)} → ${r.matched} matched. ${prunedMsg} Still 1 machine's write throughput either way.`, !r.pruned);
}

// --- 2 · Sharding ----------------------------------------------------------

let shardAlgo = 'modulo';
let shardState = buildSharded(ROWS, 3, shardAlgo);
let movedSet = new Set();

function renderShards() {
  const boxes = shardState.shards.map((sh, s) =>
    `<div class="server"><div class="sname">${esc(sh.name)} — own machine · ${sh.rows.length} rows</div>
      <div class="dots">${sh.rows.map(r => dot(r, movedSet.has(r.id) ? 'moved' : '')).join('')}</div></div>`
  ).join('');
  $('shardViz').innerHTML = `<div class="legend">placement: <code>${shardAlgo === 'modulo' ? 'hash(id) % ' + shardState.shardCount : 'rendezvous max hash(id|shard)'}</code></div>${boxes}`;
}

function describeShards(res, label, bad) {
  setResult($('shardResult'), label + ' → ' + res, bad);
}

$('btnLookup').addEventListener('click', () => {
  const r = pointLookup(shardState, 'row-004');
  describeShards(`Shard ${r.shard} answered alone — ${r.networkHops} hop, ${r.rowsScanned} rows on that shard`, `Lookup row-004`, false);
});

$('btnJoin').addEventListener('click', () => {
  const j = crossShardJoin(shardState, 'row-001', 'row-007');
  describeShards(
    j.colocated
      ? `Both rows on shard ${j.shards[0]} — local join, 0 network hops.`
      : `row-001 lives on shard ${j.shards[0]}, row-007 on shard ${j.shards[1]} — the join needs ${j.networkHops} network hop per pair. A join-heavy workload pays this on every row pair.`,
    'Join row-001 ⋈ row-007',
    !j.colocated);
});

$('btnScatter').addEventListener('click', () => {
  const r = scatterGather(shardState);
  describeShards(`No shard key — fanned out to all ${r.networkHops} shards, scanned ${r.rowsScanned} rows, merged 3 partial results. The query runs at the speed of the slowest shard.`, 'Join all rows by region', true);
});

$('btnRebalance').addEventListener('click', () => {
  if (shardState.shardCount !== 3) return;
  const rb = rebalance(shardState, 4);
  movedSet = new Set(rb.movedRows);
  shardState = rb.next;
  renderShards();
  describeShards(
    `${rb.moved}/${rb.total} rows moved (${rb.movedPct}%) with <code>${rb.algo === 'modulo' ? 'hash % N' : 'rendezvous'}</code>. ${rb.algo === 'modulo'
      ? 'Modulo remaps almost every key when N changes — that is why resharding a live table hurts. Try rendezvous.'
      : 'Only the rows the new shard attracts moved — consistent-hash-style placement keeps resharding cheap.'}`,
    'Rebalance 3 → 4 shards',
    rb.movedPct > 50);
});

$('btnShardReset').addEventListener('click', () => {
  shardState = buildSharded(ROWS, 3, shardAlgo);
  movedSet = new Set();
  renderShards();
  setResult($('shardResult'), 'Back to 3 shards.');
});

function setAlgo(algo) {
  shardAlgo = algo;
  shardState = buildSharded(ROWS, 3, shardAlgo);
  movedSet = new Set();
  renderShards();
  $('algoModulo').classList.toggle('on', algo === 'modulo');
  $('algoRendezvous').classList.toggle('on', algo === 'rendezvous');
  $('algoModulo').setAttribute('aria-pressed', String(algo === 'modulo'));
  $('algoRendezvous').setAttribute('aria-pressed', String(algo === 'rendezvous'));
}
$('algoModulo').addEventListener('click', () => setAlgo('modulo'));
$('algoRendezvous').addEventListener('click', () => setAlgo('rendezvous'));

// --- 3 · Replication -------------------------------------------------------

let replState = buildReplicated();
let lastWrittenId = null;

function renderReplicas() {
  const primaryVersion = id => replState.nodes[0].rows.get(id)?.version ?? 0;
  const boxes = replState.nodes.map((node, n) => {
    const dots = [...node.rows.values()].map(r => {
      const cls = r.id === lastWrittenId
        ? (r.version < primaryVersion(r.id) ? 'stale' : 'fresh')
        : '';
      return dot(r, cls);
    }).join('');
    const lagging = lastWrittenId && n > 0 && (node.rows.get(lastWrittenId)?.version ?? 0) < primaryVersion(lastWrittenId);
    return `<div class="server${lagging ? ' fail' : ''}"><div class="sname">${esc(node.name)} — ${node.role}${lagging ? ' · LAGGING' : ''} · ${node.rows.size} rows</div>
      <div class="dots">${dots}</div></div>`;
  }).join('');
  const pending = replState.pending.length;
  $('replViz').innerHTML = `${boxes}<div class="legend">${pending} write${pending === 1 ? '' : 's'} queued in the replication stream</div>`;
}

$('btnWrite').addEventListener('click', () => {
  replicatedWrite(replState, 'row-005', 140);
  lastWrittenId = 'row-005';
  renderReplicas();
  setResult($('replResult'), 'Write committed on the primary (row-005 → v2). Replicas are still on v1 — the stream has not caught up. Now read a replica.');
});

$('btnReadReplica').addEventListener('click', () => {
  const r = replicatedRead(replState, 2, 'row-005');
  renderReplicas();
  setResult(
    $('replResult'),
    r.stale
      ? `replica-2 returned row-005 at v${r.version} ($${r.amount}) — but the primary is at v${r.primaryVersion}. Stale read: the replica is a few ms behind. This is the price of surviving node failure.`
      : `replica-2 returned row-005 at v${r.version} — caught up with the primary. Stale reads are a timing window, not a permanent state.`,
    r.stale);
});

$('btnCatchUp').addEventListener('click', () => {
  const applied = replicateTick(replState);
  renderReplicas();
  setResult($('replResult'), applied > 0
    ? `Replication tick applied ${applied} pending write${applied === 1 ? '' : 's'} — every node now agrees at v2.`
    : 'Nothing queued — replicas already match the primary.');
});

$('btnReplReset').addEventListener('click', () => {
  replState = buildReplicated();
  lastWrittenId = null;
  renderReplicas();
  setResult($('replResult'), 'Cluster reset — all 3 nodes identical at v1.');
});

// --- Init ------------------------------------------------------------------

$('btnPrune').addEventListener('click', () => runPartition('region', '=', 'eu', "Query: region = 'eu'"));
$('btnScan').addEventListener('click', () => runPartition('amount', '>', 60, 'Query: amount > 60'));

renderSummary();
renderPartitions();
renderShards();
renderReplicas();
