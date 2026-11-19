import React from 'react';
import DepartmentLanding from './DepartmentLanding';
import { DEPARTMENTS } from '../navConfig';
import { useAuth } from '../context/AuthContext';

export default function Commercial() {
  const { hasTabAccess } = useAuth();
  const dept = DEPARTMENTS.find(item => item.dept === 'commercial');
  const subTabs = dept.tabs.filter(tab => hasTabAccess(tab.path));
  return <DepartmentLanding department="commercial" label={dept.label} color={dept.color} subTabs={subTabs} />;
}
