import React from 'react';
import DepartmentLanding from './DepartmentLanding';
import { DEPARTMENTS } from '../navConfig';
import { useAuth } from '../context/AuthContext';

export default function Logistics() {
  const { hasTabAccess } = useAuth();
  const dept = DEPARTMENTS.find(d => d.dept === 'logistics');
  const subTabs = dept.tabs.filter(t => hasTabAccess(t.path));
  return <DepartmentLanding department="logistics" label={dept.label} color={dept.color} subTabs={subTabs} />;
}
