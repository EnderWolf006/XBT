import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import Login from './pages/Login';
import Lobby from './pages/Lobby';
import Courses from './pages/Courses';
import SignDetail from './pages/SignDetail';
import Whitelist from './pages/Whitelist';
import AccountManagement from './pages/AccountManagement';
import FullScanner from './pages/FullScanner';
import ProtectedRoute from './components/ProtectedRoute';
import { useEffect } from 'react';

function App() {
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
        <div className="max-w-[480px] mx-auto h-full bg-white shadow-xl relative flex flex-col overflow-hidden min-h-0">
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<ProtectedRoute />}>
              <Route path="/" element={<Lobby />} />
              <Route path="/courses" element={<Courses />} />
              <Route path="/sign/:id" element={<SignDetail />} />
              <Route path="/admin/whitelist" element={<Whitelist />} />
              <Route path="/accounts" element={<AccountManagement />} />
              <Route path="/scanner" element={<FullScanner />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>
    </HashRouter>
  );
}

export default App;
