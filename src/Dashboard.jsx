import { useState, useEffect } from 'react';
import { supabase } from './supabase';
import { RefreshCw, Store, LogOut, Receipt, TrendingUp, CreditCard, Banknote, Plus } from 'lucide-react';

export default function Dashboard({ onLogout }) {
  const [shifts, setShifts] = useState([]);
  const [liveStats, setLiveStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [shops, setShops] = useState([]);
  const [selectedShop, setSelectedShop] = useState('');
  const [activeTab, setActiveTab] = useState('live'); // 'live', 'shifts', 'expenses'
  
  // Expense Form
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseDesc, setExpenseDesc] = useState('');
  const [addingExpense, setAddingExpense] = useState(false);

  const fetchLicenses = async () => {
    const { data } = await supabase.from('owner_licenses').select('shop_id, shop_name').is('revoked_at', null);
    if (data && data.length > 0) {
      setShops(data);
      if (!selectedShop) setSelectedShop(data[0].shop_id);
    }
  };

  const fetchShifts = async () => {
    if (!selectedShop) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('shop_shifts')
      .select('*')
      .eq('shop_id', selectedShop)
      .order('opened_at', { ascending: false })
      .limit(10);
      
    if (data) setShifts(data);
    setLoading(false);
  };

  const fetchLiveStats = async () => {
    if (!selectedShop) return;
    const today = new Date().toISOString().split('T')[0];
    const { data } = await supabase
      .from('shop_live_stats')
      .select('*')
      .eq('shop_id', selectedShop)
      .eq('date', today)
      .single();
    
    if (data) setLiveStats(data);
    else setLiveStats({ total_sales: 0, cash_sales: 0, card_sales: 0, total_expenditures: 0, order_count: 0 });
  };

  useEffect(() => {
    fetchLicenses();
  }, []);

  useEffect(() => {
    if (selectedShop) {
      fetchShifts();
      fetchLiveStats();
      
      const channel = supabase.channel('dashboard-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'shop_live_stats', filter: `shop_id=eq.${selectedShop}` }, payload => {
          fetchLiveStats();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'shop_shifts', filter: `shop_id=eq.${selectedShop}` }, payload => {
          fetchShifts();
        })
        .subscribe();
        
      return () => {
        supabase.removeChannel(channel);
      };
    }
  }, [selectedShop]);

  const handleAddExpense = async (e) => {
    e.preventDefault();
    if (!expenseAmount || !expenseDesc) return;
    setAddingExpense(true);
    const { error } = await supabase.rpc('add_remote_expense', {
      p_amount: parseFloat(expenseAmount),
      p_description: expenseDesc
    });
    setAddingExpense(false);
    if (!error) {
      setExpenseAmount('');
      setExpenseDesc('');
      alert('تم إضافة المصروف بنجاح. سيظهر في نقاط البيع قريباً.');
    } else {
      alert('حدث خطأ أثناء إضافة المصروف: ' + error.message);
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-app">
      <header className="bg-card p-4 shadow-sm flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-blue-400 to-blue-600 rounded-xl flex items-center justify-center text-white text-lg shadow-md">🏪</div>
          <div>
            <h1 className="font-black text-main leading-tight">البصمة الذكية</h1>
            <p className="text-[10px] font-bold text-primary">المتابعة المباشرة</p>
          </div>
        </div>
        <button onClick={onLogout} className="p-2 text-muted hover:bg-subtle rounded-lg transition-colors"><LogOut size={20} /></button>
      </header>

      <main className="p-4 flex-1 overflow-y-auto">
        {shops.length > 1 && (
          <div className="mb-4">
            <select
              value={selectedShop}
              onChange={e => setSelectedShop(e.target.value)}
              className="inp font-bold appearance-none bg-white"
            >
              {shops.map(s => (
                <option key={s.shop_id} value={s.shop_id}>{s.shop_name}</option>
              ))}
            </select>
          </div>
        )}

        <div className="flex gap-2 mb-6 p-1 bg-subtle rounded-xl">
          <button 
            className={`flex-1 py-2 text-sm font-bold rounded-lg transition-colors ${activeTab === 'live' ? 'bg-white shadow-sm text-primary' : 'text-muted'}`}
            onClick={() => setActiveTab('live')}
          >المباشر</button>
          <button 
            className={`flex-1 py-2 text-sm font-bold rounded-lg transition-colors ${activeTab === 'shifts' ? 'bg-white shadow-sm text-primary' : 'text-muted'}`}
            onClick={() => setActiveTab('shifts')}
          >الورديات</button>
          <button 
            className={`flex-1 py-2 text-sm font-bold rounded-lg transition-colors ${activeTab === 'expenses' ? 'bg-white shadow-sm text-primary' : 'text-muted'}`}
            onClick={() => setActiveTab('expenses')}
          >إضافة مصروف</button>
        </div>

        {activeTab === 'live' && (
          <div className="space-y-4">
             <div className="bg-gradient-to-br from-blue-600 to-blue-800 rounded-2xl p-6 shadow-md text-white relative overflow-hidden">
                <div className="absolute -right-4 -top-4 opacity-10">
                  <TrendingUp size={100} />
                </div>
                <h3 className="text-sm font-bold opacity-80 mb-1">مبيعات اليوم</h3>
                <div className="text-4xl font-black mb-4 dir-ltr">
                  {Number(liveStats?.total_sales || 0).toFixed(2)}
                </div>
                
                <div className="grid grid-cols-2 gap-4 pt-4 border-t border-white/20">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider opacity-70 mb-1 font-bold">كاش</div>
                    <div className="font-bold text-lg dir-ltr">{Number(liveStats?.cash_sales || 0).toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider opacity-70 mb-1 font-bold">شبكة</div>
                    <div className="font-bold text-lg dir-ltr">{Number(liveStats?.card_sales || 0).toFixed(2)}</div>
                  </div>
                </div>
             </div>

             <div className="grid grid-cols-2 gap-4">
                <div className="bg-white rounded-2xl p-4 shadow-sm border border-subtle">
                  <h4 className="text-xs font-bold text-muted mb-2">إجمالي الطلبات</h4>
                  <div className="text-xl font-black text-main">{liveStats?.order_count || 0}</div>
                </div>
                <div className="bg-white rounded-2xl p-4 shadow-sm border border-subtle">
                  <h4 className="text-xs font-bold text-muted mb-2">إجمالي المصروفات</h4>
                  <div className="text-xl font-black text-red-500 dir-ltr">{Number(liveStats?.total_expenditures || 0).toFixed(2)}</div>
                </div>
             </div>
          </div>
        )}

        {activeTab === 'shifts' && (
          shifts.length === 0 && !loading ? (
            <div className="text-center p-10 bg-white rounded-2xl border border-dashed border-subtle">
              <Store size={40} className="mx-auto text-muted mb-3 opacity-50" />
              <p className="text-muted font-bold">لا يوجد ورديات مسجلة</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {shifts.map(shift => (
                <div key={shift.id} className="bg-white rounded-2xl p-5 shadow-sm border border-subtle relative overflow-hidden">
                  <div className={`absolute top-0 right-0 w-1 h-full ${shift.closed_at ? 'bg-subtle' : 'bg-green-500'}`} />
                  
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <div className="font-black text-main flex items-center gap-2">الكاشير: {shift.cashier_name || 'غير معروف'}</div>
                      <div className="text-xs text-muted font-bold mt-1">{new Date(shift.opened_at).toLocaleDateString('ar-SA')}</div>
                    </div>
                    <div className="text-left">
                      <div className="text-[10px] font-bold text-muted uppercase tracking-wider mb-1">إجمالي المبيعات</div>
                      <div className="text-xl font-black text-primary dir-ltr">{Number(shift.total_sales).toFixed(2)}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {activeTab === 'expenses' && (
          <form onSubmit={handleAddExpense} className="bg-white rounded-2xl p-5 shadow-sm border border-subtle">
             <h3 className="text-lg font-black text-main mb-4">تسجيل مصروف جديد</h3>
             <div className="space-y-4">
                <div>
                  <label className="block text-sm font-bold text-muted mb-2">المبلغ</label>
                  <input type="number" step="0.01" required value={expenseAmount} onChange={e => setExpenseAmount(e.target.value)} className="inp w-full font-bold dir-ltr text-left" placeholder="0.00" />
                </div>
                <div>
                  <label className="block text-sm font-bold text-muted mb-2">البيان / الوصف</label>
                  <textarea required value={expenseDesc} onChange={e => setExpenseDesc(e.target.value)} className="inp w-full font-bold resize-none h-24" placeholder="مثال: تعبئة وقود"></textarea>
                </div>
                <button type="submit" disabled={addingExpense} className="btn-primary w-full justify-center text-base py-3">
                  {addingExpense ? 'جاري الحفظ...' : 'حفظ المصروف'}
                </button>
             </div>
          </form>
        )}
      </main>
    </div>
  );
}
