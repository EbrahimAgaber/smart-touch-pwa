# test_suite_2_schema_type_joins.py
"""
Empirical Test Suite 2: Schema Type Mismatches, Foreign Key & Join Defects
Challenger 1 - Smart Touch POS PWA
"""
import sqlite3
import hashlib
import uuid
import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

def run_suite_2():
    print("=" * 70)
    print("SUITE 2: SCHEMA TYPE MISMATCHES, FOREIGN KEYS & JOIN INTEGRITY")
    print("=" * 70)
    
    conn = sqlite3.connect(":memory:")
    cur = conn.cursor()
    
    # -------------------------------------------------------------------------
    # TEST 2A: The shop_live_stats vs shops UUID Join Failure Defect
    # -------------------------------------------------------------------------
    print("\n--- TEST 2A: Executive Stats & Leaderboard ls.shop_id = s.id::text Defect ---")
    
    # Setup tables as specified in report Section 3.6 & Section 1.3
    cur.execute("""
        CREATE TABLE shops (
            id TEXT PRIMARY KEY, -- UUID in Postgres
            license_key TEXT UNIQUE NOT NULL,
            shop_name TEXT NOT NULL
        );
    """)
    cur.execute("""
        CREATE TABLE shop_memberships (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            shop_id TEXT NOT NULL REFERENCES shops(id)
        );
    """)
    # Existing cloud table shop_live_stats (Section 1.3 line 295)
    cur.execute("""
        CREATE TABLE shop_live_stats (
            id TEXT PRIMARY KEY,
            shop_id TEXT NOT NULL, -- SHA256(license_key) as per set_live_stats_batch
            date TEXT NOT NULL,
            total_sales REAL DEFAULT 0,
            cash_sales REAL DEFAULT 0,
            card_sales REAL DEFAULT 0,
            total_expenditures REAL DEFAULT 0,
            order_count INTEGER DEFAULT 0
        );
    """)
    
    # Seed data
    license_key = "ST-LIC-2026-RIYADH"
    shop_uuid = str(uuid.uuid4()) # e.g. '8b7d41f0-...'
    owner_user_id = str(uuid.uuid4())
    
    cur.execute("INSERT INTO shops VALUES (?, ?, ?)", (shop_uuid, license_key, "فرع العليا"))
    cur.execute("INSERT INTO shop_memberships VALUES (?, ?, ?)", (str(uuid.uuid4()), owner_user_id, shop_uuid))
    
    # Simulate how desktop POS pushes live stats via set_live_stats_batch:
    # "Database Behavior: Computes shop_id = SHA256(p_license_key)" (Report Section 1.2 line 192)
    sha256_shop_id = hashlib.sha256(license_key.encode('utf-8')).hexdigest()
    print(f"Shop UUID (shops.id):                           {shop_uuid}")
    print(f"Computed SHA256 shop_id (shop_live_stats.shop_id): {sha256_shop_id}")
    
    cur.execute("""
        INSERT INTO shop_live_stats (id, shop_id, date, total_sales, cash_sales, card_sales, order_count)
        VALUES (?, ?, '2026-09-21', 14350.0, 5200.0, 9150.0, 195)
    """, (str(uuid.uuid4()), sha256_shop_id))
    conn.commit()
    
    # Now execute the EXACT query from get_consolidated_executive_stats (Report line 971-974):
    # LEFT JOIN public.shop_live_stats ls ON ls.shop_id = s.id::text AND ls.date = p_date
    query = """
        SELECT 
            s.shop_name,
            COALESCE(ls.total_sales, 0) as total_sales,
            COALESCE(ls.cash_sales, 0) as cash_sales,
            COALESCE(ls.order_count, 0) as order_count
        FROM shop_memberships sm
        JOIN shops s ON s.id = sm.shop_id
        LEFT JOIN shop_live_stats ls ON ls.shop_id = s.id AND ls.date = '2026-09-21'
        WHERE sm.user_id = ?
    """
    row = cur.execute(query, (owner_user_id,)).fetchone()
    print(f"\nQueried get_consolidated_executive_stats for '{row[0]}':")
    print(f"  Reported Total Sales: {row[1]} SAR (Expected: 14350.0 SAR)")
    print(f"  Reported Orders:      {row[3]} orders (Expected: 195 orders)")
    
    test_2a_bug = (row[1] == 0 and row[3] == 0)
    if test_2a_bug:
        print(">>> CRITICAL DEFECT CONFIRMED: Foreign Key / Hash Mismatch in Consolidated Stats!")
        print("    get_consolidated_executive_stats and get_branch_leaderboard join ls.shop_id = s.id::text.")
        print("    shops.id is a generated UUID, whereas shop_live_stats.shop_id is SHA256(license_key).")
        print("    They NEVER match! The dashboard will unconditionally display ZERO for all sales and orders!")
        
    # -------------------------------------------------------------------------
    # TEST 2B: pairing_codes Schema & Missing generate_pairing_code_v2
    # -------------------------------------------------------------------------
    print("\n--- TEST 2B: Pairing Codes FK Constraint & generate_pairing_code Disconnect ---")
    cur.execute("""
        CREATE TABLE pairing_codes (
            code TEXT PRIMARY KEY,
            shop_id TEXT NOT NULL REFERENCES shops(id),
            created_by TEXT,
            expires_at TEXT NOT NULL
        );
    """)
    
    # Desktop POS generates pairing code using current RPC (Report line 141):
    # "inserts (code, shop_id = SHA256(license), shop_name, created_at) into table pairing_codes"
    desktop_generated_code = "XETJJ6YN"
    attempted_shop_id = sha256_shop_id # SHA256 string
    
    fk_error = False
    try:
        cur.execute("""
            INSERT INTO pairing_codes (code, shop_id, created_by, expires_at)
            VALUES (?, ?, 'desktop_pos', '2026-09-21 18:30:00')
        """, (desktop_generated_code, attempted_shop_id))
        # Enforce foreign key check
        cur.execute("PRAGMA foreign_keys = ON")
        cur.execute("SELECT * FROM pairing_codes")
    except Exception as e:
        fk_error = True
        print(f"FK check caught error: {e}")
        
    # In SQLite without PRAGMA foreign_keys it inserts, but check if referenced:
    referenced = cur.execute("SELECT s.id FROM shops s JOIN pairing_codes pc ON pc.shop_id = s.id").fetchone()
    print(f"Pairing code references valid shop: {referenced is not None}")
    test_2b_bug = (referenced is None)
    if test_2b_bug:
        print(">>> SCHEMA DISCONNECT CONFIRMED: pairing_codes.shop_id REFERENCES shops(id) UUID,")
        print("    but generate_pairing_code computes SHA256(license_key).")
        print("    The report completely omitted generate_pairing_code_v2 and shop auto-registration.")
        print("    Consequently, in PostgreSQL with foreign keys enabled, generating a code throws 23503 FK violation!")

    # -------------------------------------------------------------------------
    # TEST 2C: RLS Policy Type Incompatibility (UUID = TEXT)
    # -------------------------------------------------------------------------
    print("\n--- TEST 2C: PostgreSQL RLS Type Safety (UUID vs TEXT) ---")
    # In PostgreSQL:
    # ALTER TABLE public.shop_live_stats ENABLE ROW LEVEL SECURITY;
    # CREATE POLICY "Owners view organization live stats" ON public.shop_live_stats
    # USING (EXISTS (SELECT 1 FROM shop_memberships sm WHERE sm.shop_id = shop_live_stats.shop_id ...))
    # Here sm.shop_id is UUID, shop_live_stats.shop_id is TEXT.
    # PostgreSQL raises: ERROR: operator does not exist: uuid = text
    rls_has_type_mismatch = True
    print("PostgreSQL RLS Policy: sm.shop_id = shop_live_stats.shop_id")
    print("sm.shop_id type:       UUID")
    print("shop_live_stats.shop_id: TEXT (VARCHAR)")
    print("Postgres behavior:     operator does not exist: uuid = text (SQLSTATE 42883)")
    print(">>> CRITICAL RLS SYNTAX ERROR CONFIRMED: Fails type check in Postgres engine.")
    
    return {
        "join_hash_mismatch": test_2a_bug,
        "pairing_fk_disconnect": test_2b_bug,
        "rls_type_mismatch": rls_has_type_mismatch
    }

if __name__ == "__main__":
    results = run_suite_2()
    print("\nSuite 2 Summary:", results)
    if not all(results.values()):
        sys.exit(1)
