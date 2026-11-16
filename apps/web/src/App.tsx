import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, Link } from 'react-router-dom';
import { Footer, Header } from './components/Shell';
import { useUi } from './store';
import Home from './pages/Home';

const HowItWorks = lazy(() => import('./pages/HowItWorks'));
const Docs = lazy(() => import('./pages/Docs'));
const Testnet = lazy(() => import('./pages/TestnetRoute'));
const VaultLayout = lazy(() => import('./app/Layout'));
const VaultPage = lazy(() => import('./app/VaultPage'));
const PaymentsPage = lazy(() => import('./app/PaymentsPage'));
const RecoveryPage = lazy(() => import('./app/RecoveryPage'));
const ControlPage = lazy(() => import('./app/ControlPage'));
const APP_PATHS = ['/vault', '/payments', '/recovery', '/control'];

const TITLES: Record<string, string> = {
  '/': 'Quanlet · Post-quantum asset protection on Robinhood Chain',
  '/how-it-works': 'How it works · Quanlet',
  '/docs': 'Docs · Quanlet',
  '/testnet': 'Testnet vault · Quanlet',
  '/vault': 'Vault · Quanlet',
  '/payments': 'Payments · Quanlet',
  '/recovery': 'Recovery · Quanlet',
  '/control': 'Control · Quanlet',
};

function NotFound() {
  return (
    <div className="wrap page">
      <h1>Page not found</h1>
      <p className="muted">That address does not exist on this site.</p>
      <Link className="btn" to="/">
        Back to home
      </Link>
    </div>
  );
}

export default function App() {
  const loc = useLocation();
  const loadConfig = useUi((s) => s.loadConfig);
  useEffect(() => {
    loadConfig();
  }, [loadConfig]);
  useEffect(() => {
    document.title = TITLES[loc.pathname] ?? 'Quanlet';
    if (!loc.hash) window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
  }, [loc.pathname, loc.hash]);
  return (
    <>
      <Header />
      <main id="main" tabIndex={-1} className={loc.pathname === '/' ? 'is-home' : APP_PATHS.includes(loc.pathname) ? 'is-page is-app' : 'is-page'}>
        {/* Stable loading region keeps the shell visible during route changes (FR-06). */}
        <Suspense fallback={<div className="loading-region" role="status">Loading…</div>}>
          {/* Keyed by path so each page plays a short fade-up as it arrives. */}
          <div className="route" key={APP_PATHS.includes(loc.pathname) ? 'vault-app' : loc.pathname} data-route={loc.pathname.replace(/^\//, '') || 'home'}>
            <Routes>
            <Route path="/" element={<Home />} />
            {/* the vault: four pages over one shared state, on Robinhood Chain testnet */}
            <Route element={<VaultLayout />}>
              <Route path="/vault" element={<VaultPage />} />
              <Route path="/payments" element={<PaymentsPage />} />
              <Route path="/recovery" element={<RecoveryPage />} />
              <Route path="/control" element={<ControlPage />} />
            </Route>
            <Route path="/withdrawals" element={<Navigate to="/payments" replace />} />
            <Route path="/how-it-works" element={<HowItWorks />} />
            <Route path="/docs" element={<Docs />} />
            <Route path="/testnet" element={<Testnet />} />
            <Route path="*" element={<NotFound />} />
            </Routes>
          </div>
        </Suspense>
      </main>
      <Footer />
    </>
  );
}
