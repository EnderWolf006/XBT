import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import Login from './pages/Login';
import ProtectedRoute, { AdminRoute } from './components/ProtectedRoute';
import { lazy, Suspense, useEffect } from 'react';
import { useAuthStore } from './store/auth';

const Lobby = lazy(() => import('./pages/Lobby'));
const Courses = lazy(() => import('./pages/Courses'));
const SignDetail = lazy(() => import('./pages/SignDetail'));
const Whitelist = lazy(() => import('./pages/Whitelist'));
const SignLocations = lazy(() => import('./pages/SignLocations'));
const AccountManagement = lazy(() => import('./pages/AccountManagement'));
const FullScanner = lazy(() => import('./pages/FullScanner'));
const FullPhoto = lazy(() => import('./pages/FullPhoto'));

function App() {
  const activeUid = useAuthStore(state => state.activeUid);
  useEffect(() => {
    const preventPagePinch = (event: TouchEvent) => {
      if (event.touches.length >= 2) {
        event.preventDefault();
      }
    };
    const preventGesture = (event: Event) => event.preventDefault();

    document.addEventListener('touchmove', preventPagePinch, { passive: false });
    document.addEventListener('gesturestart', preventGesture as EventListener, { passive: false } as AddEventListenerOptions);
    document.addEventListener('gesturechange', preventGesture as EventListener, { passive: false } as AddEventListenerOptions);

    return () => {
      document.removeEventListener('touchmove', preventPagePinch as EventListener);
      document.removeEventListener('gesturestart', preventGesture as EventListener);
      document.removeEventListener('gesturechange', preventGesture as EventListener);
    };
  }, []);

  return (
    <HashRouter>
      <Toaster 
        position="top-center" 
        reverseOrder={false}
        containerStyle={{
          top: 'calc(24px + var(--sat))',
        }}
        toastOptions={{
          style: {
            borderRadius: '16px',
            background: '#fff',
            color: '#333',
            fontSize: '14px',
            fontWeight: '600',
            boxShadow: '0 10px 30px rgba(0,0,0,0.1)',
            padding: '12px 20px',
            maxWidth: '90%',
          },
        }}
      />
      <div className="h-screen h-[100dvh] bg-slate-50 text-slate-900 font-sans selection:bg-blue-100 overflow-hidden min-h-0">
        <div className="app-shell mx-auto h-full bg-white shadow-xl relative flex flex-col overflow-hidden min-h-0">
          <Suspense fallback={<p role="status" className="p-6 text-center text-sm text-slate-500">正在加载页面…</p>}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<ProtectedRoute />}>
              <Route path="/" element={<Lobby key={activeUid ?? 'signed-out'} />} />
              <Route path="/courses" element={<Courses />} />
              <Route path="/sign/:id" element={<SignDetail />} />
              <Route path="/admin/whitelist" element={<Whitelist />} />
              <Route element={<AdminRoute />}>
                <Route path="/admin/sign-locations" element={<SignLocations />} />
              </Route>
              <Route path="/accounts" element={<AccountManagement />} />
              <Route path="/scanner" element={<FullScanner />} />
              <Route path="/photo-capture" element={<FullPhoto />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </Suspense>
        </div>
      </div>
    </HashRouter>
  );
}

export default App;
