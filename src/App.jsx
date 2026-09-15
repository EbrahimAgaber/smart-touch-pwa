import { useState, useEffect } from 'react';
import { supabase } from './supabase';
import PairingScreen from './PairingScreen';
import Dashboard from './Dashboard';
import { Loader2 } from 'lucide-react';

function App() {
  const [session, setSession] = useState(null);
  const [hasLicense, setHasLicense] = useState(null); // null = loading
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        supabase.auth.signInAnonymously().then(({ data, error }) => {
          if (!error) {
            setSession(data.session);
            checkLicenses();
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
      <div className="flex-1 flex items-center justify-center bg-app">
        <Loader2 className="animate-spin text-primary" size={48} />
      </div>
    );
  }

  if (hasLicense) {
    return <Dashboard onLogout={handleLogout} />;
  }

  return <PairingScreen onPaired={checkLicenses} />;
}

export default App;
