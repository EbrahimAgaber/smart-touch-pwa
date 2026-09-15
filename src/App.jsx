import { useState, useEffect } from 'react';
import { supabase } from './supabase';
import PairingScreen from './PairingScreen';
import Dashboard from './Dashboard';
import { Loader2 } from 'lucide-react';

function App() {
  const [session, setSession] = useState(null);
  const [hasLicense, setHasLicense] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(null); // New error state

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session }, error: sessionError }) => {
      if (sessionError) {
        setAuthError(sessionError.message);
        setLoading(false);
        return;
      }
      if (!session) {
        supabase.auth.signInAnonymously().then(({ data, error }) => {
          if (!error) {
            setSession(data.session);
            checkLicenses();
          } else {
            setAuthError("مشكلة في الاتصال بقاعدة البيانات: " + error.message);
            setLoading(false);
          }
        });
      } else {
        setSession(session);
        checkLicenses();
      }
    });

    supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session) checkLicenses();
    });
  }, []);

  const checkLicenses = async () => {
    const { data, error } = await supabase.from('owner_licenses').select('id').is('revoked_at', null).limit(1);
    if (data && data.length > 0) {
      setHasLicense(true);
    } else {
      setHasLicense(false);
    }
    setLoading(false);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setHasLicense(false);
    window.location.reload();
  };

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-app p-4 text-center">
        <Loader2 className="animate-spin text-primary mb-4" size={48} />
      </div>
    );
  }

  if (authError) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-app p-4 text-center" dir="rtl">
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative" role="alert">
          <strong className="font-bold block mb-2">تعذر الاتصال بالخادم</strong>
          <span className="block sm:inline">{authError}</span>
        </div>
      </div>
    );
  }

  if (hasLicense) {
    return <Dashboard onLogout={handleLogout} />;
  }

  return <PairingScreen onPaired={checkLicenses} />;
}

export default App;
