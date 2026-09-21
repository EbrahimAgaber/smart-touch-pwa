-- =============================================================================
-- SMART TOUCH POS — MIGRATION 0001: P0 MULTI-STORE SCHEMA DDL
-- Report Reference: ST-POS-PWA-ARCH-2026-V1, Section 3.6
-- Safe: uses CREATE TABLE IF NOT EXISTS and ALTER TABLE ... ADD COLUMN IF NOT EXISTS
-- Apply via: Supabase SQL Editor → Run
-- =============================================================================

-- Ensure pgcrypto is loaded for SHA-256 digests (already used by set_live_stats_batch)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- 1. Organizations (Enterprise Parent Entity)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.organizations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    tax_number  TEXT,
    created_at  TIMESTAMPTZ DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
);

-- =============================================================================
-- 2. Physical Retail Branches (replaces the SHA256-keyed shop_id in existing tables)
--    license_key UNIQUE enforces one row per POS terminal / license.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.shops (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
    license_key     TEXT UNIQUE NOT NULL,
    shop_name       TEXT NOT NULL,
    city            TEXT DEFAULT 'الرياض',
    phone           TEXT,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh'),
    last_seen_at    TIMESTAMPTZ
);

-- =============================================================================
-- 3. Authorized Physical POS Hardware Terminals
--    device_token_hash = SHA256 of the raw secret token held by the register.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.shop_devices (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id            UUID REFERENCES public.shops(id) ON DELETE CASCADE,
    device_uuid        TEXT NOT NULL,
    device_name        TEXT NOT NULL DEFAULT 'Desktop POS Terminal',
    device_token_hash  TEXT NOT NULL,
    is_active          BOOLEAN DEFAULT TRUE,
    created_at         TIMESTAMPTZ DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh'),
    last_seen_at       TIMESTAMPTZ,
    UNIQUE(shop_id, device_uuid)
);

-- =============================================================================
-- 4. Durable Owner Profiles (keyed to auth.users — survives ITP purge)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.owner_profiles (
    id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name   TEXT NOT NULL DEFAULT 'مالك المتجر',
    phone       TEXT UNIQUE,
    email       TEXT,
    created_at  TIMESTAMPTZ DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
);

-- =============================================================================
-- 5. Shop Memberships & Roles
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.shop_memberships (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES public.owner_profiles(id) ON DELETE CASCADE,
    shop_id     UUID REFERENCES public.shops(id) ON DELETE CASCADE,
    role        TEXT CHECK (role IN ('owner', 'branch_manager', 'auditor')) DEFAULT 'owner',
    created_at  TIMESTAMPTZ DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh'),
    UNIQUE(user_id, shop_id)
);

-- =============================================================================
-- 6. Secure Pairing Codes with TTL + Consumption Lock + Device Token Linkage
--    Replaces the legacy pairing_codes table (which had no expires_at, no consumed_at).
--    This migration alters-or-creates to be safe against an existing table.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.pairing_codes (
    code              TEXT PRIMARY KEY,
    shop_id           UUID REFERENCES public.shops(id) ON DELETE CASCADE,
    created_by        TEXT,
    expires_at        TIMESTAMPTZ NOT NULL,
    consumed_at       TIMESTAMPTZ,
    consumed_by       UUID REFERENCES auth.users(id),
    device_token_hash TEXT
);

-- If pairing_codes already exists from the legacy schema (code VARCHAR(8), no TTL),
-- safely add the missing columns:
ALTER TABLE public.pairing_codes ADD COLUMN IF NOT EXISTS expires_at        TIMESTAMPTZ;
ALTER TABLE public.pairing_codes ADD COLUMN IF NOT EXISTS consumed_at       TIMESTAMPTZ;
ALTER TABLE public.pairing_codes ADD COLUMN IF NOT EXISTS consumed_by       UUID REFERENCES auth.users(id);
ALTER TABLE public.pairing_codes ADD COLUMN IF NOT EXISTS device_token_hash TEXT;
ALTER TABLE public.pairing_codes ADD COLUMN IF NOT EXISTS created_by        TEXT;

-- Back-fill expires_at for any legacy open codes (make them expire immediately so
-- they can't be replayed, without deleting them — preserves audit trail).
UPDATE public.pairing_codes
SET expires_at = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
WHERE expires_at IS NULL;

-- =============================================================================
-- 7. Upgraded Shifts with Full Cash Drawer Reconciliation
--    shop_id is UUID (FK to shops), eliminating the old TEXT SHA256 column.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.shop_shifts_v2 (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id             UUID REFERENCES public.shops(id) ON DELETE CASCADE,
    local_shift_id      INTEGER NOT NULL,
    shift_uuid          TEXT UNIQUE,
    cashier_name        TEXT NOT NULL,
    opened_at           TIMESTAMPTZ NOT NULL,
    closed_at           TIMESTAMPTZ,
    starting_cash       NUMERIC(12,2) DEFAULT 0.00,
    expected_cash       NUMERIC(12,2) DEFAULT 0.00,
    actual_cash         NUMERIC(12,2) DEFAULT 0.00,
    cash_difference     NUMERIC(12,2) DEFAULT 0.00,  -- actual_cash - expected_cash
    total_sales         NUMERIC(12,2) DEFAULT 0.00,
    cash_sales          NUMERIC(12,2) DEFAULT 0.00,
    card_sales          NUMERIC(12,2) DEFAULT 0.00,
    credit_sales        NUMERIC(12,2) DEFAULT 0.00,
    refund_amount       NUMERIC(12,2) DEFAULT 0.00,
    total_expenditures  NUMERIC(12,2) DEFAULT 0.00,
    status              TEXT CHECK (status IN ('open', 'closed', 'flagged')) DEFAULT 'open',
    synced_at           TIMESTAMPTZ DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
);

-- =============================================================================
-- 8. Store Inventory Snapshot (P2 table, created now for schema completeness)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.shop_inventory_items (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id           UUID REFERENCES public.shops(id) ON DELETE CASCADE,
    local_product_id  INTEGER NOT NULL,
    name              TEXT NOT NULL,
    barcode           TEXT,
    category          TEXT,
    stock             NUMERIC(10,2) DEFAULT 0,
    min_stock_level   NUMERIC(10,2) DEFAULT 0,
    cost              NUMERIC(10,2) DEFAULT 0,
    price             NUMERIC(10,2) DEFAULT 0,
    is_86ed           BOOLEAN DEFAULT FALSE,
    last_synced_at    TIMESTAMPTZ DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh'),
    UNIQUE(shop_id, local_product_id)
);

-- =============================================================================
-- 9. Bidirectional Remote Commands Queue (PWA → Desktop POS)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.shop_remote_commands (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id       UUID REFERENCES public.shops(id) ON DELETE CASCADE,
    command_type  TEXT NOT NULL,  -- 'ADD_EXPENSE', '86_ITEM'
    payload_json  JSONB NOT NULL,
    status        TEXT CHECK (status IN ('pending', 'executed', 'failed')) DEFAULT 'pending',
    created_at    TIMESTAMPTZ DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh'),
    executed_at   TIMESTAMPTZ
);

-- =============================================================================
-- 10. Remote Expenses — add missing columns for two-phase pull + command linkage
--     Table may already exist (legacy schema). Safe ALTER.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.remote_expenses (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shop_id      TEXT NOT NULL,
    amount       NUMERIC(12,2) NOT NULL,
    description  TEXT NOT NULL,
    category     TEXT DEFAULT 'مصروفات عامة',
    synced_to_pos BOOLEAN DEFAULT FALSE,
    created_at   TIMESTAMPTZ DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh'),
    synced_at    TIMESTAMPTZ,
    command_id   UUID REFERENCES public.shop_remote_commands(id) ON DELETE SET NULL
);

ALTER TABLE public.remote_expenses ADD COLUMN IF NOT EXISTS synced_at   TIMESTAMPTZ;
ALTER TABLE public.remote_expenses ADD COLUMN IF NOT EXISTS command_id  UUID REFERENCES public.shop_remote_commands(id) ON DELETE SET NULL;
ALTER TABLE public.remote_expenses ADD COLUMN IF NOT EXISTS category    TEXT DEFAULT 'مصروفات عامة';

-- =============================================================================
-- PERFORMANCE INDEXES
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_shop_devices_lookup
    ON public.shop_devices(device_token_hash, is_active);

CREATE INDEX IF NOT EXISTS idx_remote_expenses_pending
    ON public.remote_expenses(shop_id)
    WHERE synced_to_pos = FALSE;

CREATE INDEX IF NOT EXISTS idx_shop_live_stats_composite
    ON public.shop_live_stats(shop_id, date);

-- Expression index for dual-compat join: matches legacy SHA256 of license_key
CREATE INDEX IF NOT EXISTS idx_shops_license_sha256
    ON public.shops (encode(digest(license_key, 'sha256'), 'hex'));

CREATE INDEX IF NOT EXISTS idx_shop_shifts_v2_shop_date
    ON public.shop_shifts_v2(shop_id, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_shop_memberships_user
    ON public.shop_memberships(user_id);

CREATE INDEX IF NOT EXISTS idx_shop_remote_commands_pending
    ON public.shop_remote_commands(shop_id, status)
    WHERE status = 'pending';
