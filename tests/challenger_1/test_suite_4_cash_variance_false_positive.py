# test_suite_4_cash_variance_false_positive.py
"""
Empirical Test Suite 4: Cash Difference False Positive & Remote Expense Pipeline Disconnect
Challenger 1 - Smart Touch POS PWA
"""
import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
import sqlite3

def run_suite_4():
    print("=" * 70)
    print("SUITE 4: CASH VARIANCE FALSE POSITIVES & REMOTE EXPENSE PIPELINE")
    print("=" * 70)
    
    conn = sqlite3.connect(":memory:")
    cur = conn.cursor()
    
    # Setup schema as proposed in Section 3.6
    cur.execute("""
        CREATE TABLE shop_shifts_v2 (
            id TEXT PRIMARY KEY,
            shop_id TEXT,
            cashier_name TEXT,
            opened_at TEXT,
            closed_at TEXT,
            starting_cash REAL,
            expected_cash REAL,
            actual_cash REAL,
            cash_difference REAL,
            status TEXT
        );
    """)
    conn.commit()
    
    # -------------------------------------------------------------------------
    # TEST 4A: False Positive Cash Variance Alert on Active Open Shifts
    # -------------------------------------------------------------------------
    print("\n--- TEST 4A: Active Shift Cash Variance False Positive Alert ---")
    
    # Simulate a cashier opening a shift at 2:00 PM with 200 SAR starting float
    # During the shift, they make 3,000 SAR in cash sales.
    # Expected cash in drawer is now: 3,200 SAR.
    # Because shift is OPEN, cashier has NOT performed closing drawer count!
    # actual_cash is 0.0 (or default 0.0)
    
    def simulate_push_shift_data_v2(p_closed_at, p_starting_cash, p_expected_cash, p_actual_cash):
        # Exact logic from push_shift_data_v2 (Report lines 1053-1078):
        v_diff = p_actual_cash - p_expected_cash
        if p_closed_at is None:
            v_status = 'open'
        elif v_diff < -50.00:
            v_status = 'flagged'
        else:
            v_status = 'closed'
            
        cur.execute("""
            INSERT INTO shop_shifts_v2 (id, shop_id, cashier_name, opened_at, closed_at, 
                                        starting_cash, expected_cash, actual_cash, cash_difference, status)
            VALUES ('s1', 'branch-olaya', 'أحمد المنصور', '2026-09-21 14:00:00', ?, ?, ?, ?, ?, ?)
        """, (p_closed_at, p_starting_cash, p_expected_cash, p_actual_cash, v_diff, v_status))
        conn.commit()
        return v_diff, v_status

    # Shift is currently open:
    v_diff, v_status = simulate_push_shift_data_v2(
        p_closed_at=None,
        p_starting_cash=200.0,
        p_expected_cash=3200.0,
        p_actual_cash=0.0 # Uncounted during active shift
    )
    
    print(f"Shift Status:       {v_status}")
    print(f"Computed v_diff:    {v_diff} SAR")
    
    # Now simulate get_branch_leaderboard cash_variance_alert (Report lines 1014 & 1024):
    # (COALESCE(latest_shift.cash_difference, 0) < -50.00) AS cash_variance_alert
    alert_query = cur.execute("""
        SELECT 
            cashier_name,
            cash_difference,
            status,
            (cash_difference < -50.00) AS cash_variance_alert
        FROM shop_shifts_v2
        WHERE shop_id = 'branch-olaya'
        ORDER BY opened_at DESC
        LIMIT 1
    """).fetchone()
    
    print(f"Leaderboard query result:")
    print(f"  Cashier:             {alert_query[0]}")
    print(f"  Drawer Diff:         {alert_query[1]} SAR")
    print(f"  Status:              {alert_query[2]}")
    print(f"  Cash Variance Alert: {bool(alert_query[3])}")
    
    test_4a_bug = bool(alert_query[3]) and (alert_query[2] == 'open')
    if test_4a_bug:
        print(">>> CRITICAL FALSE POSITIVE BUG CONFIRMED:")
        print("    push_shift_data_v2 calculates cash_difference = (0 - expected_cash) = -3200 SAR on OPEN shifts.")
        print("    get_branch_leaderboard checks if cash_difference < -50.00 without checking if shift is CLOSED!")
        print("    Result: EVERY store with an active open shift triggers a fraudulent '🔴 تنبيه عجز درج' alert!")
        print("    Mitigation: Only compute cash_difference when closed_at IS NOT NULL, or check (status = 'flagged').")

    # -------------------------------------------------------------------------
    # TEST 4B: Remote Expense Pipeline Disconnect
    # -------------------------------------------------------------------------
    print("\n--- TEST 4B: Remote Expense Pipeline Disconnect ---")
    # Section 3.6 RPC add_remote_expense_v2 writes to shop_remote_commands:
    # INSERT INTO public.shop_remote_commands (shop_id, command_type, payload_json)
    
    # But desktop engine supabaseSync.cjs:191 calls pull_pending_expenses:
    # "SELECT * FROM remote_expenses WHERE shop_id = ... AND synced_to_pos = false"
    
    cur.execute("""
        CREATE TABLE shop_remote_commands (
            id TEXT PRIMARY KEY,
            command_type TEXT,
            payload TEXT,
            status TEXT
        );
    """)
    cur.execute("""
        CREATE TABLE remote_expenses (
            id TEXT PRIMARY KEY,
            amount REAL,
            description TEXT,
            synced_to_pos INTEGER
        );
    """)
    conn.commit()
    
    # PWA executes add_remote_expense_v2:
    cur.execute("INSERT INTO shop_remote_commands VALUES ('cmd-1', 'ADD_EXPENSE', '{\"amount\": 150}', 'pending')")
    conn.commit()
    
    # Desktop POS executes pullPendingExpenses:
    desktop_pulled = cur.execute("SELECT * FROM remote_expenses WHERE synced_to_pos = 0").fetchall()
    print(f"PWA wrote to 'shop_remote_commands': 1 record")
    print(f"Desktop polled 'remote_expenses':    {len(desktop_pulled)} records")
    
    test_4b_bug = (len(desktop_pulled) == 0)
    if test_4b_bug:
        print(">>> ARCHITECTURAL DISCONNECT CONFIRMED:")
        print("    add_remote_expense_v2 writes to 'shop_remote_commands' table,")
        print("    while desktop bridge supabaseSync.cjs polls 'remote_expenses' via pull_pending_expenses.")
        print("    The report provides NO bridging RPC (pull_remote_commands or ack_remote_command).")
        print("    Remote expenses submitted via the new RPC will NEVER reach the POS register!")
        
    return {
        "cash_variance_false_positive": test_4a_bug,
        "remote_expense_disconnect": test_4b_bug
    }

if __name__ == "__main__":
    results = run_suite_4()
    print("\nSuite 4 Summary:", results)
    if not all(results.values()):
        sys.exit(1)
