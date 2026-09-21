# test_suite_3_edge_cases_and_timezone.py
"""
Empirical Test Suite 3: Edge Cases, Timezone Drift, and Network Drop Simulation
Challenger 1 - Smart Touch POS PWA
"""
import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
import datetime
import sqlite3

def run_suite_3():
    print("=" * 70)
    print("SUITE 3: EDGE CASES, TIMEZONE DRIFT & TWO-PHASE PULL ATOMICITY")
    print("=" * 70)
    
    # -------------------------------------------------------------------------
    # TEST 3A: AST (UTC+3) vs UTC Date Boundary Drift
    # -------------------------------------------------------------------------
    print("\n--- TEST 3A: AST vs UTC Date Boundary Misattribution (00:00 - 03:00) ---")
    
    # Simulate a transaction occurring at 01:30 AM AST on September 22, 2026
    # In ISO / UTC: 2026-09-21T22:30:00Z
    ast_tz = datetime.timezone(datetime.timedelta(hours=3))
    sale_time_ast = datetime.datetime(2026, 9, 22, 1, 30, 0, tzinfo=ast_tz)
    sale_time_utc = sale_time_ast.astimezone(datetime.timezone.utc)
    
    # Desktop JS syncLiveStats calculation (Report Section 1.6 & supabaseSync.cjs:72):
    # const today = new Date().toISOString().split('T')[0];
    js_date_pushed = sale_time_utc.strftime("%Y-%m-%d")
    local_calendar_date = sale_time_ast.strftime("%Y-%m-%d")
    
    print(f"Local Transaction Time (Saudi AST): {sale_time_ast.isoformat()}")
    print(f"Local Store Calendar Date:          {local_calendar_date}")
    print(f"JS toISOString().split('T')[0]:     {js_date_pushed}")
    
    test_3a_bug = (js_date_pushed != local_calendar_date)
    if test_3a_bug:
        print(">>> CRITICAL TIMEZONE DRIFT CONFIRMED:")
        print(f"    Sales occurring on {local_calendar_date} between 12:00 AM and 3:00 AM AST")
        print(f"    are pushed into {js_date_pushed} in the cloud!")
        print("    Today's sales appear as 0, while yesterday's closed sales are retrospectively inflated.")
        
    # Also verify Postgres CURRENT_DATE default parameter:
    # Supabase PostgreSQL runs in UTC. At 01:30 AM AST, CURRENT_DATE is still yesterday!
    postgres_utc_date = sale_time_utc.strftime("%Y-%m-%d")
    print(f"\nPostgreSQL Supabase CURRENT_DATE at 01:30 AM AST: {postgres_utc_date}")
    print(f"get_consolidated_executive_stats(p_date DEFAULT CURRENT_DATE) evaluates to: {postgres_utc_date}")
    if postgres_utc_date != local_calendar_date:
        print(">>> REPORT DEFECT CONFIRMED: The report fixed JS timezone in Section 1.6, but in Section 3.6")
        print("    wrote SQL RPCs using 'p_date DATE DEFAULT CURRENT_DATE' which re-introduces the identical UTC bug!")
        
    # -------------------------------------------------------------------------
    # TEST 3B: Network Drop During pull_pending_expenses (Atomicity Gap)
    # -------------------------------------------------------------------------
    print("\n--- TEST 3B: Two-Phase Pull Atomicity Failure Simulation ---")
    
    # Supabase remote_expenses table
    supabase_remote_expenses = [
        {"id": "exp-001", "amount": 250.0, "description": "شراء حبر طابعة", "synced_to_pos": False},
        {"id": "exp-002", "amount": 100.0, "description": "مشروبات ضيافة", "synced_to_pos": False}
    ]
    
    # Local SQLite expenditures table
    sqlite_conn = sqlite3.connect(":memory:")
    sqlite_cur = sqlite_conn.cursor()
    sqlite_cur.execute("""
        CREATE TABLE expenditures (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            description TEXT,
            amount REAL,
            expense_date DATE
        )
    """)
    sqlite_conn.commit()
    
    # Simulate current pull_pending_expenses RPC behavior:
    # 1. Server marks synced_to_pos = true and returns data
    def simulate_server_pull(expenses_db):
        pending = [e for e in expenses_db if not e["synced_to_pos"]]
        # In current RPC, synced_to_pos is flipped to true IMMEDIATELY on pull
        for e in pending:
            e["synced_to_pos"] = True
        return pending
        
    pulled_items = simulate_server_pull(supabase_remote_expenses)
    print(f"Desktop pulled {len(pulled_items)} expenses from Supabase.")
    print("Supabase state immediately after pull: all records marked synced_to_pos = True")
    
    # 2. Desktop attempts to insert into SQLite, but CRASHES on item 2 (e.g. SQLite locked or crash)
    print("Simulating desktop crash/failure during SQLite batch insertion...")
    try:
        # Insert item 1 successfully
        sqlite_cur.execute("INSERT INTO expenditures (description, amount) VALUES (?, ?)", 
                           (pulled_items[0]["description"], pulled_items[0]["amount"]))
        # CRASH before item 2 is committed
        raise sqlite3.OperationalError("database is locked / process terminated unexpectedly")
    except Exception as e:
        print(f"Crash simulated: {e}")
        
    # Now desktop recovers and runs next sync loop:
    recovered_pull = simulate_server_pull(supabase_remote_expenses)
    print(f"Subsequent sync cycle pulled: {len(recovered_pull)} items")
    
    # Check local SQLite contents
    local_count = sqlite_cur.execute("SELECT COUNT(*) FROM expenditures").fetchone()[0]
    print(f"Local SQLite expenditures count: {local_count} (Expected: 2)")
    
    test_3b_bug = (len(recovered_pull) == 0 and local_count == 1)
    if test_3b_bug:
        print(">>> FINANCIAL DATA LOSS CONFIRMED: Item 'exp-002' (100.0 SAR) was permanently lost!")
        print("    Supabase marked it synced, desktop crashed before writing to SQLite,")
        print("    and subsequent pulls return nothing. The money was spent, but never recorded in POS ledger.")
        print("    The report identified this gap, but completely failed to provide the 'ack_expenses' RPC in Section 3.6.")

    # -------------------------------------------------------------------------
    # TEST 3C: Clock Drift Future-Date Poisoning on latest_shift
    # -------------------------------------------------------------------------
    print("\n--- TEST 3C: Clock Drift Future-Date Poisoning in Leaderboard ---")
    cloud_conn = sqlite3.connect(":memory:")
    c_cur = cloud_conn.cursor()
    c_cur.execute("""
        CREATE TABLE shop_shifts_v2 (
            id TEXT PRIMARY KEY,
            shop_id TEXT,
            cashier_name TEXT,
            opened_at TEXT,
            cash_difference REAL
        )
    """)
    
    # Shift 1: CMOS battery glitch set year to 2027
    c_cur.execute("INSERT INTO shop_shifts_v2 VALUES ('1', 'shop-1', 'Ghost Cashier', '2027-01-01 10:00:00', -150.0)")
    # Shift 2: Real shift today (2026-09-21)
    c_cur.execute("INSERT INTO shop_shifts_v2 VALUES ('2', 'shop-1', 'Real Cashier Ahmad', '2026-09-21 14:00:00', 0.0)")
    cloud_conn.commit()
    
    # Query from get_branch_leaderboard (Report line 1018-1024):
    # SELECT cashier_name FROM shop_shifts_v2 WHERE shop_id = s.id ORDER BY opened_at DESC LIMIT 1
    selected = c_cur.execute("""
        SELECT cashier_name, cash_difference 
        FROM shop_shifts_v2 
        WHERE shop_id = 'shop-1' 
        ORDER BY opened_at DESC 
        LIMIT 1
    """).fetchone()
    
    print(f"Active shift cashier returned by leaderboard: {selected[0]} (Expected: Real Cashier Ahmad)")
    test_3c_bug = (selected[0] == "Ghost Cashier")
    if test_3c_bug:
        print(">>> POISONING DEFECT CONFIRMED: A single future-drifted opened_at permanently")
        print("    poisons the leaderboard active cashier and cash shortage alert.")
        
    return {
        "ast_utc_drift": test_3a_bug,
        "two_phase_data_loss": test_3b_bug,
        "clock_drift_poisoning": test_3c_bug
    }

if __name__ == "__main__":
    results = run_suite_3()
    print("\nSuite 3 Summary:", results)
    if not all(results.values()):
        sys.exit(1)
