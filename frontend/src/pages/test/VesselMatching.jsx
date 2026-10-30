import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../services/api';
import { trackHubAction } from '../../services/hubSdk';
import useDataRefresh from '../../services/useDataRefresh';

// The four sources stay separate for writing, but the UI presents them as two
// navigable groups and keeps the matched view consolidated across all sources.
const SALES_TABS = ['AASTAR SALES', 'KIMARA SALES', 'GR SALES'];
const PURCHASE_TABS = ['AASTAR PURCHASE', 'KIMARA PURCHASE', 'GR PURCHASE'];
const ALL_TABS = [...SALES_TABS, ...PURCHASE_TABS];

const isPartial = (r) => !!(r.partial && String(r.partial).toUpperCase().includes('PARTIAL'));
const isUnassignedContract = (row) => String(row?.vsl_id ?? '').trim() === '';
const isUsablePrice = (value) => {
  const normalized = String(value ?? '').trim().replace(/,/g, '');
  if (!normalized) return false;
  const numeric = Number(normalized);
  return !Number.isFinite(numeric) || numeric !== 0;
};
const shortTab = (tab) => tab.replace('AASTAR ', 'A* ').replace('KIMARA ', 'KM ');
const rowKey = (tab, row) => `${tab}:${row._row}`;
const contractMatchesSearch = (row, query) => !query || [
  row.ref, row.contract_no, row.buyer, row.cargo, row.broker, row.intention_vessel,
].some(value => String(value || '').toLowerCase().includes(query));
const contractSortDesc = (a, b) => {
  const aKey = String(a.contract_no || a.ref || '');
  const bKey = String(b.contract_no || b.ref || '');
  return bKey.localeCompare(aKey, undefined, { numeric: true, sensitivity: 'base' }) || (b._row || 0) - (a._row || 0);
};

export default function VesselMatching() {
  const [vessels, setVessels] = useState([]);
  const [selVessel, setSelVessel] = useState('');
  const [vesselQuery, setVesselQuery] = useState('');
  const [vesselMenuOpen, setVesselMenuOpen] = useState(false);
  const [vesselHighlight, setVesselHighlight] = useState(-1);
  const [selVslid, setSelVslid] = useState('');
  const [activeSalesTab, setActiveSalesTab] = useState(SALES_TABS[0]);
  const [activePurchaseTab, setActivePurchaseTab] = useState(PURCHASE_TABS[0]);
  const [tabData, setTabData] = useState({});
  const [salesSearch, setSalesSearch] = useState('');
  const [purchaseSearch, setPurchaseSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [partialQtyOverrides, setPartialQtyOverrides] = useState({});
  const [hover, setHover] = useState(null);

  const showToast = (msg, kind = '') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 2600);
  };

  const handleHoverEnter = ({ row, sourceTab, event }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setHover({
      row,
      sourceTab,
      anchor: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
    });
  };

  const handleHoverLeave = () => setHover(null);

  const loadVessels = (silent = false) => api.get('/vessel-slots')
    .then(r => setVessels(r.data.vessels || []))
    .catch(() => { if (!silent) showToast('Failed to load vessels', 'err'); });

  useEffect(() => { loadVessels(); }, []);

  const mergedVessels = useMemo(() => {
    const map = new Map();
    for (const v of vessels) {
      const entry = map.get(v.vessel) || { vessel: v.vessel, entity: v.entity, slots: [] };
      for (const slot of v.slots || []) {
        if (!entry.slots.some(existing => existing.vslid === slot.vslid)) entry.slots.push(slot);
      }
      map.set(v.vessel, entry);
    }
    return [...map.values()];
  }, [vessels]);

  const vesselObj = mergedVessels.find(v => v.vessel === selVessel);
  const vesselOptions = useMemo(() => {
    const query = vesselQuery.trim().toLowerCase();
    if (!query) return mergedVessels;
    return mergedVessels.filter(vessel => `${vessel.vessel} ${vessel.entity || ''}`.toLowerCase().includes(query));
  }, [mergedVessels, vesselQuery]);
  const slots = vesselObj?.slots || [];
  const selectedSlot = slots.find(slot => slot.vslid === selVslid);

  useEffect(() => {
    if (selVslid && !slots.some(slot => slot.vslid === selVslid)) setSelVslid('');
  }, [selVslid, slots]);

  const chooseVessel = (vessel) => {
    setVesselQuery(vessel.vessel);
    setSelVessel(vessel.vessel);
    setSelVslid('');
    setVesselHighlight(-1);
    setVesselMenuOpen(false);
  };

  const handleVesselKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setVesselMenuOpen(true);
      setVesselHighlight(current => Math.min(current < 0 ? 0 : current + 1, vesselOptions.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setVesselMenuOpen(true);
      setVesselHighlight(current => Math.max(current < 0 ? vesselOptions.length - 1 : current - 1, 0));
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      const option = vesselOptions[vesselHighlight >= 0 ? vesselHighlight : 0];
      if (option) {
        if (event.key === 'Enter') event.preventDefault();
        chooseVessel(option);
      }
    } else if (event.key === 'Escape') {
      setVesselMenuOpen(false);
      setVesselHighlight(-1);
    }
  };

  const loadAllTabs = (silent = false) => {
    if (!silent) setLoading(true);
    api.get('/sheets/vessel-matching')
      .then(response => {
        setTabData(response.data.tabs || {});
        if (!silent) {
          setOverrides({});
          setPartialQtyOverrides({});
        }
      })
      .catch(e => showToast(e.response?.data?.error || 'Failed to load contracts', 'err'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadAllTabs();
  }, []);
  useDataRefresh({
    databases: ['DB1', 'DB2', 'DB3', 'DB4', 'DB5', 'DB6', 'DB10'],
    resources: ['vessel-matching', 'matching-sales', 'vessel-update'],
    onRefresh: () => { loadAllTabs(true); loadVessels(true); },
  });

  const allRows = useMemo(() => ALL_TABS.flatMap(sourceTab => (
    (tabData[sourceTab]?.rows || []).map(row => ({
      ...row,
      _sourceTab: sourceTab,
      vsl_id: overrides[rowKey(sourceTab, row)] !== undefined
        ? overrides[rowKey(sourceTab, row)]
        : row.vsl_id,
      partial_qty: partialQtyOverrides[rowKey(sourceTab, row)] !== undefined
        ? partialQtyOverrides[rowKey(sourceTab, row)]
        : row.partial_qty,
    }))
  )), [tabData, overrides, partialQtyOverrides]);

  const availableRowsByTab = useMemo(() => Object.fromEntries(ALL_TABS.map(sourceTab => [sourceTab,
    allRows
      .filter(row => row._sourceTab === sourceTab && isUnassignedContract(row))
      .sort(contractSortDesc),
  ])), [allRows]);

  const availableRows = (sourceTab) => availableRowsByTab[sourceTab] || [];

  // This intentionally ignores the currently active source tab. A matched
  // contract remains visible when the user navigates between A* and KM.
  const matchedRows = useMemo(() => allRows
    .filter(row => selVslid && row.vsl_id === selVslid)
    .sort(contractSortDesc), [allRows, selVslid]);

  const assign = async (sourceTab, row, vslid) => {
    const vslCol = tabData[sourceTab]?.tabConfig?.columns?.vsl_id;
    if (vslCol == null) return;
    setBusy(true);
    setOverrides(current => ({ ...current, [rowKey(sourceTab, row)]: vslid }));
    try {
      await api.post('/sheets/vessel-matching/save', {
        tab: sourceTab,
        row: row._row,
        value: vslid,
        expectedRef: row.ref,
        expectedMatchId: row.match_id,
      });
      showToast(vslid ? `Matched ${row.contract_no || row.ref}` : `Unmatched ${row.contract_no || row.ref}`);
      trackHubAction(vslid ? 'contract_vessel_matched' : 'contract_vessel_unmatched', { tab: sourceTab });
    } catch (e) {
      setOverrides(current => {
        const next = { ...current };
        delete next[rowKey(sourceTab, row)];
        return next;
      });
      showToast(e.response?.data?.error || 'Save failed', 'err');
    } finally {
      setBusy(false);
      setTimeout(() => loadAllTabs(true), 1800);
    }
  };

  const changePartialQty = (sourceTab, row, value) => {
    setPartialQtyOverrides(current => ({ ...current, [rowKey(sourceTab, row)]: value }));
  };

  const savePartialQty = async (sourceTab, row, value) => {
    setBusy(true);
    try {
      const response = await api.post('/sheets/vessel-matching/save-partial-qty', {
        tab: sourceTab,
        row: row._row,
        value,
        expectedRef: row.ref,
        expectedMatchId: row.match_id,
      });
      setPartialQtyOverrides(current => ({ ...current, [rowKey(sourceTab, row)]: response.data.partial_qty }));
      showToast(`Partial quantity saved: ${response.data.partial_qty}`);
      setTimeout(() => loadAllTabs(true), 500);
    } catch (e) {
      setPartialQtyOverrides(current => {
        const next = { ...current };
        delete next[rowKey(sourceTab, row)];
        return next;
      });
      showToast(e.response?.data?.error || 'Partial quantity save failed', 'err');
    } finally {
      setBusy(false);
    }
  };

  const addPartial = async (sourceTab, row) => {
    setBusy(true);
    try {
      await api.post('/sheets/vessel-matching/add-partial', {
        tab: sourceTab,
        row: row._row,
        expectedRef: row.ref,
        expectedMatchId: row.match_id,
      });
      showToast('Partial shipment added - duplicate now available to match');
      setTimeout(() => loadAllTabs(true), 300);
    } catch (e) {
      showToast(e.response?.data?.error || 'Add partial failed', 'err');
    } finally {
      setBusy(false);
    }
  };

  const removePartial = async (sourceTab, row) => {
    if (!window.confirm('Remove this partial shipment row? This unmerges and deletes the row.')) return;
    setBusy(true);
    try {
      await api.post('/sheets/vessel-matching/remove-partial', {
        tab: sourceTab,
        row: row._row,
        expectedRef: row.ref,
        expectedMatchId: row.match_id,
      });
      showToast('Partial shipment removed');
      setTimeout(() => loadAllTabs(true), 800);
    } catch (e) {
      showToast(e.response?.data?.error || 'Remove partial failed', 'err');
    } finally {
      setBusy(false);
    }
  };

  const renderLinkedPartition = (title, sourceTabs, tone) => {
    const rows = matchedRows.filter(row => sourceTabs.includes(row._sourceTab));
    return (
      <div style={{ ...linkedPartition, borderTop: `3px solid ${tone}` }}>
        <div style={partitionHeader}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: tone }} />
            <h4 style={partitionTitle}>{title}</h4>
          </div>
          <span style={countPill}>{rows.length}</span>
        </div>
        {rows.length === 0 ? <Empty>No {title.toLowerCase()} contracts linked.</Empty> : (
          <div style={linkedPartitionList}>
            {rows.map(row => (
              <ContractCard key={rowKey(row._sourceTab, row)} r={row} sourceTab={row._sourceTab} matched onHover={handleHoverEnter} onHoverLeave={handleHoverLeave}
                partialQtyDisabled={busy} onPartialQtyChange={value => changePartialQty(row._sourceTab, row, value)} onPartialQtySave={value => savePartialQty(row._sourceTab, row, value)}
                action={<div style={{ display: 'flex', gap: 4 }}>
                  <ActionBtn title="Unmatch" disabled={busy} onClick={() => assign(row._sourceTab, row, '')}>[- Minus]</ActionBtn>
                  <ActionBtn title="Add partial shipment" green disabled={busy} onClick={() => addPartial(row._sourceTab, row)}>[+ Partial]</ActionBtn>
                  {row._partialChild && <ActionBtn title="Remove partial shipment" red disabled={busy} onClick={() => removePartial(row._sourceTab, row)}>[Partial -]</ActionBtn>}
                </div>} />
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderAvailableSection = (title, sourceTabs, activeTab, setActiveTab, tone) => {
    const searchValue = title === 'Sales' ? salesSearch : purchaseSearch;
    const setSearchValue = title === 'Sales' ? setSalesSearch : setPurchaseSearch;
    const rows = availableRows(activeTab).filter(row => contractMatchesSearch(row, searchValue.trim().toLowerCase()));
    return (
      <section style={{ ...section, borderTop: `3px solid ${tone}` }}>
        <div style={sectionHeader}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: tone }} />
              <h3 style={sectionTitle}>{title}</h3>
            </div>
            <div style={sectionHint}>Contracts available to match</div>
          </div>
          <span style={countPill}>{rows.length} available</span>
        </div>
        <div style={tabBar}>
          {sourceTabs.map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={sourceTabButton(tab === activeTab, tone)}>
              {shortTab(tab)}
            </button>
          ))}
        </div>
        <input value={searchValue} onChange={event => setSearchValue(event.target.value)} placeholder={`Search ${title.toLowerCase()} contracts...`} style={{ ...inp, marginBottom: 10 }} />
        {loading && !tabData[activeTab] ? <Empty>Loading contracts...</Empty> : rows.length === 0 ? <Empty>No available contracts.</Empty> : (
          <div style={availableList}>
            {rows.slice(0, 300).map(row => (
              <ContractCard key={rowKey(activeTab, row)} r={row} sourceTab={activeTab} onHover={handleHoverEnter} onHoverLeave={handleHoverLeave}
                partialQtyDisabled={busy} onPartialQtyChange={value => changePartialQty(activeTab, row, value)} onPartialQtySave={value => savePartialQty(activeTab, row, value)}
                action={<div style={{ display: 'flex', gap: 4 }}>
                  <ActionBtn title="Add partial shipment" green disabled={busy} onClick={() => addPartial(activeTab, row)}>[+ Partial]</ActionBtn>
                  {row._partialChild && <ActionBtn title="Remove partial shipment" red disabled={busy} onClick={() => removePartial(activeTab, row)}>[Partial -]</ActionBtn>}
                  <IconBtn title={selVslid ? 'Match to selected vessel' : 'Select a vessel and loadport first'} disabled={!selVslid || busy} onClick={() => assign(activeTab, row, selVslid)}>+</IconBtn>
                </div>} />
            ))}
          </div>
        )}
      </section>
    );
  };

  return (
    <div>
      <div style={pageHeader}>
        <div>
          <h2 style={pageTitle}>Vessel Matching</h2>
          <p style={pageSubtitle}>Assign contracts to a vessel and loadport. Changes write to the live sheet.</p>
        </div>
      </div>

      <section style={{ ...section, marginTop: 16 }}>
        <div style={sectionHeader}>
          <div>
            <h3 style={sectionTitle}>Matched contracts</h3>
            <div style={sectionHint}>Choose the vessel and loadport before assigning an available contract</div>
          </div>
          <span style={countPill}>{matchedRows.length} linked</span>
        </div>
        <div style={selectionGrid}>
          <Field label="Vessel">
            <div style={vesselCombo}>
              <input
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={vesselMenuOpen}
                aria-controls="vessel-options"
                aria-activedescendant={vesselHighlight >= 0 ? `vessel-option-${vesselHighlight}` : undefined}
                value={vesselQuery}
                onChange={event => { setVesselQuery(event.target.value); setSelVessel(event.target.value); setSelVslid(''); setVesselHighlight(-1); setVesselMenuOpen(true); }}
                onFocus={() => setVesselMenuOpen(true)}
                onBlur={() => setTimeout(() => setVesselMenuOpen(false), 120)}
                onKeyDown={handleVesselKeyDown}
                placeholder="Type or select vessel..."
                style={inp}
                autoComplete="off"
              />
              {vesselMenuOpen && vesselOptions.length > 0 && (
                <div id="vessel-options" role="listbox" style={vesselMenu}>
                  {vesselOptions.map((vessel, index) => (
                    <div
                      key={vessel.vessel}
                      id={`vessel-option-${index}`}
                      role="option"
                      aria-selected={index === vesselHighlight}
                      onMouseDown={event => { event.preventDefault(); chooseVessel(vessel); }}
                      onMouseEnter={() => setVesselHighlight(index)}
                      style={{ ...vesselOption, background: index === vesselHighlight ? 'var(--bg-app)' : 'transparent' }}
                    >
                      <span>{vessel.vessel}</span>
                      {vessel.entity && <span style={vesselEntity}>{vessel.entity}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Field>
          <Field label="Loadport">
            <select value={selVslid} onChange={event => setSelVslid(event.target.value)} style={inp} disabled={!vesselObj}>
              <option value="">{vesselObj ? 'Select loadport...' : 'Pick a valid vessel first'}</option>
              {slots.map(slot => <option key={slot.vslid} value={slot.vslid}>{slot.loadport}{slot.eta ? ` - ETA ${slot.eta}` : ''}</option>)}
            </select>
          </Field>
        </div>
        <div style={contextSummary}>
          <div style={contextSummaryTitle}>Selected vessel and loadport</div>
          <div style={contextSummaryGrid}>
            <ContextField label="Vessel" value={vesselObj?.vessel || 'No vessel selected'} emphasis />
            <ContextField label="Entity" value={vesselObj?.entity || '-'} />
            <ContextField label="VSL ID" value={selectedSlot?.vslid || '-'} />
            <ContextField label="Demm Rate" value={vesselObj?.demmRate || '-'} />
            <ContextField label="Load Rate" value={vesselObj?.laytimeRate || '-'} />
            <ContextField label="Laytime Starts" value={vesselObj?.laytimeStarts || '-'} />
            <ContextField label="Nominated" value={vesselObj ? (vesselObj.nominated ? 'TRUE' : 'FALSE') : '-'} />
            <ContextField label="Remarks" value={vesselObj?.remarks || '-'} />
            <ContextField label="Loadport" value={selectedSlot?.loadport || 'No loadport selected'} emphasis />
            <ContextField label="Qty" value={selectedSlot?.qty || '-'} />
            <ContextField label="L.Cargo" value={selectedSlot?.lCargo || '-'} />
            <ContextField label="Shipper" value={selectedSlot?.shipper || '-'} />
            <ContextField label="Laycan" value={selectedSlot?.laycan || '-'} />
            <ContextField label="CR" value={selectedSlot?.cr || '-'} />
            <ContextSchedule selectedSlot={selectedSlot} />
          </div>
        </div>
      </section>

      <section style={{ ...section, marginTop: 16 }}>
        <div style={sectionHeader}>
          <div>
            <h3 style={sectionTitle}>Linked to selected vessel</h3>
            <div style={sectionHint}>{selVessel ? `${selVessel}${selectedSlot ? ` - ${selectedSlot.loadport}` : ''}` : 'Select a vessel and loadport above'}</div>
          </div>
          <span style={countPill}>{matchedRows.length} contracts</span>
        </div>
        {!selVslid ? <Empty>Pick a vessel and loadport to see all matched contracts.</Empty> : (
          <div style={linkedGrid}>
            {renderLinkedPartition('Sales', SALES_TABS, '#2563eb')}
            {renderLinkedPartition('Purchase', PURCHASE_TABS, '#2d6a4f')}
          </div>
        )}
      </section>

      <div style={{ ...sourceGrid, marginTop: 16 }}>
        {renderAvailableSection('Sales', SALES_TABS, activeSalesTab, setActiveSalesTab, '#2563eb')}
        {renderAvailableSection('Purchase', PURCHASE_TABS, activePurchaseTab, setActivePurchaseTab, '#2d6a4f')}
      </div>

      {hover && <HoverDetail r={hover.row} anchor={hover.anchor} sourceTab={hover.sourceTab} tabConfig={tabData[hover.sourceTab]?.tabConfig} />}
      {toast && <div style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', background: toast.kind === 'err' ? '#dc2626' : '#111827', color: '#fff', padding: '9px 16px', borderRadius: 8, fontSize: 13, zIndex: 100, boxShadow: '0 4px 14px rgba(0,0,0,0.25)' }}>{toast.msg}</div>}
    </div>
  );
}

function ContextField({ label, value, emphasis }) {
  return (
    <div style={contextField}>
      <div style={contextFieldLabel}>{label}</div>
      <div title={String(value)} style={{ ...contextFieldValue, ...(emphasis ? contextFieldEmphasis : {}) }}>{value}</div>
    </div>
  );
}

function ContextSchedule({ selectedSlot }) {
  return (
    <div style={{ ...contextField, gridColumn: 'span 2' }}>
      <div style={contextFieldLabel}>Schedule</div>
      <div style={scheduleSummary}>
        <span>ETA {selectedSlot?.eta || '-'}</span>
        <span>ETB {selectedSlot?.etb || '-'}</span>
        <span>ETC {selectedSlot?.etc || '-'}</span>
      </div>
    </div>
  );
}

function ContractCard({ r, action, matched, onHover, onHoverLeave, sourceTab, onPartialQtyChange, onPartialQtySave, partialQtyDisabled }) {
  const bit = (label, value) => value ? <span style={chip}><span style={{ opacity: 0.55 }}>{label}</span> {value}</span> : null;
  const partial = isPartial(r);
  const displayedQuantity = partial && r.partial_qty !== '' && r.partial_qty != null ? r.partial_qty : r.qty;
  const hasFinalPrice = isUsablePrice(r.final_price);
  const hasProvisionalPrice = isUsablePrice(r.prov_price);
  const displayedPrice = hasFinalPrice
    ? `${r.final_price} Final`
    : hasProvisionalPrice ? `${r.prov_price} Prov` : '-';
  return (
    <div onMouseEnter={event => onHover({ row: r, sourceTab, event })} onMouseLeave={onHoverLeave} style={{ ...card, fontFamily: contractFontFamily, fontSize: contractFontSize, borderLeft: `3px solid ${matched ? '#2d6a4f' : '#2563eb'}` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={cardTopline}>
          <span style={sourceBadge(sourceTab)}>{shortTab(sourceTab)}</span>
          <span style={contractNo}>{r.contract_no || r.ref}</span>
          {partial && <span style={partialBadge}>PARTIAL</span>}
          {partial && onPartialQtyChange && onPartialQtySave ? (
            <label style={partialQtyEditor} title="Partial quantity allocation">
              <span>P.Qty</span>
              <input
                type="number"
                min="0"
                step="any"
                value={r.partial_qty ?? ''}
                disabled={partialQtyDisabled}
                onClick={event => event.stopPropagation()}
                onChange={event => onPartialQtyChange(event.target.value)}
                onBlur={event => onPartialQtySave(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                style={partialQtyInput}
              />
            </label>
          ) : displayedQuantity !== '' && displayedQuantity != null ? <span style={quantity}>{displayedQuantity}</span> : null}
          {r.cargo && <span style={cargoBadge}>{r.cargo}</span>}
        </div>
        <div style={cardDetails}>
          {bit('Buyer', r.buyer)}
          {bit('Broker', r.broker)}
          {bit('Price', displayedPrice)}
          {bit('Vsl', r.intention_vessel)}
          {(r.contract_start || r.contract_end) && bit('Period', `${r.contract_start || '?'} -> ${r.contract_end || '?'}`)}
        </div>
      </div>
      {action}
    </div>
  );
}

function HoverDetail({ r, anchor, tabConfig, sourceTab }) {
  const cols = tabConfig?.columns ? Object.keys(tabConfig.columns) : Object.keys(r);
  const fields = cols.filter(c => c !== 'partial' && (r[c] ?? '') !== '');
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
  const popupWidth = 520;
  const popupHeight = 420;
  const gap = 12;
  let left = anchor.right + gap;
  let top = anchor.top;
  if (left + popupWidth > viewportWidth - 8) left = anchor.left - popupWidth - gap;
  if (top + popupHeight > viewportHeight - 8) top = viewportHeight - popupHeight - 8;
  left = Math.max(8, left);
  top = Math.max(8, top);
  return (
    <div style={{ position: 'fixed', left, top, zIndex: 90, width: popupWidth, maxWidth: 'calc(100vw - 24px)', maxHeight: popupHeight, overflow: 'auto', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 6px 18px rgba(15,23,42,0.22)', padding: 12, fontSize: 11.5, pointerEvents: 'none' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, paddingBottom: 8, marginBottom: 8, borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontWeight: 700, color: 'var(--text-main)' }}>{r.contract_no || r.ref} - details</div>
        <span style={sourceBadge(sourceTab || 'AASTAR SALES')}>{shortTab(sourceTab || 'AASTAR SALES')}</span>
      </div>
      <div style={hoverInfoGrid}>
        {fields.map(field => (
          <div key={field} style={hoverInfoItem}>
            <div style={hoverInfoLabel}>{field.replace(/_/g, ' ')}</div>
            <div style={hoverInfoValue}>{String(r[field])}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const Field = ({ label, children }) => <div><div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 600 }}>{label}</div>{children}</div>;
const Empty = ({ children }) => <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, fontStyle: 'italic' }}>{children}</div>;
function IconBtn({ children, onClick, disabled, title, green, red }) {
  const background = red ? '#dc2626' : green ? '#16a34a' : '#2563eb';
  return <button title={title} onClick={onClick} disabled={disabled} style={{ width: 30, height: 30, borderRadius: 6, border: 'none', background: disabled ? '#94a3b8' : background, color: '#fff', fontSize: 16, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer', lineHeight: 1, flexShrink: 0 }}>{children}</button>;
}

function ActionBtn({ children, onClick, disabled, title, green, red }) {
  const background = red ? '#dc2626' : green ? '#16a34a' : '#2563eb';
  return <button title={title} onClick={onClick} disabled={disabled} style={{ minWidth: 0, height: 30, padding: '0 8px', borderRadius: 6, border: 'none', background: disabled ? '#94a3b8' : background, color: '#fff', fontSize: 11, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer', lineHeight: 1, whiteSpace: 'nowrap' }}>{children}</button>;
}

const pageHeader = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, marginBottom: 16, flexWrap: 'wrap' };
const pageTitle = { fontSize: 20, fontWeight: 600, color: 'var(--text-main)', margin: '0 0 2px' };
const pageSubtitle = { fontSize: 12, color: 'var(--text-muted)', margin: 0 };
const sourceGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, alignItems: 'start' };
const hoverInfoGrid = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '9px 14px' };
const hoverInfoItem = { minWidth: 0 };
const hoverInfoLabel = { color: 'var(--text-muted)', fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.35, marginBottom: 2 };
const hoverInfoValue = { color: 'var(--text-main)', lineHeight: 1.35, overflowWrap: 'anywhere' };
const section = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 14 };
const sectionHeader = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 };
const sectionTitle = { fontSize: 15, fontWeight: 700, color: 'var(--text-main)', margin: 0 };
const sectionHint = { fontSize: 11, color: 'var(--text-muted)', marginTop: 3 };
const countPill = { flexShrink: 0, padding: '4px 8px', borderRadius: 999, background: 'var(--bg-app)', color: 'var(--text-muted)', fontSize: 11, fontWeight: 600 };
const tabBar = { display: 'flex', gap: 6, marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid var(--border)' };
const sourceTabButton = (active, tone) => ({ padding: '6px 12px', borderRadius: 7, border: `1px solid ${active ? tone : 'var(--border)'}`, background: active ? tone : 'var(--bg-card)', color: active ? '#fff' : 'var(--text-main)', fontSize: 12, fontWeight: active ? 700 : 500, cursor: 'pointer' });
const selectionGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, alignItems: 'end' };
const vesselCombo = { position: 'relative' };
const vesselMenu = { position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 40, maxHeight: 260, overflowY: 'auto', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 6px 16px rgba(15,23,42,0.18)', padding: 4 };
const vesselOption = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, minHeight: 32, padding: '6px 8px', borderRadius: 5, color: 'var(--text-main)', fontSize: 12, cursor: 'pointer' };
const vesselEntity = { flexShrink: 0, color: 'var(--text-muted)', fontSize: 10 };
const contextSummary = { minWidth: 0, overflowX: 'auto', padding: '8px 10px', background: 'var(--bg-app)', border: '1px solid var(--border)', borderRadius: 8 };
const contextSummaryTitle = { color: 'var(--text-muted)', fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 };
const contextSummaryGrid = { display: 'grid', gridTemplateColumns: 'repeat(8, minmax(88px, 1fr))', gap: '7px 12px', minWidth: 760 };
const contextField = { minWidth: 0 };
const contextFieldLabel = { color: 'var(--text-muted)', fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 2 };
const contextFieldValue = { color: 'var(--text-main)', fontSize: 11.5, lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const contextFieldEmphasis = { fontWeight: 700, fontSize: 12 };
const scheduleSummary = { display: 'flex', gap: 10, color: 'var(--text-main)', fontSize: 11.5, lineHeight: 1.3, whiteSpace: 'nowrap' };
const inp = { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-main)', fontSize: 13, boxSizing: 'border-box' };
const availableList = { display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflowY: 'auto', overscrollBehavior: 'contain', scrollbarGutter: 'stable' };
const linkedGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14, alignItems: 'start' };
const linkedPartition = { minWidth: 0, background: 'var(--bg-app)', border: '1px solid var(--border)', borderRadius: 8, padding: 10 };
const partitionHeader = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 9 };
const partitionTitle = { margin: 0, color: 'var(--text-main)', fontSize: 13, fontWeight: 700 };
const linkedPartitionList = { display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '46vh', overflowY: 'auto', overscrollBehavior: 'contain', scrollbarGutter: 'stable' };
const card = { border: '1px solid var(--border)', borderRadius: 8, padding: '9px 11px', background: 'var(--bg-card)', display: 'flex', gap: 8, alignItems: 'flex-start' };
const cardTopline = { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 4 };
const contractFontFamily = "'Segoe UI', system-ui, -apple-system, sans-serif";
const contractFontSize = 12;
const cardDetails = { display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: contractFontSize, color: 'var(--text-muted)' };
const contractNo = { fontWeight: 700, fontSize: contractFontSize, color: 'var(--text-main)' };
const quantity = { fontWeight: 700, color: '#b45309', fontSize: contractFontSize };
const partialQtyEditor = { display: 'inline-flex', alignItems: 'center', gap: 4, color: '#92400e', fontSize: contractFontSize, fontWeight: 700 };
const partialQtyInput = { width: 78, height: 24, boxSizing: 'border-box', border: '1px solid #f59e0b', borderRadius: 5, padding: '2px 5px', background: 'var(--bg-card)', color: 'var(--text-main)', fontSize: contractFontSize, fontWeight: 700 };
const chip = { display: 'inline-flex', gap: 3, alignItems: 'center', padding: '1px 6px', borderRadius: 4, background: 'var(--bg-app)' };
const cargoBadge = { ...chip, background: '#eef3f0', color: '#2d6a4f', fontWeight: 700 };
const partialBadge = { fontSize: 9, fontWeight: 700, background: '#fce7f3', color: '#9d174d', padding: '1px 6px', borderRadius: 10 };
const sourceBadge = (tab) => ({ fontSize: 9, fontWeight: 700, color: tab.includes('PURCHASE') ? '#166534' : '#1d4ed8', background: tab.includes('PURCHASE') ? '#dcfce7' : '#dbeafe', padding: '2px 6px', borderRadius: 5 });
