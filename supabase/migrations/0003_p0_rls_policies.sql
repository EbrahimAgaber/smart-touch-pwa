-- =============================================================================
-- SMART TOUCH POS — MIGRATION 0003: P0 RLS POLICIES
-- Report Reference: ST-POS-PWA-ARCH-2026-V1, Section 3.6 / P0.7
-- Fixes SQLSTATE 42883 (operator does not exist: uuid = text) by:
--   1. Explicit sm.shop_id::text cast in shop_live_stats policy
--   2. Dual-compat join pattern in all stat-reading policies
-- =============================================================================

-- Enable RLS on all new tables
ALTER TABLE public.organizations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shops                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_devices         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owner_profiles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_memberships     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_shifts_v2       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_remote_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_inventory_items ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- owner_profiles: owner can only read/update their own row
-- =============================================================================
DROP POLICY IF EXISTS "owner_profiles_self" ON public.owner_profiles;
CREATE POLICY "owner_profiles_self" ON public.owner_profiles
    FOR ALL USING (auth.uid() = id);

-- =============================================================================
-- shop_memberships: user can only see their own memberships
-- =============================================================================
DROP POLICY IF EXISTS "shop_memberships_own" ON public.shop_memberships;
CREATE POLICY "shop_memberships_own" ON public.shop_memberships
    FOR ALL USING (auth.uid() = user_id);

-- =============================================================================
-- shops: user can read shops they are a member of
-- =============================================================================
DROP POLICY IF EXISTS "shops_member_read" ON public.shops;
CREATE POLICY "shops_member_read" ON public.shops
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.shop_memberships sm
            WHERE sm.shop_id = shops.id
              AND sm.user_id = auth.uid()
        )
    );

-- =============================================================================
-- shop_live_stats: user can read stats for shops they own
-- P0.7 FIX: dual-compat join — matches BOTH UUID::text AND SHA256 hex digest.
-- The old policy used sm.shop_id = shop_live_stats.shop_id which failed with
-- SQLSTATE 42883 because shop_memberships.shop_id is UUID and
-- shop_live_stats.shop_id is TEXT. Fixed with explicit ::text cast + dual join.
-- =============================================================================
DROP POLICY IF EXISTS "shop_live_stats_member_read" ON public.shop_live_stats;
CREATE POLICY "shop_live_stats_member_read" ON public.shop_live_stats
    FOR SELECT USING (
        EXISTS (
            SELECT 1
            FROM public.shop_memberships sm
            JOIN public.shops s ON s.id = sm.shop_id
            WHERE sm.user_id = auth.uid()
              AND (
                -- UUID string match (new format)
                shop_live_stats.shop_id = s.id::text
                -- SHA256 hex digest match (legacy format from set_live_stats_batch)
                OR shop_live_stats.shop_id = encode(digest(s.license_key, 'sha256'), 'hex')
              )
        )
    );

-- =============================================================================
-- shop_shifts_v2: user can read/insert shifts for their shops
-- Inserts come from push_shift_data_v2 (SECURITY DEFINER), so INSERT policy
-- uses service role bypass; reads are scoped to memberships.
-- =============================================================================
DROP POLICY IF EXISTS "shop_shifts_v2_member_read" ON public.shop_shifts_v2;
CREATE POLICY "shop_shifts_v2_member_read" ON public.shop_shifts_v2
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.shop_memberships sm
            WHERE sm.shop_id = shop_shifts_v2.shop_id
              AND sm.user_id = auth.uid()
        )
    );

-- =============================================================================
-- shop_remote_commands: user can insert (PWA → add expense) and read their own
-- =============================================================================
DROP POLICY IF EXISTS "shop_remote_commands_member" ON public.shop_remote_commands;
CREATE POLICY "shop_remote_commands_member" ON public.shop_remote_commands
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.shop_memberships sm
            WHERE sm.shop_id = shop_remote_commands.shop_id
              AND sm.user_id = auth.uid()
        )
    );

-- =============================================================================
-- shop_inventory_items: user can read inventory for their shops
-- =============================================================================
DROP POLICY IF EXISTS "shop_inventory_items_member_read" ON public.shop_inventory_items;
CREATE POLICY "shop_inventory_items_member_read" ON public.shop_inventory_items
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.shop_memberships sm
            WHERE sm.shop_id = shop_inventory_items.shop_id
              AND sm.user_id = auth.uid()
        )
    );

-- =============================================================================
-- pairing_codes: only the desktop (anon key / service role) can INSERT new codes.
-- No authenticated user should be able to read or modify pairing codes directly.
-- All access goes through SECURITY DEFINER RPCs.
-- =============================================================================
ALTER TABLE public.pairing_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pairing_codes_no_direct_access" ON public.pairing_codes;
CREATE POLICY "pairing_codes_no_direct_access" ON public.pairing_codes
    FOR ALL USING (FALSE);  -- All direct access blocked; use RPCs only

-- =============================================================================
-- Grant EXECUTE on all new RPCs to authenticated and anon roles
-- SECURITY DEFINER functions are called under the function owner's role.
-- =============================================================================
GRANT EXECUTE ON FUNCTION public.generate_pairing_code_v2    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.exchange_pairing_code_v2    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_shift_data_v2          TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_consolidated_executive_stats TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_branch_leaderboard      TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_remote_expense_v2       TO authenticated;
GRANT EXECUTE ON FUNCTION public.pull_pending_expenses_v2    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ack_expenses                TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_live_stats_batch        TO anon, authenticated;
