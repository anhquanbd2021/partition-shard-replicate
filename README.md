# Placement Lab — companion demo

Interactive lab for the article on **partitioning vs sharding vs
replication**. The same 12 rows under three arrangements — count the dots
and the difference is obvious: 12 vs 12 vs 36 rows stored, 1 vs 3 machines.

Two tabs: **Lab** (`/`) runs the three arrangements and triggers each
failure mode on demand; **Guide** (`/guide.html`) explains what each
feature proves, what it costs, and where the model's limits are.

Zero dependencies — Node 24+ only. The placement model in
`app/storage.ts` is the single source of truth: the server strips its type
annotations and serves it to the browser, and the test suite exercises the
exact same module.

## What it proves

| Claim | How the lab proves it |
|---|---|
| **Partitioning manages, it doesn't scale** | One server holds 3 partitions. `region = 'eu'` prunes to 4 rows; `amount > 60` scans all 3 partitions — and either way it's 1 machine's write throughput. |
| **Sharding scales writes + storage** | A hash spreads 12 rows over 3 machines (4 each). `Lookup row-004` touches 1 shard; joining across shards pays a network hop; a query without the key fans out to all 3. |
| **Rebalancing is the hidden cost** | Add a 4th shard: `hash % N` moves 8/12 rows; rendezvous hashing moves 2/12. |
| **Replication survives, but reads can lag** | Write `row-005 → v2` on the primary, read `replica-2` before the stream catches up — stale read, on demand. |

## Run it

```text
npm start      # serve the lab on http://localhost:3000
npm test       # placement model + failure modes + HTTP layer (unit + e2e)
npm run check  # same as npm test (used by render.yaml)
```

Repo: https://github.com/anhquanbd2021/partition-shard-replicate

## Honest limits

This is a deterministic in-memory model, not a database. "Replication lag"
is a queue, "network hops" are counters, and the hash functions are FNV-1a.
It exists to make the placement mechanics legible — the numbers (12/12/36
rows, 1/3 machines, 8 vs 2 rows moved) are real outputs of the model, not
illustrations.
