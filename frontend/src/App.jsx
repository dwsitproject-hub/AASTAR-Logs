import React, { useState, Suspense, lazy } from 'react';
import { BrowserRouter, HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import DesktopConnectionSetup from './components/DesktopConnectionSetup';
import PageErrorBoundary from './components/PageErrorBoundary';
import Login from './pages/Login';
import DecoyPage from './pages/DecoyPage';

// Lazy-load page routes so each page's code (and its heavy deps like recharts /
// react-simple-maps) is fetched and parsed only when visited, instead of being
// eagerly held in one large bundle. This lowers baseline memory per session.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Commercial = lazy(() => import('./pages/Commercial'));
const OpenShipments = lazy(() => import('./pages/commercial/OpenShipments'));
const KpnExport = lazy(() => import('./pages/commercial/KpnExport'));
const Operations = lazy(() => import('./pages/Operations'));
const ContractDashboard = lazy(() => import('./pages/operations/ContractDashboard'));
const WeeklyOpsMeeting = lazy(() => import('./pages/operations/WeeklyOpsMeeting'));
const Logistics = lazy(() => import('./pages/Logistics'));
const ExportSummary = lazy(() => import('./pages/logistics/ExportSummary'));
const ExportSummaryTotal = lazy(() => import('./pages/logistics/ExportSummaryTotal'));
const StockSummary = lazy(() => import('./pages/logistics/StockSummary'));
const VesselStatus = lazy(() => import('./pages/logistics/VesselStatus'));
const VesselMap = lazy(() => import('./pages/logistics/VesselMap'));
const LiveVessels = lazy(() => import('./pages/logistics/LiveVessels'));
const VesselUpdateSplit = lazy(() => import('./pages/logistics/VesselUpdateSplit'));
const VesselContract = lazy(() => import('./pages/logistics/VesselContract'));
const Demurrage = lazy(() => import('./pages/logistics/Demurrage'));
const LogisticsExportPlanning = lazy(() => import('./pages/logistics/ExportPlanning'));
const VesselMatching = lazy(() => import('./pages/test/VesselMatching'));
const ContractUnlink = lazy(() => import('./pages/logistics/ContractUnlink'));
const Data = lazy(() => import('./pages/test/Data'));
const AppsScriptSheet = lazy(() => import('./pages/test/AppsScriptSheet'));
const Chartering = lazy(() => import('./pages/Chartering'));
const ExportPlanning = lazy(() => import('./pages/chartering/ExportPlanning'));
const Finance = lazy(() => import('./pages/Finance'));
const AdminPanel = lazy(() => import('./pages/AdminPanel'));
const Settings = lazy(() => import('./pages/Settings'));

const RouteFallback = () => (
  <div style={{ textAlign: 'center', padding: 70, fontSize: 14, color: '#666' }}>Loading…</div>
);

const AppLoading = () => (
  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>Loading...</div>
);

function AppLayout() {
  const { user, loading } = useAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const sidebarWidth = collapsed ? 72 : 250;

  if (loading) return <AppLoading />;
  if (!user) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;

  return (
    <div className="app-shell" style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar collapsed={collapsed} setCollapsed={setCollapsed} />
      <div className="app-content" style={{
        marginLeft: sidebarWidth,
        flex: 1,
        minWidth: 0, // let inner overflow-x containers scroll instead of widening the page
        transition: 'margin-left 0.2s',
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh'
      }}>
        <TopBar sidebarWidth={sidebarWidth} />
        <main className="app-main" style={{
          marginTop: 'var(--topbar-height)',
          padding: '24px 28px 32px',
          flex: 1,
          background: 'var(--bg-app)',
          minWidth: 0
        }}>
          <PageErrorBoundary resetKey={location.pathname}>
          <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
            <Route path="/commercial" element={<ProtectedRoute department="commercial"><Commercial /></ProtectedRoute>} />
            <Route path="/commercial/open-shipments" element={<ProtectedRoute tab="/commercial/open-shipments"><OpenShipments /></ProtectedRoute>} />
            <Route path="/commercial/kpn-export" element={<ProtectedRoute tab="/commercial/kpn-export"><KpnExport /></ProtectedRoute>} />
            <Route path="/operations" element={<ProtectedRoute department="operations"><Operations /></ProtectedRoute>} />
            <Route path="/operations/contract-dashboard" element={<ProtectedRoute tab="/operations/contract-dashboard"><ContractDashboard /></ProtectedRoute>} />
            <Route path="/operations/vessel-contract" element={<ProtectedRoute tab="/operations/vessel-contract"><VesselContract /></ProtectedRoute>} />
            <Route path="/operations/tpg-gr-weekly-ops" element={<ProtectedRoute tab="/operations/tpg-gr-weekly-ops"><WeeklyOpsMeeting /></ProtectedRoute>} />
            <Route path="/logistics" element={<ProtectedRoute department="logistics"><Logistics /></ProtectedRoute>} />
            <Route path="/logistics/stock-summary" element={<ProtectedRoute tab="/logistics/stock-summary"><StockSummary /></ProtectedRoute>} />
            <Route path="/logistics/vessel-status" element={<ProtectedRoute tab="/logistics/vessel-status"><VesselStatus /></ProtectedRoute>} />
            <Route path="/logistics/vessel-map" element={<ProtectedRoute tab="/logistics/vessel-map"><VesselMap /></ProtectedRoute>} />
            <Route path="/logistics/live-vessels" element={<ProtectedRoute tab="/logistics/live-vessels"><LiveVessels /></ProtectedRoute>} />
            <Route path="/logistics/export-summary" element={<ProtectedRoute tab="/logistics/export-summary"><ExportSummary /></ProtectedRoute>} />
            <Route path="/logistics/export-summary-total" element={<ProtectedRoute tab="/logistics/export-summary-total"><ExportSummaryTotal /></ProtectedRoute>} />
            <Route path="/logistics/vessel-update" element={<ProtectedRoute tab="/logistics/vessel-update"><VesselUpdateSplit /></ProtectedRoute>} />
            <Route path="/logistics/vessel-contract" element={<ProtectedRoute tab="/logistics/vessel-contract"><VesselContract /></ProtectedRoute>} />
            <Route path="/logistics/vessel-matching" element={<ProtectedRoute tab="/logistics/vessel-matching"><VesselMatching /></ProtectedRoute>} />
            <Route path="/logistics/contract-unlink" element={<ProtectedRoute tab="/logistics/contract-unlink"><ContractUnlink /></ProtectedRoute>} />
            <Route path="/logistics/demurrage" element={<ProtectedRoute tab="/logistics/demurrage"><Demurrage /></ProtectedRoute>} />
            <Route path="/logistics/export-planning" element={<ProtectedRoute tab="/logistics/export-planning"><LogisticsExportPlanning /></ProtectedRoute>} />
            <Route path="/chartering" element={<ProtectedRoute department="chartering"><Chartering /></ProtectedRoute>} />
            <Route path="/chartering/export-planning" element={<ProtectedRoute tab="/chartering/export-planning"><ExportPlanning /></ProtectedRoute>} />
            <Route path="/finance" element={<ProtectedRoute department="finance"><Finance /></ProtectedRoute>} />
            <Route path="/admin" element={<ProtectedRoute department="admin"><AdminPanel /></ProtectedRoute>} />
            <Route path="/test" element={<Navigate to="/test/data" replace />} />
            <Route path="/test/vessel-matching" element={<Navigate to="/logistics/vessel-matching" replace />} />
            <Route path="/test/data" element={<ProtectedRoute tab="/test/data"><Data /></ProtectedRoute>} />
            <Route path="/test/apps-script-sheet" element={<ProtectedRoute department="admin"><AppsScriptSheet /></ProtectedRoute>} />
            <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
          </Suspense>
          </PageErrorBoundary>
        </main>
      </div>
    </div>
  );
}

function RootRoutes() {
  const { loading } = useAuth();
  const route = window.erpDesktop ? window.location.hash.slice(1) : window.location.pathname;
  const isDecoyRoute = route === '/atlas/royal-continent';

  // Keep the login form hidden until the server confirms this IP may see it.
  if (loading && !isDecoyRoute) return <AppLoading />;

  return (
    <Routes>
      <Route path="/atlas/royal-continent" element={<DecoyPage />} />
      <Route path="/login" element={<Login />} />
      <Route path="/*" element={<AppLayout />} />
    </Routes>
  );
}

export default function App() {
  if (window.erpDesktop?.needsSetup) {
    return <DesktopConnectionSetup />;
  }

  const Router = window.erpDesktop ? HashRouter : BrowserRouter;

  return (
    <Router>
      <ThemeProvider>
        <AuthProvider>
          <RootRoutes />
        </AuthProvider>
      </ThemeProvider>
    </Router>
  );
}
