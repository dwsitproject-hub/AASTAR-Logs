import React from 'react';
import DepartmentLanding from './DepartmentLanding';
import { DEPARTMENTS } from '../navConfig';
import { useAuth } from '../context/AuthContext';

export default function Operations() {
  const { hasTabAccess } = useAuth();
  const dept = DEPARTMENTS.find(d => d.dept === 'operations');
  const subTabs = dept.tabs.filter(t => hasTabAccess(t.path));
  return <DepartmentLanding department="operations" label={dept.label} color={dept.color} subTabs={subTabs} />;
}
