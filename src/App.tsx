import { useCallback, useEffect, useState } from 'react';
import { checkHealth } from './lib/api';
import { PageLoader, ServerDown } from './components/ui';
import { Join } from './pages/Join';
import { Team } from './pages/Team';
import { Admin } from './pages/Admin';
import { ScreenBoard } from './pages/Screen';
import { Fairness } from './pages/Fairness';

type Health = { state: 'checking' | 'ok' | 'down'; ms: number; version: string; error: string };

export function App() {
  const [path, setPath] = useState(() => location.pathname);
  const [health, setHealth] = useState<Health>({ state: 'checking', ms: 0, version: '', error: '' });
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const probe = useCallback(async () => {
    setHealth((h) => ({ ...h, state: 'checking', error: '' }));
    try {
      const result = await checkHealth();
      setHealth({ state: 'ok', ms: result.ms, version: result.version, error: '' });
    } catch (error) {
      setHealth({ state: 'down', ms: 0, version: '', error: error instanceof Error ? error.message : 'tidak diketahui' });
    }
  }, []);

  useEffect(() => {
    void probe();
    const onUpdate = () => setUpdateReady(true);
    window.addEventListener('cc:update-available', onUpdate);
    return () => window.removeEventListener('cc:update-available', onUpdate);
  }, [probe]);

  if (health.state === 'down') {
    return <ServerDown onRetry={() => void probe()} checking={false} />;
  }

  if (health.state === 'checking') {
    return <PageLoader title="Menyiapkan lomba" hint="Menghubungi server…" />;
  }

  return (
    <>
      {path.startsWith('/t/') ? (
        <Team />
      ) : path === '/admin' ? (
        <Admin />
      ) : path === '/screen' ? (
        <ScreenBoard />
      ) : path === '/keadilan' ? (
        <Fairness />
      ) : (
        <Join />
      )}
      {updateReady ? (
        <button
          type="button"
          className="btn btn-primary fixed right-3 bottom-3 z-50"
          onClick={() => window.dispatchEvent(new Event('cc:apply-update'))}
        >
          Versi baru — muat ulang
        </button>
      ) : null}
    </>
  );
}
