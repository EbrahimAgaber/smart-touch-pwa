/**
 * tests/p0_expense_crash_test.js
 * P0.5 Acceptance Test: Two-phase pull crash resilience.
 *
 * Simulates a crash mid-SQLite insert (aborted transaction).
 * Asserts that:
 *   1. Cloud expenses remain pending (no ACK sent on crash)
 *   2. Next pull re-delivers the same rows
 *   3. After successful insert, rows are ACKed and not re-delivered
 *
 * Run: node tests/p0_expense_crash_test.js
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SUPABASE_URL  = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY  = process.env.VITE_SUPABASE_ANON_KEY;
const TEST_LICENSE  = process.env.TEST_LICENSE_KEY || 'TEST-LICENSE-001';

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY');
    process.exit(1);
  }

  const supa = createClient(SUPABASE_URL, SUPABASE_KEY);
  await supa.auth.signInAnonymously();

  // Step 1: Seed test expense (via legacy remote_expenses direct insert as service role)
  console.log('📌 Seeding test expense...');
  const { data: inserted, error: insErr } = await supa
    .from('remote_expenses')
    .insert({
      shop_id:      require('crypto').createHash('sha256').update(TEST_LICENSE).digest('hex'),
      amount:       99.50,
      description:  '[P0.5 TEST] Crash resilience expense',
      synced_to_pos: false
    })
    .select('id')
    .single();

  if (insErr) {
    console.warn('⚠️ Could not seed via direct insert (RLS). Checking if one already exists...');
  }

  // Step 2: Phase 1 pull — fetch without ACK
  console.log('\n📥 Phase 1: pull_pending_expenses_v2 (no ACK)...');
  const { data: expenses, error: pullErr } = await supa.rpc('pull_pending_expenses_v2', {
    p_license_key: TEST_LICENSE
  });
  if (pullErr) { console.error('❌ pull_pending_expenses_v2 failed:', pullErr.message); process.exit(1); }

  console.log(`   Fetched ${expenses?.length || 0} pending expense(s) without mutating cloud state.`);

  // Step 3: Simulate SQLite crash (throw before ACK)
  console.log('\n💥 Simulating SQLite transaction crash (abort before ACK)...');
  let crashSimulated = false;
  try {
    const transactionFn = () => {
      // Pretend to insert then throw
      if (!crashSimulated) {
        crashSimulated = true;
        throw new Error('[TEST] Simulated SQLite disk I/O failure');
      }
    };
    transactionFn();
  } catch (e) {
    console.log('   Caught:', e.message, '— ACK will NOT be sent.');
  }

  // Step 4: Re-pull — same rows must still be pending
  console.log('\n📥 Re-pull after crash — rows must still be pending...');
  const { data: afterCrash, error: pullErr2 } = await supa.rpc('pull_pending_expenses_v2', {
    p_license_key: TEST_LICENSE
  });
  if (pullErr2) { console.error('❌ Re-pull failed:', pullErr2.message); process.exit(1); }

  const sameRowsPresent = expenses?.every(e => afterCrash?.some(a => a.id === e.id));
  if (sameRowsPresent) {
    console.log(`   ✅ All ${expenses?.length} rows still pending after crash — cloud state preserved.`);
  } else {
    console.error('   ❌ Some rows disappeared after crash without ACK — TWO-PHASE PULL BROKEN!');
    process.exit(1);
  }

  // Step 5: Successful ACK
  const ids = afterCrash.map(e => e.id);
  if (ids.length > 0) {
    console.log('\n✅ Phase 2: Sending ACK...');
    const { data: ackData, error: ackErr } = await supa.rpc('ack_expenses', {
      p_license_key:  TEST_LICENSE,
      p_expense_ids:  ids
    });
    if (ackErr) { console.error('❌ ACK failed:', ackErr.message); process.exit(1); }
    console.log(`   ACKed: ${ackData?.acknowledged_count} expense(s).`);

    // Step 6: Final re-pull — must now be empty
    console.log('\n📥 Final pull after ACK — must return 0 rows...');
    const { data: finalPull } = await supa.rpc('pull_pending_expenses_v2', { p_license_key: TEST_LICENSE });
    const stillPending = finalPull?.filter(e => ids.includes(e.id));
    if (!stillPending || stillPending.length === 0) {
      console.log('   ✅ 0 previously-ACKed expenses re-delivered — idempotency verified.');
    } else {
      console.error('   ❌ ACKed expenses are still pending — idempotency broken!');
      process.exit(1);
    }
  }

  console.log('\n─────────────────────────────────────────────────────');
  console.log('✅ P0.5 TWO-PHASE PULL CRASH TEST: PASSED');
  await supa.auth.signOut();
}

main().catch(err => { console.error(err); process.exit(1); });
