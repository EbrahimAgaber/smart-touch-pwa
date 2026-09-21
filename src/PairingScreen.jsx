/**
 * src/PairingScreen.jsx
 * P0.2: Updated to call exchange_pairing_code_v2 (6-digit numeric, FOR UPDATE locked).
 * Falls back to legacy exchange_pairing_code if v2 RPC not yet deployed.
 *
 * P0.2 changes:
 *   - Input: digits only, max 6 characters (was 8-char alphanumeric)
 *   - RPC: exchange_pairing_code_v2 (returns { success, shop_id, shop_name })
 *   - Error: P0002 SQLSTATE → "رمز الاقتران منتهي أو تم استخدامه مسبقاً"
 */
import { useState } from 'react';
import { supabase } from './supabase';
import { Smartphone, CheckCircle2, ArrowRight } from 'lucide-react';

export default function PairingScreen({ onPaired }) {
  const [code,      setCode]      = useState('');
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState('');
  const [success,   setSuccess]   = useState(false);
  const [shopName,  setShopName]  = useState('');

  const handlePair = async (e) => {
    e.preventDefault();
    // P0.2: 6-digit code (was min 8)
    if (!code || code.length < 6) return;

    setLoading(true);
    setError('');

    try {
      // P0.2: Try exchange_pairing_code_v2 first
      let data, rpcError;
      ({ data, error: rpcError } = await supabase.rpc('exchange_pairing_code_v2', {
        p_code: code.trim()
      }));

      if (rpcError) {
        // If v2 RPC not yet deployed, fall back to legacy
        if (rpcError.code === 'PGRST202' || rpcError.message?.includes('does not exist')) {
          console.warn('[PairingScreen] exchange_pairing_code_v2 not found, falling back to legacy');
          ({ data, error: rpcError } = await supabase.rpc('exchange_pairing_code', {
            p_code: code.toUpperCase()
          }));
          if (rpcError) throw rpcError;
          // Legacy returns shop_name string directly
          setShopName(typeof data === 'string' ? data : data?.shop_name || 'متجرك');
        } else {
          throw rpcError;
        }
      } else {
        setShopName(data?.shop_name || 'متجرك');
      }

      // Persist license cache for offline boot (P0.9)
      localStorage.setItem('st_pos_has_license', 'true');

      setSuccess(true);
      setTimeout(() => onPaired(), 2000);
    } catch (err) {
      // P0.2: User-friendly error for consumed/expired codes
      const msg = err.message || '';
      if (msg.includes('P0002') || msg.includes('منتهي') || msg.includes('استخدامه')) {
        setError('رمز الاقتران منتهي الصلاحية أو تم استخدامه مسبقاً. يرجى توليد رمز جديد من نظام الكاشير.');
      } else if (msg.includes('28000') || msg.includes('غير مسجل')) {
        setError('يرجى تسجيل الدخول أولاً قبل ربط المتجر.');
      } else {
        setError(msg || 'رمز الاقتران غير صحيح. يرجى التحقق والمحاولة مجدداً.');
      }
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
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
    <div className="flex-1 flex flex-col p-6">
      <div className="flex-1 flex flex-col justify-center max-w-md mx-auto w-full">
        <div className="text-center mb-10">
          <div className="w-20 h-20 bg-gradient-to-br from-blue-400 to-blue-600 text-white rounded-3xl flex items-center justify-center text-4xl shadow-xl mx-auto mb-6">
            🏪
          </div>
          <h1 className="text-3xl font-black text-main mb-3">تطبيق البصمة الذكية</h1>
          <p className="text-muted text-base leading-relaxed">
            أدخل رمز الاقتران المكوّن من 6 أرقام الظاهر على شاشة الكاشير لربط متجرك.
          </p>
        </div>

        <form onSubmit={handlePair} className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="• • • • • •"
              value={code}
              onChange={(e) => {
                // P0.2: digits only, max 6 chars
                const cleaned = e.target.value.replace(/\D/g, '').slice(0, 6);
                setCode(cleaned);
              }}
              className="inp text-center text-3xl tracking-[0.4em] font-bold font-mono"
              maxLength={6}
              autoComplete="one-time-code"
            />
            {error && (
              <p className="text-danger text-sm font-bold text-center mt-2 bg-red-50 p-3 rounded-lg border border-red-200" role="alert">
                ⚠️ {error}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading || code.length < 6}
            className="btn btn-primary w-full text-lg shadow-blue-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'جاري التحقق...' : 'ربط المتجر'}
          </button>
        </form>
      </div>
    </div>
  );
}
