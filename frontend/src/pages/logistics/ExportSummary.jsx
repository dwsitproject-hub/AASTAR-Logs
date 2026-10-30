import React, { useEffect, useLayoutEffect, useState, useRef } from 'react';
import { toBlob } from 'html-to-image';
import api from '../../services/api';
import useDataRefresh from '../../services/useDataRefresh';
import { useTheme } from '../../context/ThemeContext';
import { fitExportSummaryScale } from './exportSummaryPresentation';
import './ExportSummary.css';

const CARGO_ORDER = ['CPO','RPO','ROL IV56','ROL IV58','RPS','PFAD','CG','RG','FM','R.POME','POMEFAD','FAME','RPKS','SPKFA','IEPS','IERPO','RCCNO','CDSBO','COL','ROL','RPOME'];
const MONTH_HEADER_HEIGHT = 36;
const TABLE_HEADER_HEIGHT = 30;
const SECTION_ROW_HEIGHT = 28;
const DATA_ROW_HEIGHT = 26;
const TOTAL_ROW_HEIGHT = 26;

const fmt = (n) => !n ? '' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

const getDemmKey = (row, scope = '') => row.demmKey || `${scope}|${row.vessel || 'TBN'}|${row.port || ''}|${row.shipper || ''}`;

const displayEstDemm = (row, skipped = false) => {
  if (skipped) return '-';
  const value = String(row.estDemmurage ?? '').trim();
  if (value) return row.estDemmurage;
  const vessel = String(row.vessel ?? '').trim();
  return vessel && vessel.toUpperCase() !== 'TBN' ? '-' : '';
};

function applyMonthShifts(monthlyData, monthShifts) {
  if (!monthlyData?.length || Object.keys(monthShifts).length === 0) return monthlyData || [];

  const shifted = monthlyData.map(month => ({
    ...month,
    primarySections: (month.primarySections || []).map(section => ({ ...section, rows: [] })),
    secondarySections: (month.secondarySections || []).map(section => ({ ...section, rows: [] })),
  }));

  const ensureSection = (targetMonth, collection, sourceSection) => {
    const sectionId = sourceSection.key || sourceSection.label;
    let targetSection = targetMonth[collection].find(section => (section.key || section.label) === sectionId);
    if (!targetSection) {
      const { rows, eomStock, ...sectionDetails } = sourceSection;
      targetSection = { ...sectionDetails, rows: [] };
      targetMonth[collection].push(targetSection);
    }
    return targetSection;
  };

  monthlyData.forEach((month, sourceMonthIndex) => {
    ['primarySections', 'secondarySections'].forEach(collection => {
      (month[collection] || []).forEach(section => {
        (section.rows || []).forEach(row => {
          const offset = Number(monthShifts[getDemmKey(row)]) || 0;
          const targetMonthIndex = Math.max(0, Math.min(monthlyData.length - 1, sourceMonthIndex + offset));
          ensureSection(shifted[targetMonthIndex], collection, section).rows.push(row);
        });
      });
    });
  });

  return shifted.map(month => ({
    ...month,
    primarySections: month.primarySections.filter(section => section.rows.length > 0),
    secondarySections: month.secondarySections.filter(section => section.rows.length > 0),
  }));
}

function getActiveCargoes(sections, allCargoes) {
  const tot = {};
  allCargoes.forEach(c => tot[c] = 0);
  sections.forEach(s => s.rows.forEach(r => allCargoes.forEach(c => {
    const q = parseFloat(r.cargoes[c]) || 0;
    if (q) tot[c] += q;
  })));
  return allCargoes.filter(c => tot[c] > 0);
}

function combineMonthsForYear(months, year) {
  if (!months.length) return [];

  const combineSections = collection => {
    const merged = new Map();
    months.forEach(month => {
      (month[collection] || []).forEach(section => {
        const sectionId = section.key || section.label;
        if (!merged.has(sectionId)) {
          const { rows, eomStock, ...sectionDetails } = section;
          merged.set(sectionId, { ...sectionDetails, rows: [] });
        }
        merged.get(sectionId).rows.push(...(section.rows || []));
      });
    });
    return [...merged.values()];
  };

  return [{
    key: `${year}-annual`,
    year: Number(year),
    label: `${year} Annual`,
    primarySections: combineSections('primarySections'),
    secondarySections: combineSections('secondarySections'),
  }];
}

function PrimaryTable({ sections, cargoes, isDark, excludedDemm }) {
  const colspan = 12 + cargoes.length + 1;
  const primaryTotals = {}; cargoes.forEach(c => primaryTotals[c] = 0);
  let primaryTotalTotal = 0;

  return (
    <table style={{ borderCollapse: 'collapse', tableLayout: 'auto', width: 'auto' }}>
      <thead>
        <tr style={{ height: TABLE_HEADER_HEIGHT }}>
          {['Entity','Charterer','Vessel','Port','Laycan','CR','ETA','ETB','ETC'].map(h => (
            <th key={h} style={thInfo}>{h}</th>
          ))}
          <th style={thInfo}>Max Loadable</th>
          <th style={thInfo}>Demm Rate PDPR</th>
          <th style={thInfo}>Est Demm</th>
          {cargoes.map(c => <th key={c} style={thCargo}>{c}</th>)}
          <th style={thTotal}>Total</th>
        </tr>
      </thead>
      <tbody>
        {sections.map((section, si) => {
          const sectionTotals = {}; cargoes.forEach(c => sectionTotals[c] = 0);
          let sectionTotal = 0;

          const sectionEom = section.eomStock;
          let eomHasAny = false;
          let eomTotal = 0;
          if (sectionEom) cargoes.forEach(c => {
            const v = sectionEom[c]; if (v && Math.round(v) !== 0) { eomTotal += v; eomHasAny = true; }
          });

          return (
            <React.Fragment key={si}>
              <tr style={{ height: SECTION_ROW_HEIGHT }}><td colSpan={colspan} style={sectionHeaderGreen}>{section.label}</td></tr>
              {section.rows.map((row, ri) => {
                let rowTotal = 0;
                cargoes.forEach(c => {
                  const q = parseFloat(row.cargoes[c]) || 0;
                  if (q) { sectionTotals[c] += q; sectionTotal += q; rowTotal += q; }
                });
                const rowStyle = row.isClosed ? closedRow(isDark) : {};
                const divider = rowDivider(isDark);
                return (
                  <tr key={ri} style={{ ...rowStyle, height: DATA_ROW_HEIGHT }}>
                    <td style={{ ...entityCell, ...divider }}>{row.entity}</td>
                    <td style={{ ...chartererCell, ...divider }}>{row.charterer}</td>
                    <td style={{ ...vesselCell, ...divider }}>{row.vessel}</td>
                    <td style={{ ...portCell, ...divider }}>{row.port}</td>
                    <td style={{ ...dateCell, ...divider }}>{row.laycan}</td>
                    <td style={{ ...dateCell, ...divider }}>{row.cr}</td>
                    <td style={{ ...dateCell, ...divider }}>{row.eta}</td>
                    <td style={{ ...dateCell, ...divider }}>{row.etb}</td>
                    <td style={{ ...dateCell, ...divider }}>{row.etc}</td>
                    <td style={{ ...vesselSizeCell, ...divider }}>{row.vesselSize ? `${fmt(row.vesselSize)} mts` : ''}</td>
                    <td style={{ ...demmCell, ...divider }}>{row.demmurage}</td>
                    <td style={{ ...demmCell, ...divider }}>{displayEstDemm(row, excludedDemm.has(getDemmKey(row)))}</td>
                    {cargoes.map(c => {
                      const q = parseFloat(row.cargoes[c]) || 0;
                      return <td key={c} style={{ ...qtyCell, ...(q ? hasValue(isDark) : {}), ...divider }}>{q ? fmt(q) : ''}</td>;
                    })}
                    <td style={{ ...qtyCell, ...hasValue(isDark), ...divider, fontWeight: 700 }}>{rowTotal ? fmt(rowTotal) : ''}</td>
                  </tr>
                );
              })}
              <tr style={{ height: TOTAL_ROW_HEIGHT }}>
                <td colSpan={12} style={{ ...sectionTotalGreen, textAlign: 'left', paddingLeft: 12 }}>{section.label} Total →</td>
                {cargoes.map(c => <td key={c} style={sectionTotalGreen}>{sectionTotals[c] ? fmt(sectionTotals[c]) : ''}</td>)}
                <td style={sectionTotalGreen}>{fmt(sectionTotal)}</td>
              </tr>
              {sectionEom && eomHasAny && (
                <tr style={{ height: TOTAL_ROW_HEIGHT }}>
                  <td colSpan={12} style={{ ...eomRow(isDark), textAlign: 'left', paddingLeft: 24 }}>EOM Stock →</td>
                  {cargoes.map(c => {
                    const v = sectionEom[c];
                    return <td key={c} style={eomRow(isDark)}>{v && Math.round(v) !== 0 ? fmt(v) : ''}</td>;
                  })}
                  <td style={eomRow(isDark)}>{fmt(eomTotal)}</td>
                </tr>
              )}
              {(() => { cargoes.forEach(c => primaryTotals[c] += sectionTotals[c]); primaryTotalTotal += sectionTotal; return null; })()}
            </React.Fragment>
          );
        })}
        <tr style={{ height: TOTAL_ROW_HEIGHT }}>
          <td colSpan={12} style={{ ...primaryTotalRow, textAlign: 'left', paddingLeft: 12 }}>EUP / PMC / SPC / TPG Total →</td>
          {cargoes.map(c => <td key={c} style={primaryTotalRow}>{primaryTotals[c] ? fmt(primaryTotals[c]) : ''}</td>)}
          <td style={primaryTotalRow}>{fmt(primaryTotalTotal)}</td>
        </tr>
      </tbody>
    </table>
  );
}

function SecondaryTable({ secondarySections, primarySections, cargoes, isDark, excludedDemm }) {
  const colspan = 12 + cargoes.length + 1;
  const secTotals = {}; cargoes.forEach(c => secTotals[c] = 0);
  let secTotal = 0;

  return (
    <table style={{ borderCollapse: 'collapse', tableLayout: 'auto', width: 'auto' }}>
      <thead>
        <tr style={{ height: TABLE_HEADER_HEIGHT }}>
          {['Entity','Charterer','Vessel','Port','Laycan','CR','ETA','ETB','ETC'].map(h => <th key={h} style={thInfo}>{h}</th>)}
          <th style={thInfo}>Max Loadable</th>
          <th style={thInfo}>Demm Rate PDPR</th>
          <th style={thInfo}>Est Demm</th>
          {cargoes.map(c => <th key={c} style={thCargo}>{c}</th>)}
          <th style={thTotal}>Total</th>
        </tr>
      </thead>
      <tbody>
        {secondarySections.map((section, si) => {
          const isJPN = section.isJPN;
          const headerStyle = isJPN ? sectionHeaderJpn : sectionHeaderBrown;
          const totalStyle = isJPN ? sectionTotalJpn : sectionTotalBrown;
          const valStyle = isJPN ? hasValueJpn(isDark) : hasValue3p(isDark);

          const sectionTotals = {}; cargoes.forEach(c => sectionTotals[c] = 0);
          let sectionTotal = 0;

          return (
            <React.Fragment key={si}>
              <tr style={{ height: SECTION_ROW_HEIGHT }}><td colSpan={colspan} style={headerStyle}>{section.label}</td></tr>
              {section.rows.map((row, ri) => {
                let rowTotal = 0;
                cargoes.forEach(c => {
                  const q = parseFloat(row.cargoes[c]) || 0;
                  if (q) { sectionTotals[c] += q; sectionTotal += q; rowTotal += q; }
                });
                const rowStyle = row.isClosed ? closedRow(isDark) : {};
                const divider = rowDivider(isDark);
                return (
                  <tr key={ri} style={{ ...rowStyle, height: DATA_ROW_HEIGHT }}>
                    <td style={{ ...entityCell, ...divider }}>{row.entity}</td>
                    <td style={{ ...chartererCell, ...divider }}>{row.charterer}</td>
                    <td style={{ ...vesselCell, ...divider }}>{row.vessel}</td>
                    <td style={{ ...portCell, ...divider }}>{row.port}</td>
                    <td style={{ ...dateCell, ...divider }}>{row.laycan}</td>
                    <td style={{ ...dateCell, ...divider }}>{row.cr}</td>
                    <td style={{ ...dateCell, ...divider }}>{row.eta}</td>
                    <td style={{ ...dateCell, ...divider }}>{row.etb}</td>
                    <td style={{ ...dateCell, ...divider }}>{row.etc}</td>
                    <td style={{ ...vesselSizeCell, ...divider }}>{row.vesselSize ? `${fmt(row.vesselSize)} mts` : ''}</td>
                    <td style={{ ...demmCell, ...divider }}>{row.demmurage}</td>
                    <td style={{ ...demmCell, ...divider }}>{displayEstDemm(row, excludedDemm.has(getDemmKey(row)))}</td>
                    {cargoes.map(c => {
                      const q = parseFloat(row.cargoes[c]) || 0;
                      return <td key={c} style={{ ...qtyCell, ...(q ? valStyle : {}), ...divider }}>{q ? fmt(q) : ''}</td>;
                    })}
                    <td style={{ ...qtyCell, ...valStyle, ...divider, fontWeight: 700 }}>{rowTotal ? fmt(rowTotal) : ''}</td>
                  </tr>
                );
              })}
              <tr style={{ height: TOTAL_ROW_HEIGHT }}>
                <td colSpan={12} style={{ ...totalStyle, textAlign: 'left', paddingLeft: 12 }}>{section.label} Total →</td>
                {cargoes.map(c => <td key={c} style={totalStyle}>{sectionTotals[c] ? fmt(sectionTotals[c]) : ''}</td>)}
                <td style={totalStyle}>{fmt(sectionTotal)}</td>
              </tr>
              {(() => { cargoes.forEach(c => secTotals[c] += sectionTotals[c]); secTotal += sectionTotal; return null; })()}
            </React.Fragment>
          );
        })}
        {(() => {
          const grandTotals = { ...secTotals };
          let grandTotal = secTotal;
          if (primarySections) primarySections.forEach(s => s.rows.forEach(r => cargoes.forEach(c => {
            const q = parseFloat(r.cargoes[c]) || 0;
            if (q) { grandTotals[c] = (grandTotals[c] || 0) + q; grandTotal += q; }
          })));
          return (
            <tr style={{ height: TOTAL_ROW_HEIGHT }}>
              <td colSpan={12} style={{ ...grandTotalRow, textAlign: 'left', paddingLeft: 12 }}>Total Export →</td>
              {cargoes.map(c => <td key={c} style={grandTotalRow}>{grandTotals[c] ? fmt(grandTotals[c]) : ''}</td>)}
              <td style={grandTotalRow}>{fmt(grandTotal)}</td>
            </tr>
          );
        })()}
      </tbody>
    </table>
  );
}

export default function ExportSummary({ history = false }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [excludedDemm, setExcludedDemm] = useState(() => new Set());
  const [monthShifts, setMonthShifts] = useState(() => ({}));
  const [viewMode, setViewMode] = useState('month');
  const [selectedYear, setSelectedYear] = useState('');
  const [selectedMonth, setSelectedMonth] = useState('');
  const { isDark } = useTheme();

  const load = (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    api.get(history ? '/sheets/export-summary-total' : '/sheets/export-summary')
      .then(r => setData(r.data))
      .catch(err => setError(err.response?.data?.error || `Failed to load ${history ? 'Export Summary Total' : 'Export Summary'}`))
      .finally(() => { if (!silent) setLoading(false); });
  };

  useEffect(() => {
    load();
  }, [history]);

  useEffect(() => {
    if (!history || !data?.monthlyData?.length) return;
    const years = (data.availableYears?.length
      ? data.availableYears
      : [...new Set(data.monthlyData.map(month => month.year))])
      .map(Number)
      .sort((a, b) => b - a);
    const currentYear = new Date().getFullYear();
    setSelectedYear(current => {
      const numeric = Number(current);
      if (years.includes(numeric)) return String(numeric);
      return String(years.includes(currentYear) ? currentYear : years[0]);
    });
  }, [data, history]);

  useEffect(() => {
    if (!history || !selectedYear || !data?.monthlyData?.length) return;
    const months = data.monthlyData
      .filter(month => Number(month.year) === Number(selectedYear))
      .map(month => Number(month.month))
      .sort((a, b) => a - b);
    const currentMonth = new Date().getMonth() + 1;
    const preferred = Number(selectedYear) === new Date().getFullYear() && months.includes(currentMonth)
      ? currentMonth
      : months[months.length - 1];
    setSelectedMonth(current => months.includes(Number(current)) ? String(Number(current)) : String(preferred || ''));
  }, [data, history, selectedYear]);
  useDataRefresh({
    databases: ['DB5', 'DB6', 'DB7'],
    resources: ['vessel-update', 'export-summary'],
    onRefresh: () => load(true),
  });

  const bg = isDark ? '#121212' : '#f5f5f5';
  const text = isDark ? '#e0e0e0' : '#1a1a2e';

  const toggleDemm = key => {
    setExcludedDemm(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const shiftMonth = (key, direction) => {
    setMonthShifts(current => {
      const nextOffset = (Number(current[key]) || 0) + direction;
      const next = { ...current };
      if (nextOffset === 0) delete next[key];
      else next[key] = nextOffset;
      return next;
    });
  };

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: '#555' }}>Loading vessel data...</div>;
  if (error) return <div style={{ color: '#d32f2f', textAlign: 'center', padding: 20 }}>{error}</div>;
  if (!data) return null;

  const allCargoes = (data.allCargoes || []).slice().sort();
  const activeCargoes = CARGO_ORDER.filter(c => allCargoes.indexOf(c) !== -1);
  allCargoes.forEach(c => { if (activeCargoes.indexOf(c) === -1) activeCargoes.push(c); });
  const years = (data.availableYears?.length
    ? data.availableYears
    : [...new Set((data.monthlyData || []).map(month => month.year))])
    .map(Number)
    .sort((a, b) => b - a);
  const monthsForYear = (data.monthlyData || [])
    .filter(month => Number(month.year) === Number(selectedYear))
    .sort((a, b) => Number(a.month) - Number(b.month));
  const displayedMonthlyData = history
    ? (viewMode === 'year'
      ? combineMonthsForYear(monthsForYear, selectedYear)
      : monthsForYear.filter(month => Number(month.month) === Number(selectedMonth)))
    : applyMonthShifts(data.monthlyData || [], monthShifts);
  const shipmentCount = displayedMonthlyData.reduce((total, month) => total
    + (month.primarySections || []).reduce((count, section) => count + (section.rows || []).length, 0)
    + (month.secondarySections || []).reduce((count, section) => count + (section.rows || []).length, 0), 0);

  return (
    <div style={{ background: bg, color: text, padding: 12, minHeight: 'calc(100vh - var(--topbar-height))', margin: '-28px -32px', textAlign: 'center', transition: 'background 0.3s, color 0.3s', fontSize: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '10px 16px', background: '#1a1a2e', color: '#fff', borderRadius: 6, marginBottom: history ? 10 : 16, textAlign: 'left' }}>
        <h1 style={{ fontSize: 18, fontWeight: 600 }}>{history ? 'Export Summary Total' : 'Exports Breakdown'}</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, opacity: 0.8 }}>{data.today}</span>
          <button onClick={load} style={btnGreen}>↻ Refresh</button>
        </div>
      </div>

      {history && (
        <div style={{ ...historyToolbar(isDark), marginBottom: 18 }}>
          <div role="group" aria-label="Summary period" style={segmentedControl(isDark)}>
            <button type="button" onClick={() => setViewMode('month')} style={segmentButton(viewMode === 'month', isDark)}>Month</button>
            <button type="button" onClick={() => setViewMode('year')} style={segmentButton(viewMode === 'year', isDark)}>Year</button>
          </div>
          <label style={filterLabel(isDark)}>
            Year
            <select value={selectedYear} onChange={event => setSelectedYear(event.target.value)} style={filterSelect(isDark)}>
              {years.map(year => <option key={year} value={year}>{year}</option>)}
            </select>
          </label>
          {viewMode === 'month' && (
            <label style={filterLabel(isDark)}>
              Month
              <select value={selectedMonth} onChange={event => setSelectedMonth(event.target.value)} style={filterSelect(isDark)}>
                {monthsForYear.map(month => <option key={month.key} value={month.month}>{month.label.replace(` ${month.year}`, '')}</option>)}
              </select>
            </label>
          )}
          <span style={{ marginLeft: 'auto', color: isDark ? '#a3a3a3' : '#64748b', fontSize: 12, whiteSpace: 'nowrap' }}>
            {viewMode === 'year' ? `${monthsForYear.length} months` : (displayedMonthlyData[0]?.label || 'No month')} · {shipmentCount} shipments
          </span>
        </div>
      )}

      {history && displayedMonthlyData.length === 0 && (
        <div style={emptyHistory(isDark)}>No export records are available for this period.</div>
      )}

      {displayedMonthlyData.map((m, mi) => (
        <React.Fragment key={m.key || mi}>
          {m.primarySections?.length > 0 && (
            <CapturableBlock
              isDark={isDark}
              label={`${m.label} Export`}
              controls={<DemmControlRail sections={m.primarySections} excludedDemm={excludedDemm} onToggle={toggleDemm} onShift={shiftMonth} monthIndex={mi} monthCount={displayedMonthlyData.length} isDark={isDark} includeEom={!history || viewMode === 'month'} allowMonthShift={!history} />}
            >
              <MonthBlock label={`${m.label} Export`} isDark={isDark}>
                <PrimaryTable sections={m.primarySections} cargoes={getActiveCargoes(m.primarySections, activeCargoes)} isDark={isDark} excludedDemm={excludedDemm} />
              </MonthBlock>
            </CapturableBlock>
          )}
          {m.secondarySections?.length > 0 && (
            <CapturableBlock
              isDark={isDark}
              label={`${m.label} Export (3P / JPN)`}
              controls={<DemmControlRail sections={m.secondarySections} excludedDemm={excludedDemm} onToggle={toggleDemm} onShift={shiftMonth} monthIndex={mi} monthCount={displayedMonthlyData.length} isDark={isDark} allowMonthShift={!history} />}
            >
              <MonthBlock label={`${m.label} Export (3P / JPN)`} isDark={isDark}>
                <SecondaryTable secondarySections={m.secondarySections} primarySections={m.primarySections} cargoes={getActiveCargoes((m.primarySections || []).concat(m.secondarySections), activeCargoes)} isDark={isDark} excludedDemm={excludedDemm} />
              </MonthBlock>
            </CapturableBlock>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function DemmControlRail({ sections, excludedDemm, onToggle, onShift, monthIndex, monthCount, isDark, includeEom = false, allowMonthShift = true }) {
  const railRows = [];
  sections.forEach(section => {
    railRows.push({ type: 'spacer', height: SECTION_ROW_HEIGHT });
    (section.rows || []).forEach(row => railRows.push({ type: 'shipment', height: DATA_ROW_HEIGHT, row }));
    railRows.push({ type: 'spacer', height: TOTAL_ROW_HEIGHT });
    if (includeEom && hasEomValues(section.eomStock)) railRows.push({ type: 'spacer', height: TOTAL_ROW_HEIGHT });
  });
  railRows.push({ type: 'spacer', height: TOTAL_ROW_HEIGHT });

  return (
    <div aria-label="Shipment display controls" style={{ flex: `0 0 ${allowMonthShift ? 118 : 72}px`, width: allowMonthShift ? 118 : 72, marginRight: 6, textAlign: 'center' }}>
      <div style={{ height: MONTH_HEADER_HEIGHT, display: 'flex', alignItems: 'center', justifyContent: 'center', color: isDark ? '#9ca3af' : '#64748b', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3 }}>
        Display
      </div>
      <div style={{ height: TABLE_HEADER_HEIGHT }} />
      {railRows.map((railRow, index) => {
        if (railRow.type === 'spacer') return <div key={`spacer-${index}`} style={{ height: railRow.height }} />;
        const row = railRow.row;
        const key = getDemmKey(row);
        const skipped = excludedDemm.has(key);
        const label = `${row.vessel || 'TBN'} - ${row.port || '-'} - ${row.shipper || '-'}`;
        return (
          <div key={key} style={{ height: railRow.height, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
            <button
              type="button"
              aria-pressed={skipped}
              aria-label={`${skipped ? 'Include' : 'Skip'} demurrage for ${label}`}
              title={`${skipped ? 'Include' : 'Skip'} demurrage - ${label}`}
              onClick={() => onToggle(key)}
              style={{
                minWidth: 62, height: 21, border: `1px solid ${skipped ? '#d97706' : (isDark ? '#4b5563' : '#cbd5e1')}`,
                borderRadius: 4, padding: '0 5px',
                background: skipped ? (isDark ? '#3b2a1a' : '#fff7ed') : (isDark ? '#252525' : '#f8fafc'),
                color: skipped ? (isDark ? '#fbbf24' : '#9a3412') : (isDark ? '#d1d5db' : '#475569'),
                fontFamily: 'inherit', fontSize: 9, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap'
              }}
            >
              {skipped ? 'Include' : 'Skip'}
            </button>
            {allowMonthShift && (
              <>
                <MonthShiftButton
                  direction="up"
                  disabled={monthIndex === 0}
                  label={`Move ${label} to the previous month`}
                  onClick={() => onShift(key, -1)}
                  isDark={isDark}
                />
                <MonthShiftButton
                  direction="down"
                  disabled={monthIndex === monthCount - 1}
                  label={`Move ${label} to the next month`}
                  onClick={() => onShift(key, 1)}
                  isDark={isDark}
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MonthShiftButton({ direction, disabled, label, onClick, isDark }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 22,
        height: 21,
        border: `1px solid ${isDark ? '#4b5563' : '#cbd5e1'}`,
        borderRadius: 4,
        padding: 0,
        background: isDark ? '#252525' : '#f8fafc',
        color: disabled ? (isDark ? '#525252' : '#cbd5e1') : (isDark ? '#d1d5db' : '#334155'),
        fontFamily: 'inherit',
        fontSize: 12,
        fontWeight: 700,
        lineHeight: 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {direction === 'up' ? '↑' : '↓'}
    </button>
  );
}

function hasEomValues(eom) {
  if (!eom) return false;
  return Object.values(eom).some(value => value && Math.round(value) !== 0);
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="export-summary-action-icon">
      <path d="M8.5 5.5 10 3.5h4l1.5 2H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-10a2 2 0 0 1 2-2h3.5Z" />
      <circle cx="12" cy="12.5" r="3.5" />
    </svg>
  );
}

function FullscreenIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="export-summary-action-icon">
      <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="export-summary-close-icon">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

function ExportSummaryFullscreen({ isDark, label, children, onClose }) {
  const stageRef = useRef(null);
  const contentRef = useRef(null);
  const [fit, setFit] = useState({ scale: 1, width: null, height: null });

  useLayoutEffect(() => {
    let frameId;
    const fitTable = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        const stage = stageRef.current;
        const content = contentRef.current;
        if (!stage || !content) return;

        const stageStyle = window.getComputedStyle(stage);
        const horizontalPadding = parseFloat(stageStyle.paddingLeft || 0) + parseFloat(stageStyle.paddingRight || 0);
        const verticalPadding = parseFloat(stageStyle.paddingTop || 0) + parseFloat(stageStyle.paddingBottom || 0);
        const availableWidth = Math.max(1, stage.clientWidth - horizontalPadding);
        const availableHeight = Math.max(1, stage.clientHeight - verticalPadding);
        const contentWidth = content.offsetWidth;
        const contentHeight = content.offsetHeight;
        const scale = fitExportSummaryScale(availableWidth, availableHeight, contentWidth, contentHeight);

        setFit({
          scale,
          width: contentWidth * scale,
          height: contentHeight * scale
        });
      });
    };

    fitTable();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitTable);
    if (observer) {
      if (stageRef.current) observer.observe(stageRef.current);
      if (contentRef.current) observer.observe(contentRef.current);
    }
    window.addEventListener('resize', fitTable);

    return () => {
      cancelAnimationFrame(frameId);
      observer?.disconnect();
      window.removeEventListener('resize', fitTable);
    };
  }, [children]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  useEffect(() => {
    const handleKeyDown = event => {
      if (event.key === 'Escape') onClose();
    };
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, [onClose]);

  const ready = fit.width !== null && fit.height !== null;

  return (
    <div className={`export-summary-fullscreen${isDark ? ' is-dark' : ''}`} role="dialog" aria-modal="true" aria-label={`${label} fullscreen table`}>
      <div className="export-summary-fullscreen-toolbar">
        <span className="export-summary-fullscreen-title">{label}</span>
        <button type="button" className="export-summary-fullscreen-close" onClick={onClose} title="Exit fullscreen" aria-label="Exit fullscreen">
          <CloseIcon />
        </button>
      </div>
      <div ref={stageRef} className="export-summary-fullscreen-stage">
        <div
          className="export-summary-fullscreen-fit"
          style={{ width: ready ? fit.width : 0, height: ready ? fit.height : 0 }}
        >
          <div
            ref={contentRef}
            className="export-summary-fullscreen-content"
            style={{ transform: `scale(${fit.scale})`, visibility: ready ? 'visible' : 'hidden' }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function CapturableBlock({ isDark, label, children, controls }) {
  const ref = useRef(null);
  const [status, setStatus] = useState('idle'); // idle | capturing | copied | downloaded | failed
  const [presenting, setPresenting] = useState(false);

  const handleCapture = async () => {
    if (!ref.current) return;
    setStatus('capturing');
    try {
      const blob = await toBlob(ref.current, {
        pixelRatio: 2,
        backgroundColor: isDark ? '#1e1e1e' : '#ffffff',
        cacheBust: true
      });
      if (!blob) { setStatus('failed'); setTimeout(() => setStatus('idle'), 2000); return; }
      try {
        if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          setStatus('copied');
        } else {
          downloadBlob(blob);
          setStatus('downloaded');
        }
      } catch {
        downloadBlob(blob);
        setStatus('downloaded');
      }
      setTimeout(() => setStatus('idle'), 2000);
    } catch (err) {
      console.error('Capture failed:', err);
      setStatus('failed');
      setTimeout(() => setStatus('idle'), 2000);
    }
  };

  const openFullscreen = async () => {
    setPresenting(true);
    try {
      await document.documentElement.requestFullscreen?.();
    } catch {
      // The fixed overlay remains available when browser fullscreen is denied.
    }
  };

  const closeFullscreen = () => {
    setPresenting(false);
    if (document.fullscreenElement) {
      const exitRequest = document.exitFullscreen?.();
      exitRequest?.catch?.(() => {});
    }
  };

  const captureLabel = {
    idle: 'Copy Table',
    capturing: 'Capturing...',
    copied: 'Copied!',
    downloaded: 'Downloaded',
    failed: 'Failed'
  }[status];

  const bg = status === 'copied' || status === 'downloaded' ? '#1565c0' : '#2d6a4f';

  return (
    <div style={{ marginBottom: 30, display: 'inline-block', textAlign: 'left', marginRight: 16 }}>
      <div className="export-summary-block-toolbar">
        <button
          type="button"
          onClick={handleCapture}
          disabled={status === 'capturing'}
          className="export-summary-action-button"
          style={{ background: bg }}
        >
          <CameraIcon />
          {captureLabel}
        </button>
        <button type="button" onClick={openFullscreen} className="export-summary-action-button export-summary-fullscreen-button">
          <FullscreenIcon />
          Fullscreen
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center' }}>
        {controls}
        <div ref={ref}>{children}</div>
      </div>
      {presenting && (
        <ExportSummaryFullscreen isDark={isDark} label={label} onClose={closeFullscreen}>
          {children}
        </ExportSummaryFullscreen>
      )}
    </div>
  );
}

function downloadBlob(blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'export-table.png';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function MonthBlock({ label, isDark, children }) {
  return (
    <div style={{ background: isDark ? '#1e1e1e' : '#fff', borderRadius: 6, boxShadow: '0 2px 8px rgba(0,0,0,0.1)', display: 'inline-block' }}>
      <div style={{ height: MONTH_HEADER_HEIGHT, boxSizing: 'border-box', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1a1a2e', color: '#fff', padding: '10px 16px', borderRadius: '6px 6px 0 0' }}>
        <span style={{ fontSize: 15, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
      </div>
      {children}
    </div>
  );
}

// Styles
const summaryColumnDivider = { borderRight: '1px solid rgba(100, 116, 139, 0.45)' };
const thInfo = { background: '#1a1a2e', color: '#fff', padding: '7px 10px', textAlign: 'center', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', borderRight: '1px solid rgba(255, 255, 255, 0.2)' };
const thCargo = { ...thInfo, background: '#16213e', minWidth: 55 };
const thTotal = { ...thInfo, background: '#0f3460' };
const vesselCell = { textAlign: 'left', fontWeight: 500, paddingLeft: 12, padding: '5px 10px', fontSize: 12, whiteSpace: 'nowrap', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' };
const demmCell = { padding: '5px 10px', fontSize: 11, textAlign: 'center', whiteSpace: 'nowrap', fontFamily: 'monospace', color: 'inherit' };
const entityCell = { padding: '5px 10px', fontSize: 11, color: '#555', maxWidth: 100, textAlign: 'left' };
const chartererCell = { ...entityCell, maxWidth: 120, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const portCell = { padding: '5px 10px', fontSize: 11, color: '#555', maxWidth: 150, textAlign: 'left' };
const dateCell = { padding: '5px 10px', fontSize: 11, textAlign: 'center' };
const vesselSizeCell = { ...dateCell, minWidth: 65, fontWeight: 500, whiteSpace: 'nowrap' };
const qtyCell = { padding: '5px 10px', textAlign: 'center', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' };
const rowDivider = (d) => ({ borderBottom: `1px solid ${d ? '#4b5563' : '#cbd5e1'}`, borderRight: `1px solid ${d ? '#4b5563' : '#cbd5e1'}` });
const hasValue = (d) => ({ background: d ? '#1b3328' : '#f0f7f4', fontWeight: 600 });
const hasValue3p = (d) => ({ background: d ? '#3b2a1a' : '#fdf5ed', fontWeight: 600 });
const hasValueJpn = (d) => ({ background: d ? '#3b3a1a' : '#fffde7', fontWeight: 600 });
const closedRow = (d) => ({ background: d ? '#2a2a2a' : '#e0e0e0', color: d ? '#666' : '#777' });
const sectionHeaderGreen = { background: '#2d6a4f', color: '#fff', fontWeight: 700, padding: '6px 12px', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, textAlign: 'left' };
const sectionHeaderBrown = { background: '#6d4c2a', color: '#fff', fontWeight: 700, padding: '6px 12px', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, textAlign: 'left' };
const sectionHeaderJpn = { background: '#f9a825', color: '#1a1a2e', fontWeight: 700, padding: '6px 12px', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, textAlign: 'left' };
const sectionTotalGreen = { ...summaryColumnDivider, background: '#c8e6c9', color: '#1b5e20', fontWeight: 700, padding: '5px 8px', fontSize: 11, textAlign: 'center' };
const sectionTotalBrown = { ...summaryColumnDivider, background: '#6d4c2a', color: '#fff', fontWeight: 700, padding: '5px 8px', fontSize: 11, textAlign: 'center' };
const sectionTotalJpn = { ...summaryColumnDivider, background: '#fff9c4', color: '#f57f17', fontWeight: 700, padding: '5px 8px', fontSize: 11, textAlign: 'center' };
const eomRow = (d) => ({ ...summaryColumnDivider, background: d ? '#2a2a2a' : '#d9d9d9', color: d ? '#888' : '#444', fontWeight: 600, padding: '5px 8px', fontSize: 11, fontStyle: 'italic', textAlign: 'center' });
const primaryTotalRow = { ...summaryColumnDivider, background: '#0d3b2e', color: '#a8e6cf', fontWeight: 700, padding: '7px 8px', fontSize: 12, textAlign: 'center' };
const grandTotalRow = { ...summaryColumnDivider, background: '#1a1a2e', color: '#4ecdc4', fontWeight: 700, padding: '8px', fontSize: 12, textAlign: 'center' };
const btnGreen = { background: '#2d6a4f', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 500 };
const btnDark = { background: '#455a64', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 500 };
const historyToolbar = (d) => ({
  display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '10px 12px',
  background: d ? '#1e1e1e' : '#fff', border: `1px solid ${d ? '#353535' : '#d7dee7'}`,
  borderRadius: 6, textAlign: 'left', boxShadow: d ? 'none' : '0 1px 3px rgba(15, 23, 42, 0.06)',
});
const segmentedControl = (d) => ({
  display: 'inline-flex', padding: 2, border: `1px solid ${d ? '#4b5563' : '#cbd5e1'}`,
  borderRadius: 5, background: d ? '#171717' : '#eef2f6',
});
const segmentButton = (active, d) => ({
  minWidth: 66, height: 28, padding: '0 12px', border: 0, borderRadius: 3,
  background: active ? '#2d6a4f' : 'transparent', color: active ? '#fff' : (d ? '#d1d5db' : '#475569'),
  fontFamily: 'inherit', fontSize: 12, fontWeight: 700, cursor: 'pointer',
});
const filterLabel = (d) => ({
  display: 'inline-flex', alignItems: 'center', gap: 7, color: d ? '#d1d5db' : '#334155',
  fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
});
const filterSelect = (d) => ({
  minWidth: 118, height: 32, padding: '0 28px 0 9px', border: `1px solid ${d ? '#4b5563' : '#cbd5e1'}`,
  borderRadius: 4, background: d ? '#262626' : '#fff', color: d ? '#f3f4f6' : '#172033',
  fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
});
const emptyHistory = (d) => ({
  margin: '48px auto', maxWidth: 520, padding: '28px 20px', border: `1px dashed ${d ? '#4b5563' : '#cbd5e1'}`,
  borderRadius: 6, background: d ? '#1e1e1e' : '#fff', color: d ? '#a3a3a3' : '#64748b', fontSize: 13,
});
