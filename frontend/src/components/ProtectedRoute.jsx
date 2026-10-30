import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function ProtectedRoute({ children, department, tab }) {
  const { user, loading, hasPermission, hasTabAccess } = useAuth();

  if (loading) return <div style={{ display:'flex', justifyContent:'center', alignItems:'center', height:'100vh' }}>Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  // `tab` gates an individual sub-tab; `department` gates a landing/single page.
  if (tab && !hasTabAccess(tab)) return <Navigate to="/dashboard" replace />;
  if (department && !hasPermission(department)) return <Navigate to="/dashboard" replace />;

  return children;
}
