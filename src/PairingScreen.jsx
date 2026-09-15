import { useState, useEffect } from 'react';
import { supabase } from './supabase';
import { Smartphone, CheckCircle2, ArrowRight } from 'lucide-react';

export default function PairingScreen({ onPaired }) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [shopName, setShopName] = useState('');

  const handlePair = async (e) => {
    e.preventDefault();
    if (!code || code.length < 8) return;
    
    setLoading(true);
    setError('');
    
    try {
      const { data, error } = await supabase.rpc('exchange_pairing_code', {
        p_code: code.toUpperCase()
      });
      
      if (error) throw error;
      
      setShopName(data);
      setSuccess(true);
      setTimeout(() => {
        onPaired();
      }, 2000);
    } catch (err) {
      setError(err.message || 'رمز الاقتران غير صحيح أو منتهي الصلاحية.');
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center animate-fade-in">
        <div className="w-20 h-20 bg-green-100 text-green-600 rounded-full flex items-center justify-center mb-6">
          <CheckCircle2 size={40} />
        </div>
        <h2 className="text-2xl font-black mb-2 text-main">تم الربط بنجاح!</h2>
        <p className="text-muted text-lg mb-8">أنت الآن متصل بـ {shopName}</p>
        <div className="flex items-center gap-2 text-primary font-bold animate-pulse">
          جاري تجهيز لوحة التحكم <ArrowRight size={18} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col p-6 animate-fade-in">
      <div className="flex-1 flex flex-col justify-center max-w-md mx-auto w-full">
        <div className="text-center mb-10">
          <div className="w-20 h-20 bg-gradient-to-br from-blue-400 to-blue-600 text-white rounded-3xl flex items-center justify-center text-4xl shadow-xl mx-auto mb-6">
            🏪
          </div>
          <h1 className="text-3xl font-black text-main mb-3">تطبيق البصمة الذكية</h1>
          <p className="text-muted text-base leading-relaxed">
            أدخل رمز الاقتران من نظام الكاشير لربط جهازك ومتابعة تقارير مبيعاتك لحظياً.
          </p>
        </div>

        <form onSubmit={handlePair} className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <input
              type="text"
              placeholder="رمز الاقتران (8 أحرف)"
              value={code}
              onChange={(e) => {
                const cleaned = e.target.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 8);
                setCode(cleaned);
              }}
              className="inp text-center text-2xl tracking-[0.2em] uppercase font-bold"
            />
            {error && (
              <p className="text-danger text-sm font-bold text-center mt-2 bg-red-50 p-3 rounded-lg border border-red-200">
                ⚠️ {error}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading || code.length < 8}
            className="btn btn-primary w-full text-lg shadow-blue-500/30"
          >
            {loading ? 'جاري التحقق...' : 'ربط المتجر'}
          </button>
        </form>
      </div>
    </div>
  );
}
