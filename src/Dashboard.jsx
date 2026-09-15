import { useState, useEffect } from 'react';
import { supabase } from './supabase';
import { RefreshCw, Store, LogOut, Receipt, TrendingUp, CreditCard, Banknote } from 'lucide-react';

export default function Dashboard({ onLogout }) {
  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [shops, setShops] = useState([]);
  const [selectedShop, setSelectedShop] = useState('');

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

  useEffect(() => {
    fetchLicenses();
  }, []);

  useEffect(() => {
    if (selectedShop) fetchShifts();
  }, [selectedShop]);

  const activeShop = shops.find(s => s.shop_id === selectedShop);

  return (
    <div className="flex-1 flex flex-col bg-app">
      {/* App Bar */}
      <header className="bg-card p-4 shadow-sm flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-blue-400 to-blue-600 rounded-xl flex items-center justify-center text-white text-lg shadow-md">
            🏪
          </div>
          <div>
            <h1 className="font-black text-main leading-tight">البصمة الذكية</h1>
            <p className="text-[10px] font-bold text-primary">Live Dashboard</p>
          </div>
        </div>
        <button onClick={onLogout} className="p-2 text-muted hover:bg-subtle rounded-lg transition-colors">
          <LogOut size={20} />
        </button>
      </header>

      <main className="p-4 flex-1 overflow-y-auto">
        {/* Shop Switcher */}
        {shops.length > 1 && (
          <div className="mb-6">
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

        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-black text-main">أحدث الورديات</h2>
          <button 
            onClick={fetchShifts}
            className="flex items-center gap-2 px-4 py-2 bg-white text-primary font-bold rounded-full shadow-sm text-sm border border-subtle active:scale-95 transition-transform"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> تحديث
          </button>
        </div>

        {shifts.length === 0 && !loading ? (
          <div className="text-center p-10 bg-white rounded-2xl border border-dashed border-subtle">
            <Store size={40} className="mx-auto text-muted mb-3 opacity-50" />
            <p className="text-muted font-bold">لا يوجد مبيعات مسجلة حتى الآن</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {shifts.map(shift => (
              <div key={shift.id} className="bg-white rounded-2xl p-5 shadow-sm border border-subtle relative overflow-hidden">
                <div className={`absolute top-0 right-0 w-1 h-full ${shift.closed_at ? 'bg-subtle' : 'bg-green-500'}`} />
                
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <div className="font-black text-main flex items-center gap-2">
                      الكاشير: {shift.cashier_name || 'غير معروف'}
                    </div>
                    <div className="text-xs text-muted font-bold mt-1">
                      {new Date(shift.opened_at).toLocaleDateString('ar-SA')} - {new Date(shift.opened_at).toLocaleTimeString('ar-SA', { hour: '2-digit', minute:'2-digit' })}
                    </div>
                  </div>
                  <div className="text-left">
                    <div className="text-[10px] font-bold text-muted uppercase tracking-wider mb-1">إجمالي المبيعات</div>
                    <div className="text-xl font-black text-primary dir-ltr">
                      {Number(shift.total_sales).toFixed(2)}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-subtle">
                  <div className="bg-app p-3 rounded-xl flex items-center gap-3">
                    <div className="bg-white p-2 rounded-lg text-green-600 shadow-sm"><Banknote size={16}/></div>
                    <div>
                      <div className="text-[10px] font-bold text-muted">كاش</div>
                      <div className="font-black text-main text-sm dir-ltr">{Number(shift.cash_sales).toFixed(2)}</div>
                    </div>
                  </div>
                  <div className="bg-app p-3 rounded-xl flex items-center gap-3">
                    <div className="bg-white p-2 rounded-lg text-blue-600 shadow-sm"><CreditCard size={16}/></div>
                    <div>
                      <div className="text-[10px] font-bold text-muted">شبكة</div>
                      <div className="font-black text-main text-sm dir-ltr">{Number(shift.card_sales).toFixed(2)}</div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
