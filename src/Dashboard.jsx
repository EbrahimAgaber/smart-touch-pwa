/**
 * src/Dashboard.jsx — Smart Touch POS Owner Dashboard
 *
 * P0.8: date uses todayAST() (Asia/Riyadh) — no more toISOString()
 * P1.1: add_remote_expense_v2 with explicit p_shop_id
 * P1.3: useBranchStore for instant branch switching + consolidated view
 * P1.4: 360px adaptive grid (grid-cols-1 min-[380px]:grid-cols-2)
 * P1.5: BottomNav replaces top pill tabs; content-bottom-offset padding
 * P1.6: CurrencyDisplay replaces all raw .toFixed(2) dir-ltr usages
 */
import { useState, useEffect, useCallback } from 'react';
import { supabase } from './supabase';
import {
  RefreshCw, Store, LogOut, TrendingUp, TrendingDown,
  AlertTriangle, Wifi, WifiOff
} from 'lucide-react';
import { CurrencyDisplay } from './components/CurrencyDisplay';
import { BottomNav } from './components/BottomNav';
import { useBranchStore } from './store/useBranchStore';
import { callRpcWithSwr } from './services/swrRpcCache';
import { todayAST } from './utils/formatters';

export default function Dashboard({ onLogout, isOffline, onAddBranch }) {
  const {
    branches, activeContext, activeBranch,
    isAllBranches, switchBranch, refreshBranches
  } = useBranchStore();

  const [shifts,       setShifts]       = useState([]);
  const [liveStats,    setLiveStats]     = useState(null);
  const [execStats,    setExecStats]     = useState(null);
  const [loading,      setLoading]       = useState(true);
  const [activeTab,    setActiveTab]     = useState('live');
  const [lastSyncTime, setLastSyncTime]  = useState(null);

  // Expense form
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseDesc,   setExpenseDesc]   = useState('');
  const [expenseShopId, setExpenseShopId] = useState('');
  const [addingExpense, setAddingExpense] = useState(false);

  // ── P0.8: Date helper ────────────────────────────────────────────────────
  const today = todayAST();

  // ── Fetch live stats (single branch) ─────────────────────────────────────
  const fetchLiveStats = useCallback(async (shopId) => {
    if (!shopId) return;
    const { data } = await supabase
      .from('shop_live_stats')
      .select('*')
      .eq('shop_id', shopId)
      .eq('date', today)   // P0.8: AST date
      .single();

    if (data) {
      setLiveStats(data);
      setLastSyncTime(new Date());
    } else {
      setLiveStats({ total_sales: 0, cash_sales: 0, card_sales: 0, total_expenditures: 0, order_count: 0 });
    }
  }, [today]);

  // ── Fetch consolidated stats (all branches, P1.3) ────────────────────────
  const fetchConsolidatedStats = useCallback(() => {
    callRpcWithSwr(supabase, 'get_consolidated_executive_stats', { p_date: today }, {
      onStale: (data)  => setExecStats(data),   // Instant from IndexedDB
      onFresh: (data)  => { setExecStats(data); setLastSyncTime(new Date()); },
      onError: (err)   => console.warn('[Dashboard] Consolidated stats error:', err.message)
    });
  }, [today]);

  // ── Fetch shifts ──────────────────────────────────────────────────────────
  const fetchShifts = useCallback(async (shopId) => {
    if (!shopId) return;
    setLoading(true);
    const { data } = await supabase
      .from('shop_shifts_v2')
      .select('*')
      .eq('shop_id', shopId)
      .order('opened_at', { ascending: false })
      .limit(10);

    if (data) setShifts(data);
    setLoading(false);
  }, []);
  const [inventory,    setInventory]    = useState([]);
  const [loadingInv,   setLoadingInv]   = useState(false);
  const [searchInv,    setSearchInv]    = useState('');

  // ── Fetch inventory ───────────────────────────────────────────────────────
  const fetchInventory = useCallback(async (shopId) => {
    if (!shopId) return;
    setLoadingInv(true);
    const { data } = await supabase
      .from('shop_inventory_items')
      .select('*')
      .eq('shop_id', shopId)
      .order('name');
    if (data) setInventory(data);
    setLoadingInv(false);
  }, []);
  // ── Effect: load data when branch or tab changes ─────────────────────────
  useEffect(() => {
    if (isAllBranches) {
      fetchConsolidatedStats();
      setLoading(false);
    } else if (activeContext) {
      fetchLiveStats(activeContext);
      fetchShifts(activeContext);
      fetchInventory(activeContext);

      const channel = supabase.channel(`dashboard-${activeContext}`)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'shop_live_stats',
          filter: `shop_id=eq.${activeContext}`
        }, () => fetchLiveStats(activeContext))
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'shop_shifts_v2',
          filter: `shop_id=eq.${activeContext}`
        }, () => fetchShifts(activeContext))
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'shop_inventory_items',
          filter: `shop_id=eq.${activeContext}`
        }, () => fetchInventory(activeContext))
        .subscribe();

      return () => supabase.removeChannel(channel);
    }
  }, [activeContext, isAllBranches, fetchLiveStats, fetchShifts, fetchInventory, fetchConsolidatedStats]);

  // ── Default expense shop to active branch ────────────────────────────────
  useEffect(() => {
    if (!isAllBranches && activeContext) {
      setExpenseShopId(activeContext);
    } else if (branches.length > 0) {
      setExpenseShopId(branches[0].shop_id);
    }
  }, [activeContext, isAllBranches, branches]);

  // ── P1.1: Add remote expense with explicit shop ID ────────────────────────
  const handleAddExpense = async (e) => {
    e.preventDefault();
    if (!expenseAmount || !expenseDesc || !expenseShopId) return;
    setAddingExpense(true);

    try {
      // P1.1: add_remote_expense_v2 requires explicit p_shop_id (UUID)
      const { error } = await supabase.rpc('add_remote_expense_v2', {
        p_shop_id:     expenseShopId,
        p_amount:      parseFloat(expenseAmount),
        p_description: expenseDesc,
        p_category:    'مصروفات عامة'
      });

      if (error) {
        // Fallback: legacy RPC (no shop_id, for backward compat)
        if (error.code === 'PGRST202' || error.message?.includes('does not exist')) {
          const { error: legacyErr } = await supabase.rpc('add_remote_expense', {
            p_amount:      parseFloat(expenseAmount),
            p_description: expenseDesc
          });
          if (legacyErr) throw legacyErr;
        } else {
          throw error;
        }
      }

      setExpenseAmount('');
      setExpenseDesc('');
      alert('✅ تم إضافة المصروف بنجاح. سيظهر في نقطة البيع قريباً.');
    } catch (err) {
      alert('⚠️ حدث خطأ: ' + err.message);
    } finally {
      setAddingExpense(false);
    }
  };

  // ── Computed stats (single branch or all branches) ────────────────────────
  const stats = isAllBranches
    ? execStats
    : liveStats;

  const aov = stats?.order_count > 0
    ? (stats.total_sales / stats.order_count)
    : 0;

  const netRevenue = stats
    ? (stats.total_sales || 0) - (stats.total_expenditures || 0)
    : 0;

  const syncLabel = lastSyncTime
    ? `آخر تحديث: ${lastSyncTime.toLocaleTimeString('ar-SA', { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit' })}`
    : '';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 flex flex-col bg-app">

      {/* Header */}
      <header className="bg-card p-4 shadow-sm flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-blue-400 to-blue-600 rounded-xl flex items-center justify-center text-white text-lg shadow-md">
            🏪
          </div>
          <div>
            <h1 className="font-black text-main leading-tight text-base">البصمة الذكية</h1>
            <p className="text-[10px] font-bold text-primary">
              {isAllBranches ? 'جميع الفروع' : (activeBranch?.shop_name || 'لوحة التحكم')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Connection status */}
          {isOffline
            ? <WifiOff size={16} className="text-amber-500" />
            : <Wifi    size={16} className="text-success"   />
          }
          <button onClick={onLogout} className="p-2 text-muted hover:bg-subtle rounded-lg transition-colors" aria-label="تسجيل الخروج">
            <LogOut size={20} />
          </button>
        </div>
      </header>

      {/* Branch selector (shown when multiple branches) */}
      {branches.length > 1 && (
        <div className="px-4 pt-3 flex gap-2 overflow-x-auto scrollbar-none pb-1">
          <button
            onClick={() => switchBranch('all')}
            className={`flex-shrink-0 px-4 py-2 rounded-full text-sm font-bold transition-colors ${
              isAllBranches ? 'bg-primary text-white' : 'bg-white border border-subtle text-muted'
            }`}
          >
            🏢 جميع الفروع
          </button>
          {branches.map(b => (
            <button
              key={b.shop_id}
              onClick={() => switchBranch(b.shop_id)}
              className={`flex-shrink-0 px-4 py-2 rounded-full text-sm font-bold transition-colors ${
                activeContext === b.shop_id ? 'bg-primary text-white' : 'bg-white border border-subtle text-muted'
              }`}
            >
              <span className={`inline-block w-2 h-2 rounded-full ml-1 ${b.is_online ? 'bg-success' : 'bg-subtle'}`} />
              {b.shop_name}
            </button>
          ))}
        </div>
      )}

      {/* Main content — P1.5: content-bottom-offset so BottomNav doesn't cover content */}
      <main className="p-4 flex-1 overflow-y-auto content-bottom-offset">

        {/* ── Live Stats Tab ─────────────────────────────────────────── */}
        {activeTab === 'live' && (
          <div className="space-y-4">

            {/* Sync timestamp */}
            {syncLabel && (
              <p className="text-[11px] text-muted text-center font-medium">{syncLabel}</p>
            )}

            {/* Hero sales card */}
            <div className="bg-gradient-to-br from-blue-600 to-blue-800 rounded-2xl p-6 shadow-md text-white relative overflow-hidden">
              <div className="absolute -right-4 -top-4 opacity-10">
                <TrendingUp size={100} />
              </div>
              <h3 className="text-sm font-bold opacity-80 mb-1">
                {isAllBranches ? 'إجمالي مبيعات اليوم (جميع الفروع)' : 'مبيعات اليوم'}
              </h3>
              {/* P1.6: CurrencyDisplay — no more raw toFixed + dir-ltr */}
              <div className="mb-4">
                <CurrencyDisplay amount={stats?.total_sales || 0} size="xl" color="white" />
              </div>

              <div className="grid grid-cols-2 gap-4 pt-4 border-t border-white/20">
                <div>
                  <div className="text-[10px] uppercase tracking-wider opacity-70 mb-1 font-bold">كاش</div>
                  <CurrencyDisplay amount={stats?.cash_sales || 0} size="sm" color="white" />
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider opacity-70 mb-1 font-bold">شبكة</div>
                  <CurrencyDisplay amount={stats?.card_sales || 0} size="sm" color="white" />
                </div>
              </div>
            </div>

            {/* P1.4: Adaptive grid — 1 column on <380px, 2 columns on >=380px */}
            <div className="grid grid-cols-1 min-[380px]:grid-cols-2 gap-4">
              {/* Orders card */}
              <div className="bg-card rounded-2xl p-4 shadow-sm border border-subtle">
                <h4 className="text-xs font-bold text-muted mb-2">إجمالي الطلبات</h4>
                <div className="text-2xl font-black text-main">{stats?.order_count || 0}</div>
                {aov > 0 && (
                  <div className="text-xs text-muted mt-1 font-medium">
                    متوسط: <CurrencyDisplay amount={aov} size="xs" color="muted" />
                  </div>
                )}
              </div>

              {/* Expenses card */}
              <div className="bg-card rounded-2xl p-4 shadow-sm border border-subtle">
                <h4 className="text-xs font-bold text-muted mb-2">المصروفات اليومية</h4>
                <CurrencyDisplay amount={stats?.total_expenditures || 0} size="lg" color="danger" />
              </div>

              {/* Net revenue card */}
              <div className="bg-card rounded-2xl p-4 shadow-sm border border-subtle">
                <h4 className="text-xs font-bold text-muted mb-2">الإيراد الصافي</h4>
                <CurrencyDisplay
                  amount={netRevenue}
                  size="lg"
                  color={netRevenue >= 0 ? 'success' : 'danger'}
                />
              </div>

              {/* Branch count (all branches only) */}
              {isAllBranches && execStats && (
                <div className="bg-card rounded-2xl p-4 shadow-sm border border-subtle">
                  <h4 className="text-xs font-bold text-muted mb-2">الفروع النشطة</h4>
                  <div className="text-2xl font-black text-main">
                    {execStats.active_branches}
                    <span className="text-sm font-normal text-muted"> / {execStats.total_branches}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Shifts Tab ─────────────────────────────────────────────── */}
        {activeTab === 'shifts' && (
          shifts.length === 0 && !loading ? (
            <div className="text-center p-10 bg-card rounded-2xl border border-dashed border-subtle">
              <Store size={40} className="mx-auto text-muted mb-3 opacity-50" />
              <p className="text-muted font-bold">لا يوجد ورديات مسجلة</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {shifts.map(shift => {
                const isFlagged = shift.status === 'flagged';
                const isOpen    = shift.status === 'open';
                return (
                  <div key={shift.id} className="bg-card rounded-2xl p-5 shadow-sm border border-subtle relative overflow-hidden">
                    <div className={`absolute top-0 right-0 w-1 h-full ${
                      isFlagged ? 'bg-danger' : isOpen ? 'bg-success' : 'bg-subtle'
                    }`} />

                    <div className="flex justify-between items-start mb-3">
                      <div>
                        <div className="font-black text-main">الكاشير: {shift.cashier_name || 'غير معروف'}</div>
                        <div className="text-xs text-muted font-bold mt-1">
                          {new Date(shift.opened_at).toLocaleDateString('ar-SA', { timeZone: 'Asia/Riyadh' })}
                        </div>
                      </div>
                      <div className="text-left">
                        <div className="text-[10px] font-bold text-muted uppercase tracking-wider mb-1">إجمالي المبيعات</div>
                        <CurrencyDisplay amount={shift.total_sales} size="lg" color="default" />
                        <div className="mt-1 flex gap-2 justify-end text-[10px] text-muted">
                          <span>كاش: {shift.cash_sales}</span>
                          <span>شبكة: {shift.card_sales}</span>
                        </div>
                      </div>
                    </div>

                    {/* Cash drawer reconciliation (P0.4 data) */}
                    {shift.closed_at && (
                      <div className={`mt-3 pt-3 border-t border-subtle flex justify-between items-center text-sm ${
                        isFlagged ? 'text-danger font-bold' : 'text-muted'
                      }`}>
                        <span>{isFlagged ? '⚠️ عجز درج:' : '✅ فارق الدرج:'}</span>
                        <CurrencyDisplay
                          amount={shift.cash_difference || 0}
                          size="sm"
                          color={isFlagged ? 'danger' : 'success'}
                          showSign
                        />
                      </div>
                    )}
                    {isOpen && (
                      <div className="mt-3 pt-3 border-t border-subtle text-xs font-bold text-success">
                        🟢 وردية مفتوحة الآن
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )
        )}

        {/* ── Expenses Tab ───────────────────────────────────────────── */}
        {activeTab === 'expenses' && (
          <form onSubmit={handleAddExpense} className="bg-card rounded-2xl p-5 shadow-sm border border-subtle">
            <h3 className="text-lg font-black text-main mb-4">تسجيل مصروف جديد</h3>
            <div className="space-y-4">

              {/* P1.1: Explicit branch selector — no implicit LIMIT 1 */}
              {branches.length > 1 && (
                <div>
                  <label className="block text-sm font-bold text-muted mb-2">الفرع المستهدف</label>
                  <select
                    required
                    value={expenseShopId}
                    onChange={e => setExpenseShopId(e.target.value)}
                    className="inp w-full font-bold"
                  >
                    <option value="">— اختر الفرع —</option>
                    {branches.map(b => (
                      <option key={b.shop_id} value={b.shop_id}>{b.shop_name}</option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-sm font-bold text-muted mb-2">المبلغ (ر.س)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={expenseAmount}
                  onChange={e => setExpenseAmount(e.target.value)}
                  className="inp w-full font-bold dir-ltr text-left"
                  placeholder="0.00"
                />
              </div>

              <div>
                <label className="block text-sm font-bold text-muted mb-2">البيان / الوصف</label>
                <textarea
                  required
                  value={expenseDesc}
                  onChange={e => setExpenseDesc(e.target.value)}
                  className="inp w-full font-bold resize-none h-24"
                  placeholder="مثال: تعبئة وقود"
                />
              </div>

              <button
                type="submit"
                disabled={addingExpense || !expenseShopId}
                className="btn btn-primary w-full justify-center text-base py-3 disabled:opacity-50"
              >
                {addingExpense ? 'جاري الحفظ...' : '💾 حفظ المصروف'}
              </button>
            </div>
          </form>
        )}

        {/* ── Inventory Tab ─────────────────────────────────────────── */}
        {activeTab === 'inventory' && (
          <div className="space-y-4">
            <h3 className="text-lg font-black text-main mb-4">المخزون</h3>
            
            <input
              type="text"
              placeholder="ابحث عن منتج..."
              value={searchInv}
              onChange={e => setSearchInv(e.target.value)}
              className="inp w-full font-bold mb-4"
            />
            
            {loadingInv ? (
              <div className="text-center p-10 text-muted">جاري تحميل المخزون...</div>
            ) : inventory.length === 0 ? (
              <div className="text-center p-10 bg-card rounded-2xl border border-dashed border-subtle">
                <p className="text-4xl mb-4">📦</p>
                <p className="text-muted font-bold">لم تتم مزامنة المخزون بعد من الكاشير.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 min-[380px]:grid-cols-2 gap-3">
                {inventory.filter(item => item.name.includes(searchInv) || (item.barcode && item.barcode.includes(searchInv))).map(item => (
                  <div key={item.id} className="bg-card rounded-xl p-4 shadow-sm border border-subtle flex flex-col justify-between">
                    <div>
                      <div className="font-bold text-main">{item.name}</div>
                      {item.barcode && <div className="text-[10px] font-mono text-muted">{item.barcode}</div>}
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <div className={`text-sm font-black ${item.stock <= item.min_stock_level ? 'text-danger' : 'text-success'}`}>
                        {item.stock} حبة
                      </div>
                      <CurrencyDisplay amount={item.price} size="sm" color="default" />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Branches Tab ───────────────────────────────────────────── */}
        {activeTab === 'branches' && (
          <div className="space-y-3">
            <h3 className="text-lg font-black text-main mb-4">فروعك المتصلة</h3>
            {branches.map(b => (
              <button
                key={b.shop_id}
                onClick={() => { switchBranch(b.shop_id); setActiveTab('live'); }}
                className="w-full bg-card rounded-2xl p-4 shadow-sm border border-subtle text-right flex items-center gap-3"
              >
                <span className={`w-3 h-3 rounded-full flex-shrink-0 ${b.is_online ? 'bg-success' : 'bg-subtle'}`} />
                <div className="flex-1">
                  <div className="font-bold text-main">{b.shop_name}</div>
                  <div className="text-xs text-muted">{b.city} · {b.is_online ? '🟢 متصل' : '⚫ غير متصل'}</div>
                </div>
              </button>
            ))}

            <button
              onClick={onAddBranch}
              className="w-full mt-4 btn btn-primary flex justify-center py-3 text-base shadow-sm"
            >
              ➕ إضافة فرع جديد
            </button>
          </div>
        )}

      </main>

      {/* P1.5: Fixed bottom navigation — replaces top pill tabs */}
      <BottomNav activeTab={activeTab} onTabChange={setActiveTab} />
    </div>
  );
}
