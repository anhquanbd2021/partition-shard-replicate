import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createStaticServer } from '../app/server.ts';

// End-to-end: boot the real server on an ephemeral port and drive it with
// fetch — pages, API, health, and the stripped model the browser imports.

async function listen() {
  const server = createStaticServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

test('GET / serves the Lab page — nav, hero, and every id the JS queries', async () => {
  const { server, base } = await listen();
  try {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();

    assert.match(html, /<nav aria-label="Primary">/, 'canonical nav present');
    assert.match(html, /aria-current="page" href="\/"/, 'Lab tab is current');
    assert.match(html, /href="\/guide\.html"/, 'Guide tab linked');
    assert.match(html, /class="skip-link"/, 'skip-link first in body');
    assert.match(html, /class="hero"/);

    for (const id of [
      'sumPMachines', 'sumPRows', 'sumSMachines', 'sumSRows', 'sumRMachines', 'sumRRows',
      'btnPrune', 'btnScan', 'partViz', 'partResult',
      'algoModulo', 'algoRendezvous',
      'btnLookup', 'btnJoin', 'btnScatter', 'btnRebalance', 'btnShardReset',
      'shardViz', 'shardResult',
      'btnWrite', 'btnReadReplica', 'btnCatchUp', 'btnReplReset',
      'replViz', 'replResult',
    ]) {
      assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
    }

    assert.match(html, /src="\/app\/app\.js"/, 'UI script wired');
    assert.match(html, /class="pb-shell"/, 'playbook shell present');
    assert.match(html, /class="pb-back"/, 'playbook back-link present');
  } finally {
    server.close();
  }
});

test('GET /guide.html serves the Guide page', async () => {
  const { server, base } = await listen();
  try {
    const res = await fetch(`${base}/guide.html`);
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /<nav aria-label="Primary">/, 'canonical nav present');
    assert.match(html, /aria-current="page" href="\/guide\.html"/, 'Guide tab is current');
    assert.match(html, /class="guide-section"/, 'guide sections present');
    assert.match(html, /class="control-grid"/, 'control grid present');
    assert.match(html, /panel control/, 'control cards present');
    assert.match(html, /<dt>Proves<\/dt>/, 'Proves entries mined for cards');
    assert.match(html, /<dt>Key detail<\/dt>/, 'Key detail entries present');
    assert.match(html, /class="pb-shell"/, 'playbook shell present');
  } finally {
    server.close();
  }
});

test('GET /health and /version', async () => {
  const { server, base } = await listen();
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok');

    const version = await fetch(`${base}/version`);
    assert.equal(version.status, 200);
    const meta = await version.json();
    assert.equal(meta.name, 'partition-shard-replicate-demo');
    assert.ok(meta.version);
  } finally {
    server.close();
  }
});

test('a real API endpoint: /api/summary returns the placement counters', async () => {
  const { server, base } = await listen();
  try {
    const res = await fetch(`${base}/api/summary`);
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.equal(s.rows, 12);
    assert.equal(s.partitioned.machines, 1);
    assert.equal(s.sharded.machines, 3);
    assert.equal(s.replicated.rowsStored, 36);
  } finally {
    server.close();
  }
});

test('/app/*.js serves stripped JS — no TypeScript types leak to the browser', async () => {
  const { server, base } = await listen();
  try {
    const model = await fetch(`${base}/app/storage.js`);
    assert.equal(model.status, 200);
    const src = await model.text();
    assert.doesNotMatch(src, /interface /, 'type annotations stripped');
    assert.match(src, /export function buildSharded/, 'model exports intact');

    const ui = await fetch(`${base}/app/app.js`);
    assert.equal(ui.status, 200);
    assert.doesNotMatch(await ui.text(), /interface /);
  } finally {
    server.close();
  }
});

test('static assets for the new pages resolve', async () => {
  const { server, base } = await listen();
  try {
    for (const path of ['/styles.css', '/tokens.css', '/pb-shell.css', '/pb-back.css']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type') ?? '', /text\/css/, path);
    }
  } finally {
    server.close();
  }
});
