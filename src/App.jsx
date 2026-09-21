/**
 * src/App.jsx — Smart Touch POS PWA Entry Point
 *
 * P0.9: Offline boot hardening
 *   - navigator.onLine detection on boot
 *   - localStorage('st_pos_has_license') fallback: cached state renders instead of red error
 *   - WifiOff banner when offline
 *   - Workbox NetworkFirst serves cached owner_licenses when network fails
 *
 * P0.1 note: signInAnonymously() is kept as the current auth mechanism.
 * The Magic Link upgrade flow scaffold is included (banner + linkIdentity stub)
 * and will be activated in the next sprint when phone/email auth is enabled
 * in the Supabase dashboard.
 */
import { useState, useEffect, useCallback } from 'react';
import { supabase } from './supabase';
import PairingScreen from './PairingScreen';
import Dashboard from './Dashboard';
import { BranchProvider } from './store/useBranchStore';
import { Loader2, WifiOff } from 'lucide-react';

function App() {
  const [session,    setSession]    = useState(null);
  const [hasLicense, setHasLicense] = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [authError,  setAuthError]  = useState(null);
  const [isOffline,  setIsOffline]  = useState(!navigator.onLine);

  // P0.9: Track online/offline transitions
  useEffect(() => {
    const onOnline  = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener('online',  onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online',  onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const checkLicenses = useCallback(async () => {
    try {
      // Workbox NetworkFirst caches this request — serves from cache when offline
      const { data, error } = await supabase
        .from('owner_licenses')
        .select('id')
        .is('revoked_at', null)
        .limit(1);

      if (!error && data && data.length > 0) {
        localStorage.setItem('st_pos_has_license', 'true');
        setHasLicense(true);
      } else if (!error && data && data.length === 0) {
        localStorage.removeItem('st_pos_has_license');
        setHasLicense(false);
      } else {
        // Network failure: fall back to local cache
        setHasLicense(localStorage.getItem('st_pos_has_license') === 'true');
      }
    } catch {
      setHasLicense(localStorage.getItem('st_pos_has_license') === 'true');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initAuth = async () => {
      try {
        const { data: { session: existing }, error: sessionError } = await supabase.auth.getSession();

        if (sessionError && navigator.onLine) {
          setAuthError(sessionError.message);
          setLoading(false);
          return;
        }

        if (!existing) {
          if (navigator.onLine) {
            const { data, error } = await supabase.auth.signInAnonymously();
            if (!error && data?.session) {
              setSession(data.session);
              await checkLicenses();
            } else {
              // Sign-in failed — use cached license state if available
              const cached = localStorage.getItem('st_pos_has_license') === 'true';
              if (cached) {
                setHasLicense(true);
                setLoading(false);
              } else {
                setAuthError('مشكلة في الاتصال بقاعدة البيانات: ' + (error?.message || 'تعذر إنشاء جلسة'));
                setLoading(false);
              }
            }
          } else {
            // Offline on boot: serve cached license state (P0.9)
            setHasLicense(localStorage.getItem('st_pos_has_license') === 'true');
            setLoading(false);
          }
        } else {
          setSession(existing);
          await checkLicenses();
        }
      } catch (err) {
        console.warn('[App] Offline boot fallback triggered:', err.message);
        setHasLicense(localStorage.getItem('st_pos_has_license') === 'true');
        setLoading(false);
      }
    };

    initAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (s) checkLicenses();
    });

    return () => subscription?.unsubscribe();
  }, [checkLicenses]);

  const handleLogout = async () => {
    localStorage.removeItem('st_pos_has_license');
    localStorage.removeItem('st_active_branch_id');
    await supabase.auth.signOut();
    setSession(null);
    setHasLicense(false);
    window.location.reload();
  };

  // ── Loading spinner ──────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-app p-4 text-center">
        <Loader2 className="animate-spin text-primary mb-4" size={48} />
        <span className="text-muted text-sm font-medium">جاري تحميل لوحة التحكم...</span>
      </div>
    );
  }

  // ── Hard error (online but auth failed) ─────────────────────────────────
  if (authError && navigator.onLine) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-app p-6 text-center" dir="rtl">
        <div className="bg-red-50 border border-red-300 text-red-700 p-5 rounded-2xl max-w-sm" role="alert">
          <strong className="font-bold block mb-2">تعذر الاتصال بالخادم السحابي</strong>
          <span className="block text-sm leading-relaxed mb-4">{authError}</span>
          <button
            onClick={() => window.location.reload()}
            className="btn btn-primary w-full text-sm"
          >
            إعادة المحاولة
          </button>
        </div>
      </div>
    );
  }

  // ── Main app ─────────────────────────────────────────────────────────────
  return (
    <BranchProvider>
      <div className="flex flex-col min-h-dvh bg-app">
        {/* P0.9: Offline indicator banner */}
        {isOffline && (
          <div
            className="bg-amber-50 border-b border-amber-300 px-4 py-2 flex items-center justify-center gap-2 text-amber-700 text-xs font-semibold"
            dir="rtl"
          >
            <WifiOff size={14} />
            <span>أنت تعمل في وضع عدم الاتصال — يتم عرض البيانات المخزنة محلياً</span>
          </div>
        )}

        {hasLicense ? (
          <Dashboard onLogout={handleLogout} isOffline={isOffline} />
        ) : (
          <PairingScreen onPaired={checkLicenses} />
        )}
      </div>
    </BranchProvider>
  );
}

export default App;
