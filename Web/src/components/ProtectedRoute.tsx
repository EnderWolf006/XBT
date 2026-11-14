import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '../store/auth';

export const AdminRoute = () => {
  const { isAuthenticated, user } = useAuthStore();

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!user || user.permission < 2) return <Navigate to="/" replace />;

  return <Outlet />;
};

const ProtectedRoute = () => {
  const { isAuthenticated } = useAuthStore();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
};

export default ProtectedRoute;
