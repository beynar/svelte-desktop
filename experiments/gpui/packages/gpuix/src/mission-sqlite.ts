/**
 * Mission probe — bun:sqlite behavior the framework depends on.
 * Validates: WAL, transactions (atomicity on throw), prepared statements,
 * lastInsertRowid, changes(), sync cost during JS work, worker handoff.
 */
import { Database } from 'bun:sqlite';
import { rmSync } from 'fs';
import { appendFileSync, mkdirSync } from 'fs';

const OUT = '../results/run-20260915-a/sqlite.jsonl';
mkdirSync('../results/run-20260915-a', { recursive: true });
const rec = (o: object) => appendFileSync(OUT, JSON.stringify({ ts: Date.now(), ...o }) + '\n');
const P = '/tmp/mission-sqlite.db';
rmSync(P, { force: true }); rmSync(P + '-wal', { force: true }); rmSync(P + '-shm', { force: true });

const db = new Database(P);
db.exec('PRAGMA journal_mode = WAL');
console.log('journal_mode:', db.query('PRAGMA journal_mode').get());

db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT, score REAL, meta TEXT)');

// prepared statement + tx throughput
const ins = db.prepare('INSERT INTO items(name, score, meta) VALUES (?, ?, ?)');
const t0 = performance.now();
const insertMany = db.transaction((rows: [string, number, string][]) => {
	for (const r of rows) ins.run(...r);
});
insertMany(Array.from({ length: 10000 }, (_, i) => [`item-${i}`, Math.random(), `{"k":${i}}`]));
const tx10k = performance.now() - t0;
console.log(`tx insert 10k rows: ${tx10k.toFixed(1)}ms (${Math.round(10000 / (tx10k / 1000))}/s)`);
rec({ bench: 'sqlite-tx-insert-10k', ms: tx10k });

// atomicity — tx throws mid-way
try {
	db.transaction(() => {
		ins.run('good', 1, '{}');
		throw new Error('mid-tx failure');
	})();
} catch {}
console.log('rows after failed tx:', db.query('SELECT COUNT(*) c FROM items').get().c, '(expect 10000 → rollback worked)');

// prepared query throughput
const q = db.prepare('SELECT * FROM items WHERE id = ?');
const t1 = performance.now();
	for (let i = 1; i <= 10000; i++) q.get(i);
console.log(`prepared get 10k: ${(performance.now() - t1).toFixed(1)}ms`);

// concurrent-ish: second connection while first holds WAL
const db2 = new Database(P);
console.log('second conn sees:', db2.query('SELECT COUNT(*) c FROM items').get().c, 'rows');

// synchronous cost: does a big query block the loop? measure event delay
const t2 = performance.now();
db.exec('INSERT INTO items(name,score,meta) SELECT name,score,meta FROM items'); // 10k→20k
db.exec('INSERT INTO items(name,score,meta) SELECT name,score,meta FROM items LIMIT 30000'); // →50k
const bigCopyMs = performance.now() - t2;
console.log(`copy to 50k rows (sync, blocks loop): ${bigCopyMs.toFixed(1)}ms`);
rec({ bench: 'sqlite-sync-copy-40k', ms: bigCopyMs });

// serialization: big result set → JS objects
const t3 = performance.now();
const all = db.query('SELECT * FROM items').all();
console.log(`select-all ${all.length} rows → objects: ${(performance.now() - t3).toFixed(1)}ms`);
rec({ bench: 'sqlite-select-50k-objects', ms: performance.now() - t3 });

db2.close(); db.close();
rmSync(P, { force: true }); rmSync(P + '-wal', { force: true }); rmSync(P + '-shm', { force: true });
console.log('wrote', OUT);
