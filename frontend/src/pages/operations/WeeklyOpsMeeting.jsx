import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import api from '../../services/api';
import useDataRefresh from '../../services/useDataRefresh';
import { buildWeeklyOpsCards, fitPresentationScale, relativeCardIndex } from './weeklyOpsPresentation';
import './WeeklyOpsMeeting.css';

const RefreshIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5" /><path d="M4 18v-5h5" /><path d="M6.1 9A7 7 0 0 1 18.5 6.5L20 11M4 13l1.5 4.5A7 7 0 0 0 17.9 15" /></svg>
);

const PrintIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9V3h12v6" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><path d="M6 14h12v7H6z" /></svg>
);

const PresentIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v12H4z" /><path d="m9 21 3-5 3 5M8 21h8" /></svg>
);

const ArrowIcon = ({ direction }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d={direction === 'left' ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'} /></svg>
);

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
);

function formatNumber(value, fallback = '-') {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatTolerance(value) {
  if (value == null || value === '') return '-';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return `${(parsed <= 1 ? parsed * 100 : parsed).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function formatUpdated(value) {
  if (!value) return 'Waiting for source refresh';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('en-SG', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function CheckCell({ checked, label }) {
  return (
    <span className={`wom-check ${checked ? 'is-checked' : ''}`} role="img" aria-label={`${label}: ${checked ? 'Yes' : 'No'}`}>
      {checked ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg> : null}
    </span>
  );
}

function EmptyRow({ colSpan, message }) {
  return <tr><td colSpan={colSpan} className="wom-empty">{message}</td></tr>;
}

function SectionHeader({ title, count, note }) {
  return (
    <div className="wom-section-heading">
      <div><h3>{title}</h3>{note ? <p>{note}</p> : null}</div>
      <span>{count} {count === 1 ? 'record' : 'records'}</span>
    </div>
  );
}

function LocalDeliveriesTable({ rows, emptyMessage = 'No open local deliveries' }) {
  return (
    <div className="wom-table-scroll">
      <table className="wom-table wom-local-table">
        <thead><tr>
          <th>Sales / Purchase</th><th>Seller / Buyer</th><th>Certification</th>
          <th>Cargo</th><th>Quantity</th><th>Performed</th><th>Balance</th><th>Outspec Qty</th>
          <th>Tolerance</th><th>Shipment Period</th><th>Payment</th><th>Remarks</th><th>Payment Status</th>
        </tr></thead>
        <tbody>
          {rows.length ? rows.map(row => (
            <tr key={row.id}>
              <td>{row.side}</td><td className="wom-strong">{row.counterparty || '-'}</td><td>{row.certification || '-'}</td>
              <td>{row.cargo || '-'}</td><td className="wom-number">{formatNumber(row.quantity)}</td>
              <td className="wom-number">{formatNumber(row.performed)}</td><td className="wom-number">{formatNumber(row.balance)}</td>
              <td className="wom-number">{formatNumber(row.outspecQty)}</td><td className="wom-center">{formatTolerance(row.tolerance)}</td>
              <td>{row.shipmentPeriod || '-'}</td><td className="wom-wrap">{row.paymentTerms || '-'}</td><td className="wom-wrap">{row.remarks || '-'}</td>
              <td className="wom-center"><CheckCell checked={row.paymentStatus} label="Payment status" /></td>
            </tr>
          )) : <EmptyRow colSpan={13} message={emptyMessage} />}
        </tbody>
      </table>
    </div>
  );
}

function EvacTable({ rows, emptyMessage = 'No open import records' }) {
  return (
    <div className="wom-table-scroll">
      <table className="wom-table wom-evac-table">
        <thead><tr>
          <th>Discharge Port</th><th>Loadport</th><th>Vessel</th><th>ETA / ATA</th><th>ETC / ATC</th>
          <th>Laycan</th><th>Certification</th><th>Cargo</th><th>B. Qty</th><th>Remarks</th>
        </tr></thead>
        <tbody>
          {rows.length ? rows.map(row => (
            <tr key={row.id}>
              <td>{row.dischargePort || '-'}</td><td>{row.loadport || '-'}</td>
              <td className="wom-vessel">{row.vessel}</td><td>{row.etaAta || '-'}</td><td>{row.etcAtc || '-'}</td>
              <td>{row.laycan || '-'}</td><td>{row.certification || '-'}</td><td>{row.cargo || '-'}</td>
              <td className="wom-number">{formatNumber(row.bookedQty)}</td><td className="wom-wrap">{row.remarks || '-'}</td>
            </tr>
          )) : <EmptyRow colSpan={10} message={emptyMessage} />}
        </tbody>
      </table>
    </div>
  );
}

function groupedExportRows(rows, showStage) {
  const groups = new Map();
  for (const row of rows) {
    const vessel = String(row.vessel || '').trim().toLowerCase();
    const key = `${showStage ? row.stage || '' : ''}|${vessel || row.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].flatMap(group => group.map((row, index) => ({ row, group, groupIndex: index })));
}

function sharedCell(group, groupIndex, field) {
  const first = group[0]?.[field] || '';
  const shared = group.length > 1 && group.every(row => (row[field] || '') === first);
  if (shared && groupIndex > 0) return null;
  return { value: (shared ? first : group[groupIndex]?.[field]) || '-', rowSpan: shared ? group.length : 1 };
}

function ExportTable({ rows, emptyMessage, showStage = false }) {
  const columnCount = showStage ? 16 : 15;
  const displayedRows = groupedExportRows(rows, showStage);
  return (
    <div className="wom-table-scroll">
      <table className="wom-table wom-export-table">
        <thead><tr>
          <th>Vessel</th><th>Quantity / Certification / Cargo</th>{showStage ? <th>Contract Stage</th> : null}<th>Buyer</th><th>Loadport</th><th>CR</th><th>ETA</th>
          <th>BL Date</th><th>Shipment Period</th><th>Payment Terms</th><th>Remarks</th>
          <th>Payment Status</th><th>Contract Status</th><th>Vsl Nom</th><th>SI</th><th>SD Status</th>
        </tr></thead>
        <tbody>
          {displayedRows.length ? displayedRows.map(({ row, group, groupIndex }, displayIndex) => {
            const vessel = sharedCell(group, groupIndex, 'vessel');
            const cargo = sharedCell(group, groupIndex, 'cargoSummary');
            const stage = showStage ? sharedCell(group, groupIndex, 'stage') : null;
            const cr = sharedCell(group, groupIndex, 'cr');
            const eta = sharedCell(group, groupIndex, 'eta');
            return (
            <tr key={`${row.id}-${row.vessel}-${row.loadport}-${displayIndex}`}>
              {vessel ? <td rowSpan={vessel.rowSpan} className="wom-vessel wom-merged">{vessel.value}</td> : null}
              {cargo ? <td rowSpan={cargo.rowSpan} className="wom-cargo-summary wom-merged">{cargo.value}</td> : null}
              {showStage && stage ? <td rowSpan={stage.rowSpan} className={`wom-stage wom-stage-${row.stage} wom-merged`}>{stage.value}</td> : null}
              <td>{row.buyer || '-'}</td><td>{row.loadport || '-'}</td>
              {cr ? <td rowSpan={cr.rowSpan} className="wom-merged">{cr.value}</td> : null}
              {eta ? <td rowSpan={eta.rowSpan} className="wom-merged">{eta.value}</td> : null}
              <td>{row.blDate || '-'}</td><td>{row.shipmentPeriod || '-'}</td><td className="wom-wrap">{row.paymentTerms || '-'}</td>
              <td className="wom-wrap">{row.remarks || '-'}</td>
              <td className="wom-center"><CheckCell checked={row.paymentStatus} label="Payment status" /></td>
              <td className="wom-center"><CheckCell checked={row.contractStatus} label="Contract status" /></td>
              <td className="wom-center"><CheckCell checked={row.vesselNominated} label="Vessel nominated" /></td>
              <td className="wom-center"><CheckCell checked={row.siStatus} label="SI status" /></td>
              <td className="wom-center"><CheckCell checked={row.sdStatus} label="SD status" /></td>
            </tr>
          );
          }) : <EmptyRow colSpan={columnCount} message={emptyMessage} />}
        </tbody>
      </table>
    </div>
  );
}

function MeetingCard({ card, presentation = false }) {
  return (
    <section className={`wom-card${presentation ? ' wom-presentation-card' : ''}`}>
      <SectionHeader title={card.title} count={card.rows.length} note={card.note} />
      {card.kind === 'local' ? <LocalDeliveriesTable rows={card.rows} /> : null}
      {card.kind === 'import' ? <EvacTable rows={card.rows} /> : null}
      {card.kind === 'export' ? <ExportTable rows={card.rows} showStage={card.showStage} /> : null}
    </section>
  );
}

export function WeeklyOpsMeetingView({ data, refreshing = false, onRefresh = () => {} }) {
  const cards = useMemo(() => buildWeeklyOpsCards(data), [data]);
  const [presentedCardId, setPresentedCardId] = useState(null);
  const presentationStageRef = useRef(null);
  const presentationContentRef = useRef(null);
  const [presentationFit, setPresentationFit] = useState({ scale: 1, width: null, height: null });
  const presentedIndex = cards.findIndex(card => card.id === presentedCardId);
  const presentedCard = presentedIndex >= 0 ? cards[presentedIndex] : null;

  const startPresentation = async () => {
    if (!cards.length) return;
    setPresentedCardId(cards[0].id);
    try {
      await document.documentElement.requestFullscreen?.();
    } catch {
      // The fixed overlay remains usable when the browser denies fullscreen.
    }
  };

  const endPresentation = () => {
    setPresentedCardId(null);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  };

  const movePresentation = direction => {
    if (!cards.length) return;
    const currentIndex = Math.max(0, cards.findIndex(card => card.id === presentedCardId));
    setPresentedCardId(cards[relativeCardIndex(currentIndex, direction, cards.length)].id);
  };

  useEffect(() => {
    if (!presentedCardId) return undefined;
    if (!cards.some(card => card.id === presentedCardId)) {
      setPresentedCardId(cards[0]?.id || null);
    }
    const handleKeyDown = event => {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        movePresentation(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        movePresentation(-1);
      } else if (event.key === 'Escape') {
        setPresentedCardId(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [cards, presentedCardId]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) setPresentedCardId(null);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  useLayoutEffect(() => {
    if (!presentedCard) return undefined;

    const fitTable = () => {
      const stage = presentationStageRef.current;
      const contentElement = presentationContentRef.current;
      if (!stage || !contentElement) return;
      const style = window.getComputedStyle(stage);
      const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const verticalPadding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const availableWidth = Math.max(1, stage.clientWidth - horizontalPadding);
      const availableHeight = Math.max(1, stage.clientHeight - verticalPadding);
      const contentWidth = contentElement.offsetWidth;
      const contentHeight = contentElement.offsetHeight;
      const scale = fitPresentationScale(availableWidth, availableHeight, contentWidth, contentHeight);
      setPresentationFit({ scale, width: contentWidth * scale, height: contentHeight * scale });
    };

    fitTable();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitTable);
    observer?.observe(presentationStageRef.current);
    observer?.observe(presentationContentRef.current);
    window.addEventListener('resize', fitTable);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', fitTable);
    };
  }, [presentedCard]);

  return (
    <div className="weekly-ops-page">
      <div className="wom-toolbar">
        <div>
          <p className="wom-eyebrow">WEEKLY OPERATIONS REVIEW</p>
          <h2>TPG / GR Weekly Ops Meeting</h2>
          <p className="wom-updated">Live from POME, Vessel DB, TPG and GLM operations data · Updated {formatUpdated(data?.updatedAt)}</p>
        </div>
        <div className="wom-actions">
          <button type="button" onClick={onRefresh} disabled={refreshing} title="Refresh meeting data"><RefreshIcon /><span>{refreshing ? 'Refreshing' : 'Refresh'}</span></button>
          <button type="button" onClick={() => window.print()} title="Print weekly meeting view"><PrintIcon /><span>Print</span></button>
          <button type="button" onClick={startPresentation} disabled={!cards.length} title="Present weekly meeting cards"><PresentIcon /><span>Present</span></button>
        </div>
      </div>

      {cards.length ? (
        <div className="wom-card-list">{cards.map(card => <MeetingCard key={card.id} card={card} />)}</div>
      ) : (
        <div className="wom-no-records">No weekly operations records are currently in scope.</div>
      )}

      {presentedCard ? (
        <div className="wom-presentation" role="dialog" aria-modal="true" aria-label="Weekly Ops presentation">
          <div className="wom-presentation-toolbar">
            <div>
              <strong>{presentedCard.title}</strong>
              <span aria-live="polite">{presentedIndex + 1} / {cards.length}</span>
            </div>
            <div className="wom-presentation-actions">
              <button type="button" onClick={() => movePresentation(-1)} title="Previous card" aria-label="Previous card"><ArrowIcon direction="left" /></button>
              <button type="button" onClick={() => movePresentation(1)} title="Next card" aria-label="Next card"><ArrowIcon direction="right" /></button>
              <button type="button" onClick={endPresentation} title="Exit presentation" aria-label="Exit presentation"><CloseIcon /></button>
            </div>
          </div>
          <div ref={presentationStageRef} className="wom-presentation-stage">
            <div
              className="wom-presentation-fit"
              style={{ width: presentationFit.width ?? 'auto', height: presentationFit.height ?? 'auto' }}
            >
              <div
                ref={presentationContentRef}
                className="wom-presentation-content"
                style={{ transform: `scale(${presentationFit.scale})` }}
              >
                <MeetingCard card={presentedCard} presentation />
              </div>
            </div>
          </div>
          <div className="wom-presentation-help">Use left and right arrow keys to navigate. Press Esc to exit.</div>
        </div>
      ) : null}
    </div>
  );
}
export default function WeeklyOpsMeeting() {
  const [data, setData] = useState(null);
  const dataRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = async ({ silent = false, force = false } = {}) => {
    if (!silent) setRefreshing(Boolean(dataRef.current));
    try {
      const response = await api.get('/sheets/weekly-ops-meeting');
      const next = response.data;
      if (silent && !force && dataRef.current?.updatedAt === next.updatedAt) return;
      dataRef.current = next;
      setData(next);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load weekly operations data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, []);
  useDataRefresh({
    databases: ['DB5', 'DB6', 'DB12', 'DB13', 'DB14', 'DB15', 'DB16', 'DB17'],
    resources: ['bulk-databases', 'vessel-update'],
    fallbackMs: 60000,
    onRefresh: ({ reason }) => load({ silent: true, force: reason !== 'fallback' }),
  });

  if (loading && !data) return <div className="wom-state">Preparing weekly operations view...</div>;
  if (error && !data) return <div className="wom-state wom-state-error">{error}<button type="button" onClick={() => load()}>Try again</button></div>;
  return <>{error ? <div className="wom-inline-error">{error}</div> : null}<WeeklyOpsMeetingView data={data} refreshing={refreshing} onRefresh={() => load()} /></>;
}
