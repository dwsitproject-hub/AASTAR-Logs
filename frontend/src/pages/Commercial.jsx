import React from 'react';
import DepartmentLanding from './DepartmentLanding';
export default function Commercial() {
  return <DepartmentLanding department="commercial" label="Commercial" color="#3498db" subTabs={[
    { label: 'Open Shipments', path: '/commercial/open-shipments' },
    { label: 'KPN Export', path: '/commercial/kpn-export' },
  ]} />;
}
