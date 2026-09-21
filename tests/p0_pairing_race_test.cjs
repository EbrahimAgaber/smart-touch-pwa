/**
 * tests/p0_pairing_race_test.js
 * P0.2 Acceptance Test: Concurrent pairing code exchange race condition.
 *
 * Fires two exchange_pairing_code_v2 calls with the SAME code simultaneously.
 * Exactly one must succeed (success: true) and the other must fail with P0002.
 *
 * Run: node tests/p0_pairing_race_test.js
 *
 * Prerequisites:
 *   1. Copy .env to tests/.env or set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
 *   2. First generate a code: call generate_pairing_code_v2 with any license key
 *      and pass the 6-digit result as CODE below.
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
    console.error('❌ Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env');
    process.exit(1);
  }

  const supa = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Step 1: Sign in as anon (simulates PWA user)
  const { data: { session }, error: authErr } = await supa.auth.signInAnonymously();
  if (authErr) { console.error('❌ Auth failed:', authErr.message); process.exit(1); }
  console.log('✅ Anon session created:', session.user.id);

  // Step 2: Generate a pairing code via desktop RPC
  const { data: genData, error: genErr } = await supa.rpc('generate_pairing_code_v2', {
    p_license_key: TEST_LICENSE,
    p_shop_name:   'Test Shop',
    p_ttl_minutes: 5
  });
  if (genErr) { console.error('❌ generate_pairing_code_v2 failed:', genErr.message); process.exit(1); }
  const code = genData?.code;
  console.log(`✅ Generated code: ${code} (expires_at: ${genData?.expires_at})`);

  // Step 3: Two concurrent clients both try to exchange the SAME code
  const clientA = createClient(SUPABASE_URL, SUPABASE_KEY);
  const clientB = createClient(SUPABASE_URL, SUPABASE_KEY);

  await clientA.auth.signInAnonymously();
  await clientB.auth.signInAnonymously();

  console.log('\n⚡ Firing two concurrent exchange_pairing_code_v2 calls...');
  const results = await Promise.allSettled([
    clientA.rpc('exchange_pairing_code_v2', { p_code: code }),
    clientB.rpc('exchange_pairing_code_v2', { p_code: code })
  ]);

  let successCount = 0;
  let failCount    = 0;

  results.forEach((result, i) => {
    const name = i === 0 ? 'Client A' : 'Client B';
    if (result.status === 'fulfilled') {
      const { data, error } = result.value;
      if (!error && data?.success) {
        successCount++;
        console.log(`✅ ${name}: SUCCESS — shop_id=${data.shop_id}, shop_name=${data.shop_name}`);
      } else {
        failCount++;
        const errMsg = error?.message || JSON.stringify(data);
        const isP0002 = errMsg.includes('P0002') || errMsg.includes('منتهي') || errMsg.includes('استخدامه');
        console.log(`${isP0002 ? '✅' : '⚠️'} ${name}: ${isP0002 ? 'REJECTED (P0002 — correct)' : 'UNEXPECTED ERROR'} — ${errMsg}`);
        if (!isP0002) failCount += 100; // Force test failure for unexpected errors
      }
    } else {
      failCount++;
      console.log(`⚠️ ${name}: Promise rejected — ${result.reason}`);
    }
  });

  console.log('\n─────────────────────────────────────────────────────');
  if (successCount === 1 && failCount === 1) {
    console.log('✅ P0.2 RACE CONDITION TEST: PASSED');
    console.log('   Exactly 1 success, 1 P0002 rejection — FOR UPDATE lock works correctly.');
  } else {
    console.error('❌ P0.2 RACE CONDITION TEST: FAILED');
    console.error(`   Expected 1 success + 1 failure, got ${successCount} success + ${failCount} failure.`);
    process.exit(1);
  }

  await supa.auth.signOut();
}

main().catch(err => { console.error(err); process.exit(1); });
