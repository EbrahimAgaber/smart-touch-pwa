-- =============================================================================
-- SMART TOUCH POS — MIGRATION 0002: P0 RPCs AND TRIGGER BRIDGES
-- Report Reference: ST-POS-PWA-ARCH-2026-V1, Section 3.6
-- All functions use CREATE OR REPLACE — safe to re-run.
-- IMPORTANT: Run AFTER 0001_p0_schema_ddl.sql
-- =============================================================================

-- =============================================================================
-- RPC 1: generate_pairing_code_v2
-- Auto-provisions shops, issues 6-digit numeric codes with 15-min TTL,
-- provisions 256-bit terminal device tokens, invalidates prior active codes.
-- Called by: Desktop POS (supabaseSync.cjs → generatePairingCode)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.generate_pairing_code_v2(
    p_license_key   TEXT,
    p_ttl_minutes   INT     DEFAULT 15,
    p_shop_name     TEXT    DEFAULT NULL,
    p_device_uuid   TEXT    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_shop_id           UUID;
    v_shop_name         TEXT;
    v_code              TEXT;
    v_expires_at        TIMESTAMPTZ;
    v_device_uuid       TEXT := COALESCE(p_device_uuid, 'pos-term-' || encode(gen_random_bytes(6), 'hex'));
    v_raw_device_token  TEXT;
    v_device_token_hash TEXT;
    v_attempt           INT := 0;
BEGIN
    IF p_license_key IS NULL OR TRIM(p_license_key) = '' THEN
        RAISE EXCEPTION 'مفتاح الترخيص مطلوب' USING ERRCODE = '22023';
    END IF;

    IF p_ttl_minutes IS NULL OR p_ttl_minutes < 1 OR p_ttl_minutes > 1440 THEN
        p_ttl_minutes := 15;
    END IF;

    -- Lookup or auto-provision the shop record for this license key
    SELECT id, shop_name INTO v_shop_id, v_shop_name
    FROM public.shops
    WHERE license_key = TRIM(p_license_key);

    IF v_shop_id IS NULL THEN
        v_shop_name := COALESCE(NULLIF(TRIM(p_shop_name), ''), 'متجر جديد (' || RIGHT(TRIM(p_license_key), 4) || ')');
        INSERT INTO public.shops (license_key, shop_name, is_active, created_at, last_seen_at)
        VALUES (
            TRIM(p_license_key),
            v_shop_name,
            TRUE,
            (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh'),
            (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
        )
        RETURNING id, shop_name INTO v_shop_id, v_shop_name;
    ELSE
        -- Update shop name if provided and different
        IF p_shop_name IS NOT NULL AND TRIM(p_shop_name) <> '' AND TRIM(p_shop_name) <> v_shop_name THEN
            UPDATE public.shops
            SET shop_name = TRIM(p_shop_name),
                last_seen_at = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
            WHERE id = v_shop_id;
            v_shop_name := TRIM(p_shop_name);
        END IF;
    END IF;

    -- Invalidate any prior unconsumed active codes for this shop (security: one live code at a time)
    UPDATE public.pairing_codes
    SET expires_at = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
    WHERE shop_id = v_shop_id::text
      AND consumed_at IS NULL
      AND expires_at > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh');

    -- Generate collision-resistant 6-digit numeric code
    v_expires_at := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh') + (p_ttl_minutes || ' minutes')::INTERVAL;
    LOOP
        v_attempt := v_attempt + 1;
        v_code := lpad(
            (100000 + (abs(('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 900000))::TEXT,
            6, '0'
        );

        IF NOT EXISTS (
            SELECT 1 FROM public.pairing_codes
            WHERE code = v_code
              AND consumed_at IS NULL
              AND expires_at > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
        ) THEN
            EXIT;
        END IF;

        IF v_attempt > 20 THEN
            RAISE EXCEPTION 'فشل توليد رمز اقتران فريد، يرجى إعادة المحاولة' USING ERRCODE = '54000';
        END IF;
    END LOOP;

    -- Generate 256-bit raw device authentication token
    v_raw_device_token  := encode(gen_random_bytes(32), 'hex');
    v_device_token_hash := encode(digest(v_raw_device_token, 'sha256'), 'hex');

    -- Upsert device registry
    INSERT INTO public.shop_devices (
        shop_id, device_uuid, device_name, device_token_hash, is_active, last_seen_at
    ) VALUES (
        v_shop_id,
        v_device_uuid,
        COALESCE(NULLIF(TRIM(p_shop_name), ''), 'Desktop POS Terminal'),
        v_device_token_hash,
        TRUE,
        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
    )
    ON CONFLICT (shop_id, device_uuid) DO UPDATE SET
        device_token_hash = EXCLUDED.device_token_hash,
        is_active         = TRUE,
        last_seen_at      = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh');

    -- Record the pairing code
    INSERT INTO public.pairing_codes (
        code, shop_id, expires_at, created_by, device_token_hash
    ) VALUES (
        v_code, v_shop_id::text, v_expires_at, 'desktop_terminal', v_device_token_hash
    )
    ON CONFLICT (code) DO UPDATE SET
        shop_id           = EXCLUDED.shop_id,
        expires_at        = EXCLUDED.expires_at,
        consumed_at       = NULL,
        consumed_by       = NULL,
        device_token_hash = EXCLUDED.device_token_hash;

    RETURN jsonb_build_object(
        'success',      TRUE,
        'code',         v_code,
        'shop_id',      v_shop_id,
        'shop_name',    v_shop_name,
        'device_uuid',  v_device_uuid,
        'device_token', v_raw_device_token,
        'expires_at',   v_expires_at,
        'ttl_seconds',  p_ttl_minutes * 60
    );
END;
$$;

-- =============================================================================
-- RPC 2: exchange_pairing_code_v2
-- SELECT ... FOR UPDATE eliminates the race condition where two concurrent
-- requests could both consume the same single-use pairing code.
-- Called by: PWA PairingScreen (exchange_pairing_code_v2)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.exchange_pairing_code_v2(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_shop_id   UUID;
    v_shop_name TEXT;
    v_org_id    UUID;
    v_user_id   UUID := auth.uid();
    v_clean_code TEXT := UPPER(TRIM(p_code));
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'المستخدم غير مسجل الدخول' USING ERRCODE = '28000';
    END IF;

    IF v_clean_code IS NULL OR v_clean_code = '' THEN
        RAISE EXCEPTION 'يرجى إدخال رمز الاقتران' USING ERRCODE = '22023';
    END IF;

    -- Critical: FOR UPDATE locks the row so a concurrent transaction must wait.
    -- When the second transaction resumes it will see consumed_at IS NOT NULL and abort.
    SELECT shop_id INTO v_shop_id
    FROM public.pairing_codes
    WHERE code = v_clean_code
      AND consumed_at IS NULL
      AND expires_at > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
    FOR UPDATE;

    IF v_shop_id IS NULL THEN
        RAISE EXCEPTION 'رمز الاقتران غير صحيح، منتهي الصلاحية، أو تم استخدامه مسبقاً' USING ERRCODE = 'P0002';
    END IF;

    SELECT shop_name, organization_id INTO v_shop_name, v_org_id
    FROM public.shops
    WHERE id = v_shop_id;

    -- Ensure owner profile exists (idempotent)
    INSERT INTO public.owner_profiles (id, full_name, created_at)
    VALUES (v_user_id, 'مالك المتجر', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh'))
    ON CONFLICT (id) DO NOTHING;

    -- Bind owner membership (idempotent)
    INSERT INTO public.shop_memberships (user_id, shop_id, role, created_at)
    VALUES (v_user_id, v_shop_id, 'owner', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh'))
    ON CONFLICT (user_id, shop_id) DO NOTHING;

    -- Also create/update legacy owner_licenses for backward compat with existing queries
    -- The legacy table uses shop_id = SHA256(license_key) as TEXT
    IF EXISTS (
        SELECT 1 FROM public.owner_licenses 
        WHERE device_id = v_user_id::text 
          AND shop_id = (SELECT encode(digest(license_key, 'sha256'), 'hex') FROM public.shops WHERE id = v_shop_id)
    ) THEN
        UPDATE public.owner_licenses
        SET shop_name = (SELECT shop_name FROM public.shops WHERE id = v_shop_id),
            issued_at = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh'),
            revoked_at = NULL
        WHERE device_id = v_user_id::text
          AND shop_id = (SELECT encode(digest(license_key, 'sha256'), 'hex') FROM public.shops WHERE id = v_shop_id);
    ELSE
        INSERT INTO public.owner_licenses (shop_id, shop_name, device_id, issued_at)
        SELECT
            encode(digest(s.license_key, 'sha256'), 'hex'),
            s.shop_name,
            v_user_id::text,
            (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
        FROM public.shops s WHERE s.id = v_shop_id;
    END IF;

    -- Atomically mark pairing code as consumed
    UPDATE public.pairing_codes
    SET consumed_at = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh'),
        consumed_by = v_user_id
    WHERE code = v_clean_code;

    RETURN jsonb_build_object(
        'success',         TRUE,
        'shop_id',         v_shop_id,
        'shop_name',       v_shop_name,
        'organization_id', v_org_id,
        'consumed_at',     (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
    );
END;
$$;

-- =============================================================================
-- RPC 3: get_consolidated_executive_stats
-- Dual-compatibility join: matches shop_live_stats.shop_id against BOTH
-- the new UUID format and the legacy SHA256(license_key) hex digest.
-- P0.7 fix: explicit ::text cast eliminates SQLSTATE 42883 (uuid = text error).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_consolidated_executive_stats(
    p_date DATE DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')::DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_result  JSONB;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'المستخدم غير مسجل الدخول' USING ERRCODE = '28000';
    END IF;

    SELECT jsonb_build_object(
        'date',               p_date,
        'total_branches',     COUNT(DISTINCT s.id),
        'active_branches',    COUNT(DISTINCT CASE WHEN s.last_seen_at > (NOW() - INTERVAL '15 minutes') THEN s.id END),
        'total_sales',        COALESCE(SUM(ls.total_sales), 0),
        'cash_sales',         COALESCE(SUM(ls.cash_sales), 0),
        'card_sales',         COALESCE(SUM(ls.card_sales), 0),
        'total_expenditures', COALESCE(SUM(ls.total_expenditures), 0),
        'net_revenue',        COALESCE(SUM(ls.total_sales - ls.total_expenditures), 0),
        'order_count',        COALESCE(SUM(ls.order_count), 0),
        'avg_ticket_value',   CASE
            WHEN SUM(ls.order_count) > 0 THEN ROUND(SUM(ls.total_sales) / SUM(ls.order_count), 2)
            ELSE 0.00
        END
    ) INTO v_result
    FROM public.shop_memberships sm
    JOIN public.shops s ON s.id = sm.shop_id
    -- Dual-compat join: UUID text OR legacy SHA256 hex digest (P0.7)
    LEFT JOIN public.shop_live_stats ls
        ON (ls.shop_id = s.id::text
            OR ls.shop_id = encode(digest(s.license_key, 'sha256'), 'hex'))
       AND ls.date = p_date
    WHERE sm.user_id = v_user_id;

    RETURN v_result;
END;
$$;

-- =============================================================================
-- RPC 4: get_branch_leaderboard
-- Dual-compat join + cash variance evaluated ONLY on closed shifts.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_branch_leaderboard(
    p_date DATE DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')::DATE
)
RETURNS TABLE (
    shop_id              UUID,
    shop_name            TEXT,
    city                 TEXT,
    is_online            BOOLEAN,
    total_sales          NUMERIC,
    cash_sales           NUMERIC,
    card_sales           NUMERIC,
    total_expenditures   NUMERIC,
    order_count          INTEGER,
    avg_ticket           NUMERIC,
    active_shift_cashier TEXT,
    cash_variance_alert  BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
    SELECT
        s.id                                        AS shop_id,
        s.shop_name,
        s.city,
        (s.last_seen_at > (NOW() - INTERVAL '15 minutes')) AS is_online,
        COALESCE(ls.total_sales, 0)                 AS total_sales,
        COALESCE(ls.cash_sales, 0)                  AS cash_sales,
        COALESCE(ls.card_sales, 0)                  AS card_sales,
        COALESCE(ls.total_expenditures, 0)          AS total_expenditures,
        COALESCE(ls.order_count, 0)                 AS order_count,
        CASE WHEN COALESCE(ls.order_count, 0) > 0
             THEN ROUND(COALESCE(ls.total_sales, 0) / ls.order_count, 2)
             ELSE 0.00
        END                                         AS avg_ticket,
        latest_shift.cashier_name                   AS active_shift_cashier,
        -- Cash variance ONLY evaluated on closed/flagged shifts (P0.4 guard)
        (
            last_closed_shift.closed_at IS NOT NULL
            AND last_closed_shift.status = 'flagged'
            AND COALESCE(last_closed_shift.cash_difference, 0) < -50.00
        )                                           AS cash_variance_alert
    FROM public.shop_memberships sm
    JOIN public.shops s ON s.id = sm.shop_id
    -- Dual-compat join (P0.7)
    LEFT JOIN public.shop_live_stats ls
        ON (ls.shop_id = s.id::text
            OR ls.shop_id = encode(digest(s.license_key, 'sha256'), 'hex'))
       AND ls.date = p_date
    -- Latest open shift cashier (clock-drift guarded)
    LEFT JOIN LATERAL (
        SELECT cashier_name
        FROM public.shop_shifts_v2
        WHERE shop_id = s.id
          AND opened_at <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
        ORDER BY opened_at DESC
        LIMIT 1
    ) latest_shift ON TRUE
    -- Last closed shift for variance evaluation (NEVER evaluate open shifts)
    LEFT JOIN LATERAL (
        SELECT cash_difference, status, closed_at
        FROM public.shop_shifts_v2
        WHERE shop_id = s.id
          AND closed_at IS NOT NULL
          AND status IN ('closed', 'flagged')
          AND opened_at <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
        ORDER BY closed_at DESC
        LIMIT 1
    ) last_closed_shift ON TRUE
    WHERE sm.user_id = auth.uid()
    ORDER BY total_sales DESC;
$$;

-- =============================================================================
-- RPC 5: push_shift_data_v2
-- Full drawer cash fields, device token auth, open/closed variance logic.
-- Open shift: cash_difference = 0.00, status = 'open' (NEVER flag an open shift).
-- Closed shift: evaluate actual_cash - expected_cash, flag if < -50.00.
-- Called by: Desktop POS (supabaseSync.cjs → processQueue)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.push_shift_data_v2(
    p_license_key       TEXT,
    p_device_token      TEXT    DEFAULT NULL,
    p_local_shift_id    INTEGER DEFAULT 1,
    p_shift_uuid        TEXT    DEFAULT NULL,
    p_cashier_name      TEXT    DEFAULT 'كاشير',
    p_opened_at         TIMESTAMPTZ DEFAULT NOW(),
    p_closed_at         TIMESTAMPTZ DEFAULT NULL,
    p_starting_cash     NUMERIC DEFAULT 0.00,
    p_expected_cash     NUMERIC DEFAULT 0.00,
    p_actual_cash       NUMERIC DEFAULT 0.00,
    p_total_sales       NUMERIC DEFAULT 0.00,
    p_cash_sales        NUMERIC DEFAULT 0.00,
    p_card_sales        NUMERIC DEFAULT 0.00,
    p_credit_sales      NUMERIC DEFAULT 0.00,
    p_refund_amount     NUMERIC DEFAULT 0.00,
    p_total_expenditures NUMERIC DEFAULT 0.00
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_shop_id       UUID;
    v_diff          NUMERIC := 0.00;
    v_status        TEXT;
    v_token_hash    TEXT;
    v_shift_uuid    TEXT;
BEGIN
    IF p_license_key IS NULL OR TRIM(p_license_key) = '' THEN
        RAISE EXCEPTION 'مفتاح الترخيص مطلوب' USING ERRCODE = '22023';
    END IF;

    -- Device authentication: if token provided, validate against registered terminals
    IF p_device_token IS NOT NULL AND TRIM(p_device_token) <> '' THEN
        v_token_hash := encode(digest(TRIM(p_device_token), 'sha256'), 'hex');

        SELECT d.shop_id INTO v_shop_id
        FROM public.shop_devices d
        JOIN public.shops s ON s.id = d.shop_id
        WHERE s.license_key = TRIM(p_license_key)
          AND d.device_token_hash = v_token_hash
          AND d.is_active = TRUE;

        IF v_shop_id IS NULL THEN
            RAISE EXCEPTION 'غير مصرح: رمز مصادقة الجهاز غير صالح (Unauthorized Device Token)'
                USING ERRCODE = '42501';
        END IF;

        -- Update device heartbeat
        UPDATE public.shop_devices
        SET last_seen_at = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
        WHERE shop_id = v_shop_id AND device_token_hash = v_token_hash;
    ELSE
        -- Fallback: license key only (backward compat for terminals not yet upgraded)
        SELECT id INTO v_shop_id
        FROM public.shops
        WHERE license_key = TRIM(p_license_key);

        IF v_shop_id IS NULL THEN
            RAISE EXCEPTION 'ترخيص المتجر غير مسجل بالنظام' USING ERRCODE = 'P0002';
        END IF;
    END IF;

    -- Remediated cash discrepancy logic (P0.4):
    -- NEVER evaluate variance on an open shift (drawer not yet counted).
    IF p_closed_at IS NULL THEN
        v_status := 'open';
        v_diff   := 0.00;
    ELSE
        v_diff := (COALESCE(p_actual_cash, 0.00) - COALESCE(p_expected_cash, 0.00));
        IF v_diff < -50.00 THEN
            v_status := 'flagged';
        ELSE
            v_status := 'closed';
        END IF;
    END IF;

    -- Generate deterministic shift_uuid for idempotent upserts
    v_shift_uuid := COALESCE(
        p_shift_uuid,
        'shift-' || TRIM(p_license_key) || '-' || p_local_shift_id::TEXT
    );

    INSERT INTO public.shop_shifts_v2 (
        shop_id, local_shift_id, shift_uuid, cashier_name,
        opened_at, closed_at, starting_cash, expected_cash,
        actual_cash, cash_difference, total_sales, cash_sales,
        card_sales, credit_sales, refund_amount, total_expenditures, status, synced_at
    ) VALUES (
        v_shop_id,
        p_local_shift_id,
        v_shift_uuid,
        p_cashier_name,
        p_opened_at,
        p_closed_at,
        COALESCE(p_starting_cash, 0.00),
        COALESCE(p_expected_cash, 0.00),
        COALESCE(p_actual_cash, 0.00),
        v_diff,
        COALESCE(p_total_sales, 0.00),
        COALESCE(p_cash_sales, 0.00),
        COALESCE(p_card_sales, 0.00),
        COALESCE(p_credit_sales, 0.00),
        COALESCE(p_refund_amount, 0.00),
        COALESCE(p_total_expenditures, 0.00),
        v_status,
        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
    )
    ON CONFLICT (shift_uuid) DO UPDATE SET
        closed_at           = EXCLUDED.closed_at,
        actual_cash         = EXCLUDED.actual_cash,
        expected_cash       = EXCLUDED.expected_cash,
        -- Re-evaluate variance on upsert: open=0, closed=compute
        cash_difference     = CASE
            WHEN EXCLUDED.closed_at IS NULL THEN 0.00
            ELSE (EXCLUDED.actual_cash - EXCLUDED.expected_cash)
        END,
        total_sales         = EXCLUDED.total_sales,
        cash_sales          = EXCLUDED.cash_sales,
        card_sales          = EXCLUDED.card_sales,
        credit_sales        = EXCLUDED.credit_sales,
        refund_amount       = EXCLUDED.refund_amount,
        total_expenditures  = EXCLUDED.total_expenditures,
        status              = v_status,
        synced_at           = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh');

    -- Update shop heartbeat
    UPDATE public.shops
    SET last_seen_at = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
    WHERE id = v_shop_id;

    RETURN TRUE;
END;
$$;

-- =============================================================================
-- RPC 6: add_remote_expense_v2 — explicit p_shop_id, membership-validated
-- Called by: PWA Dashboard expense form
-- Fixes: "Multi-Store Expense Attribution" defect (Report §1.6)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.add_remote_expense_v2(
    p_shop_id    UUID,
    p_amount     NUMERIC,
    p_description TEXT,
    p_category   TEXT DEFAULT 'مصروفات عامة'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_cmd_id  UUID;
BEGIN
    -- Validate caller has membership in this specific shop
    IF NOT EXISTS (
        SELECT 1 FROM public.shop_memberships
        WHERE shop_id = p_shop_id AND user_id = v_user_id
    ) THEN
        RAISE EXCEPTION 'ليس لديك صلاحية لإضافة مصروف لهذا الفرع' USING ERRCODE = '42501';
    END IF;

    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من صفر' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.shop_remote_commands (
        shop_id, command_type, payload_json, status, created_at
    ) VALUES (
        p_shop_id,
        'ADD_EXPENSE',
        jsonb_build_object(
            'amount',      p_amount,
            'description', p_description,
            'category',    p_category,
            'created_by',  v_user_id,
            'created_at',  (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
        ),
        'pending',
        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
    ) RETURNING id INTO v_cmd_id;

    RETURN v_cmd_id;
END;
$$;

-- =============================================================================
-- TWO-PHASE PULL ATOMICITY RPCs (P0.5)
-- =============================================================================

-- Phase 1: Idempotent fetch — does NOT mutate synced_to_pos
-- Called by: Desktop supabaseSync.cjs pullPendingExpenses (Phase 1)
CREATE OR REPLACE FUNCTION public.pull_pending_expenses_v2(p_license_key TEXT)
RETURNS TABLE (
    id          UUID,
    shop_id     TEXT,
    amount      NUMERIC,
    description TEXT,
    category    TEXT,
    created_at  TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_hash_id TEXT;
    v_shop_id UUID;
BEGIN
    v_hash_id := encode(digest(p_license_key, 'sha256'), 'hex');
    SELECT s.id INTO v_shop_id FROM public.shops s WHERE s.license_key = p_license_key;

    RETURN QUERY
    SELECT
        re.id,
        re.shop_id,
        re.amount,
        re.description,
        COALESCE(re.category, 'مصروفات عامة') AS category,
        re.created_at
    FROM public.remote_expenses re
    WHERE (
        re.shop_id = v_hash_id
        OR (v_shop_id IS NOT NULL AND re.shop_id = v_shop_id::text)
    )
      AND re.synced_to_pos = FALSE
    ORDER BY re.created_at ASC;
END;
$$;

-- Phase 2: Atomic batch acknowledgement — called ONLY after SQLite commits
-- Idempotent: re-acking already-acked rows is a no-op (WHERE synced_to_pos = FALSE).
-- Called by: Desktop supabaseSync.cjs pullPendingExpenses (Phase 2, on success only)
CREATE OR REPLACE FUNCTION public.ack_expenses(
    p_license_key  TEXT,
    p_expense_ids  UUID[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_hash_id   TEXT;
    v_shop_id   UUID;
    v_ack_count INTEGER := 0;
BEGIN
    IF p_expense_ids IS NULL OR cardinality(p_expense_ids) = 0 THEN
        RETURN jsonb_build_object('success', true, 'acknowledged_count', 0);
    END IF;

    v_hash_id := encode(digest(p_license_key, 'sha256'), 'hex');
    SELECT s.id INTO v_shop_id FROM public.shops s WHERE s.license_key = p_license_key;

    WITH updated AS (
        UPDATE public.remote_expenses re
        SET synced_to_pos = TRUE,
            synced_at     = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
        WHERE re.id = ANY(p_expense_ids)
          AND (re.shop_id = v_hash_id OR (v_shop_id IS NOT NULL AND re.shop_id = v_shop_id::text))
          AND re.synced_to_pos = FALSE   -- Idempotent: already-acked rows are skipped
        RETURNING re.id
    )
    SELECT COUNT(*) INTO v_ack_count FROM updated;

    RETURN jsonb_build_object(
        'success',            true,
        'acknowledged_count', v_ack_count
    );
END;
$$;

-- =============================================================================
-- BIDIRECTIONAL TRIGGER BRIDGE (P1.2)
-- Bridges shop_remote_commands (PWA) <-> remote_expenses (Desktop POS legacy pull)
-- =============================================================================

-- Trigger 1: Forward — ADD_EXPENSE command → mirrors into remote_expenses
CREATE OR REPLACE FUNCTION public.trg_bridge_remote_command_to_legacy_expenses()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_license_key    TEXT;
    v_legacy_shop_id TEXT;
BEGIN
    IF NEW.command_type = 'ADD_EXPENSE' THEN
        SELECT license_key INTO v_license_key
        FROM public.shops
        WHERE id = NEW.shop_id;

        v_legacy_shop_id := CASE
            WHEN v_license_key IS NOT NULL
            THEN encode(digest(v_license_key, 'sha256'), 'hex')
            ELSE NEW.shop_id::text
        END;

        INSERT INTO public.remote_expenses (
            shop_id, amount, description, category, synced_to_pos, created_at, command_id
        ) VALUES (
            v_legacy_shop_id,
            COALESCE((NEW.payload_json->>'amount')::NUMERIC, 0.00),
            COALESCE(NEW.payload_json->>'description', 'مصروف عن بعد من التطبيق'),
            COALESCE(NEW.payload_json->>'category', 'مصروفات عامة'),
            FALSE,
            COALESCE(NEW.created_at, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')),
            NEW.id
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_remote_commands_add_expense_bridge ON public.shop_remote_commands;
CREATE TRIGGER trg_remote_commands_add_expense_bridge
AFTER INSERT ON public.shop_remote_commands
FOR EACH ROW
EXECUTE FUNCTION public.trg_bridge_remote_command_to_legacy_expenses();

-- Trigger 2: Reverse — desktop acks (synced_to_pos=TRUE) → marks command 'executed'
CREATE OR REPLACE FUNCTION public.trg_sync_legacy_expense_to_remote_command()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
    IF NEW.synced_to_pos = TRUE
       AND (OLD.synced_to_pos IS DISTINCT FROM TRUE)
       AND NEW.command_id IS NOT NULL THEN
        UPDATE public.shop_remote_commands
        SET status      = 'executed',
            executed_at = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
        WHERE id = NEW.command_id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_remote_expenses_status_sync ON public.remote_expenses;
CREATE TRIGGER trg_remote_expenses_status_sync
AFTER UPDATE OF synced_to_pos ON public.remote_expenses
FOR EACH ROW
EXECUTE FUNCTION public.trg_sync_legacy_expense_to_remote_command();

-- =============================================================================
-- P0.8: Update set_live_stats_batch to use Asia/Riyadh local time for updated_at
-- The date bucket (p_date) is now sent from desktop in AST — this fixes the
-- updated_at timestamp to also be AST, keeping all cloud timestamps consistent.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.set_live_stats_batch(
    p_license_key       TEXT,
    p_date              DATE,
    p_total_sales       NUMERIC,
    p_cash_sales        NUMERIC,
    p_card_sales        NUMERIC,
    p_total_expenditures NUMERIC,
    p_order_count       INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_shop_id TEXT;
BEGIN
    v_shop_id := encode(digest(p_license_key, 'sha256'), 'hex');

    INSERT INTO public.shop_live_stats (
        shop_id, date, total_sales, cash_sales, card_sales,
        total_expenditures, order_count, updated_at
    ) VALUES (
        v_shop_id, p_date, p_total_sales, p_cash_sales, p_card_sales,
        p_total_expenditures, p_order_count,
        -- P0.8: Use Asia/Riyadh local time (was bare now())
        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh')
    )
    ON CONFLICT (shop_id, date) DO UPDATE SET
        total_sales        = EXCLUDED.total_sales,
        cash_sales         = EXCLUDED.cash_sales,
        card_sales         = EXCLUDED.card_sales,
        total_expenditures = EXCLUDED.total_expenditures,
        order_count        = EXCLUDED.order_count,
        updated_at         = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Riyadh');
END;
$$;
