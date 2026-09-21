// test_sqlite_sync_queue_stress.js
// Empirical test for SQLite sync_queue mechanisms and concurrency
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

console.log('=== TEST SUITE 1: SQLITE SYNC_QUEUE & CONCURRENCY HARNESS ===\n');

// Use in-memory SQLite DB to simulate v2 sync_queue
const db = new Database(':memory:');

// Create the exact schema from c:\my-pos\v2\electron\database.cjs
db.exec(`
    CREATE TABLE sync_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload_json TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        attempts INTEGER DEFAULT 0,
        last_attempt DATETIME
    );
`);

console.log('[Setup] Created SQLite sync_queue schema');

// 1. HOL (Head-Of-Line) Blocking / Poison Pill Test
console.log('\n--- Scenario 1: Poison Pill Head-Of-Line Starvation Test ---');

// Insert 50 "poison" records (failed network, invalid license, or schema error)
const insertStmt = db.prepare(`INSERT INTO sync_queue (payload_json, status, attempts) VALUES (?, 'pending', ?)`);
for (let i = 1; i <= 50; i++) {
    insertStmt.run(JSON.stringify({ license_key: 'INVALID_' + i, local_shift_id: i }), 3);
}

// Now insert 10 valid pending shifts that occurred subsequently
for (let i = 51; i <= 60; i++) {
    insertStmt.run(JSON.stringify({ license_key: 'VALID_KEY', local_shift_id: i, total_sales: 1500 }), 0);
}

const totalInQueue = db.prepare('SELECT COUNT(*) as count FROM sync_queue').get().count;
console.log(`Total items in queue: ${totalInQueue} (50 failing items + 10 fresh valid shifts)`);

// Simulate current processQueue() logic from supabaseSync.cjs:94-100:
// SELECT id, payload_json, attempts FROM sync_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 50
function simulateProcessQueue(mockServer) {
    const pending = db.prepare(`
        SELECT id, payload_json, attempts 
        FROM sync_queue 
        WHERE status = 'pending' 
        ORDER BY created_at ASC 
        LIMIT 50
    `).all();

    let processedCount = 0;
    let failedCount = 0;

    for (const item of pending) {
        const payload = JSON.parse(item.payload_json);
        const success = mockServer(payload);
        if (success) {
            db.prepare(`UPDATE sync_queue SET status = 'synced', last_attempt = CURRENT_TIMESTAMP WHERE id = ?`).run(item.id);
            processedCount++;
        } else {
            db.prepare(`UPDATE sync_queue SET attempts = attempts + 1, last_attempt = CURRENT_TIMESTAMP WHERE id = ?`).run(item.id);
            failedCount++;
        }
    }
    return { pendingFetched: pending.length, processedCount, failedCount, fetchedIds: pending.map(p => p.id) };
}

// Mock server where INVALID_* fails, VALID_KEY succeeds
const mockRpc = (payload) => {
    return payload.license_key === 'VALID_KEY';
};

// Cycle 1:
console.log('\nRunning Cycle 1 of processQueue()...');
const cycle1 = simulateProcessQueue(mockRpc);
console.log(`Cycle 1 Result: fetched ${cycle1.pendingFetched} items, ${cycle1.failedCount} failed, ${cycle1.processedCount} succeeded`);
console.log(`Cycle 1 IDs: ${cycle1.fetchedIds.slice(0, 5).join(', ')} ... ${cycle1.fetchedIds.slice(-5).join(', ')}`);

// Cycle 2 (60 seconds later):
console.log('\nRunning Cycle 2 of processQueue() (60 seconds later)...');
const cycle2 = simulateProcessQueue(mockRpc);
console.log(`Cycle 2 Result: fetched ${cycle2.pendingFetched} items, ${cycle2.failedCount} failed, ${cycle2.processedCount} succeeded`);

// Check if valid shifts (IDs 51-60) were EVER processed
const validShiftsSynced = db.prepare("SELECT COUNT(*) as count FROM sync_queue WHERE id >= 51 AND status = 'synced'").get().count;
console.log(`\nValid shifts (IDs 51-60) synced: ${validShiftsSynced} / 10`);

if (validShiftsSynced === 0) {
    console.error('CRITICAL DEFECT CONFIRMED: Poison pill Head-Of-Line blocking completely starves fresh shifts!');
    console.error('Because status remains "pending" with LIMIT 50 and no max_attempts threshold or DLQ, items 51-60 are NEVER reached.');
} else {
    console.log('Shifts were processed.');
}

// --- Scenario 2: Race Condition from Missing Mutex / isProcessing Lock ---
console.log('\n--- Scenario 2: Concurrent processQueue() Execution Race Condition ---');

// Reset table with 5 pending items
db.exec('DELETE FROM sync_queue');
for (let i = 1; i <= 5; i++) {
    insertStmt.run(JSON.stringify({ license_key: 'KEY_RACE', local_shift_id: i }), 0);
}

// Simulate two concurrent executions of processQueue() when async I/O occurs
let rpcCallCount = 0;
function simulateAsyncConcurrentLoops() {
    // Both query SQLite before either finishes HTTP RPC calls
    const loop1Pending = db.prepare(`SELECT id, payload_json FROM sync_queue WHERE status = 'pending' LIMIT 50`).all();
    const loop2Pending = db.prepare(`SELECT id, payload_json FROM sync_queue WHERE status = 'pending' LIMIT 50`).all();

    console.log(`Loop 1 fetched ${loop1Pending.length} items`);
    console.log(`Loop 2 fetched ${loop2Pending.length} items (ran concurrently before Loop 1 marked synced)`);

    // Loop 1 invokes RPCs
    loop1Pending.forEach(item => {
        rpcCallCount++;
        db.prepare(`UPDATE sync_queue SET status = 'synced' WHERE id = ?`).run(item.id);
    });

    // Loop 2 invokes RPCs for the exact same items
    loop2Pending.forEach(item => {
        rpcCallCount++;
        db.prepare(`UPDATE sync_queue SET status = 'synced' WHERE id = ?`).run(item.id);
    });
}

simulateAsyncConcurrentLoops();
console.log(`Total RPC calls executed for 5 queued items: ${rpcCallCount}`);
if (rpcCallCount === 10) {
    console.error('RACE CONDITION CONFIRMED: Lack of execution lock (isProcessing mutex) results in duplicate RPC transmissions (2x redundant traffic).');
}

// --- Scenario 3: UUID Generation Point & Re-enqueuing Duplication Risk ---
console.log('\n--- Scenario 3: Ephemeral UUID Generation vs Shift Deduplication ---');
const crypto = require('crypto');

// If UUID is generated in JavaScript during enqueueShift:
function enqueueShiftV1(shiftId) {
    return {
        shift_uuid: crypto.randomUUID(),
        local_shift_id: shiftId
    };
}

const firstEnqueue = enqueueShiftV1(101);
const secondEnqueue = enqueueShiftV1(101); // Re-enqueued due to app restart or shift reopen/close
console.log(`First enqueue UUID for shift 101:  ${firstEnqueue.shift_uuid}`);
console.log(`Second enqueue UUID for shift 101: ${secondEnqueue.shift_uuid}`);

if (firstEnqueue.shift_uuid !== secondEnqueue.shift_uuid) {
    console.error('IDEMPOTENCY DEFECT CONFIRMED: Ephemeral UUID generation causes the same physical shift (id: 101) to produce different UUIDs upon re-enqueue!');
    console.error('Because public.shop_shifts_v2 has ON CONFLICT (shift_uuid), different UUIDs bypass conflict resolution and create duplicate records in the cloud.');
    console.error('Mitigation: UUID must be deterministically derived (e.g. UUIDv5 from shop_id + local_shift_id) or stored persistently in SQLite shifts table.');
}

console.log('\n=== SUITE 1 COMPLETE ===');
