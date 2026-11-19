import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../services/api';
import useDataRefresh from '../../services/useDataRefresh';
import { colorFor, fmtNum, normCargo } from './stockUtils';
import './VesselCalendar.css';

const RefreshIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5" /><path d="M4 18v-5h5" /><path d="M6.1 9A7 7 0 0 1 18.5 6.5L20 11M4 13l1.5 4.5A7 7 0 0 0 17.9 15" /></svg>
);

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
);

function isoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseIso(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addIsoDays(value, days) {
  const date = parseIso(value);
  if (!date) return '';
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

function loadingSpanDays(event) {
  const plotValue = Number(event?.loadingPlotDays);
  if (Number.isFinite(plotValue) && plotValue > 0) return Math.max(0.25, plotValue);
  const exactValue = Number(event?.loadingDays);
  if (Number.isFinite(exactValue) && exactValue > 0) return Math.max(0.25, Math.ceil(exactValue * 4) / 4);
  return 1;
}

function formatLoadingDuration(event) {
  const hours = Number(event?.loadingHours) || 0;
  const days = Number(event?.loadingDays) || 0;
  if (!hours) return '-';
  return `${fmtNum(hours)} hours (${fmtNum(days)} days)`;
}

function numericValue(value) {
  const parsed = Number(String(value == null ? '' : value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function vesselColorFor(event) {
  const key = String(event?.vesselKey || event?.vslId || event?.vessel || 'TBN').trim().toLowerCase();
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const value = hash >>> 0;
  const hue = value % 360;
  const saturation = 58 + ((value >>> 8) % 3) * 7;
  const lightness = 38 + ((value >>> 16) % 2) * 7;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

function monthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function monthDays(month) {
  const total = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  return Array.from({ length: total }, (_, index) => new Date(month.getFullYear(), month.getMonth(), index + 1));
}

function monthsBetween(startValue, endValue) {
  const fallback = monthStart(new Date());
  const start = monthStart(parseIso(startValue) || fallback);
  const end = monthStart(parseIso(endValue) || start);
  const months = [];
  const cursor = new Date(start);
  while (cursor <= end && months.length < 24) {
    months.push(new Date(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months.length ? months : [fallback];
}

function formatMonth(date) {
  return date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function formatSelectedDate(value) {
  const date = parseIso(value);
  return date ? date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '-';
}

function formatLedgerDate(date) {
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).replace(/ /g, '-');
}

function formatUpdated(value) {
  if (!value) return 'Waiting for cached data';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function stockValueAt(cargo, date) {
  if (!cargo?.values?.length || !date) return null;
  let latest = null;
  for (const point of cargo.values) {
    if (point.date > date) break;
    if (point.value !== null && point.value !== undefined) latest = point.value;
  }
  return latest;
}

function stockClass(value) {
  if (value == null) return 'is-empty';
  if (value < 0) return 'is-negative';
  if (value === 0) return 'is-zero';
  return '';
}

function VesselDetail({ event, factory, stock, color, onClose }) {
  useEffect(() => {
    const onKeyDown = keyEvent => { if (keyEvent.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const details = [
    ['Factory', factory.label],
    ['VSL ID', event.vslId || '-'],
    ['Entity', event.entity || '-'],
    ['Status', event.status || '-'],
    ['Cargo', event.cargo || '-'],
    ['Quantity', event.quantity ? `${fmtNum(event.quantity)} mts` : '-'],
    ['Total vessel load', event.totalLoadingQuantity ? `${fmtNum(event.totalLoadingQuantity)} mts` : '-'],
    ['Estimated loading', formatLoadingDuration(event)],
    ['Scheduled by', event.scheduleSource || '-'],
    ['Scheduled date', formatSelectedDate(event.scheduleDate)],
    ['ETA', event.eta || '-'],
    ['Cargo Readiness', event.cargoReadiness || '-'],
    ['Stock at date', stock == null ? '-' : `${fmtNum(stock)} mts`],
    ['Laycan', event.laycan || '-'],
    ['ETB / ETC', [event.etb, event.etc].filter(Boolean).join(' / ') || '-'],
  ];

  return (
    <div className="vc-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="vc-modal" role="dialog" aria-modal="true" aria-label={`${event.vessel} details`} onMouseDown={e => e.stopPropagation()}>
        <header className="vc-modal-header">
          <div>
            <span className="vc-cargo-dot" style={{ '--vc-cargo-color': color }} />
            <div><h3>{event.vessel || 'TBN'}</h3><p>{event.cargo || '-'} · {factory.label}</p></div>
          </div>
          <button type="button" className="vc-icon-button" onClick={onClose} title="Close" aria-label="Close vessel details"><CloseIcon /></button>
        </header>
        <dl className="vc-modal-details">
          {details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        {event.remarks ? <div className="vc-modal-remarks"><span>Remarks</span><p>{event.remarks}</p></div> : null}
      </section>
    </div>
  );
}

function buildFactoryView(factory, displayMonths) {
  const days = displayMonths.flatMap(item => monthDays(item));
  const rangeStart = days.length ? isoDate(days[0]) : '';
  const rangeEnd = days.length ? isoDate(days[days.length - 1]) : '';
  const rangeEvents = (factory?.vessels || []).filter(event => event.scheduleDate >= rangeStart && event.scheduleDate <= rangeEnd);
  const scheduledKeys = new Set(rangeEvents.map(event => normCargo(event.cargo)));
  const calendarCargoes = (factory?.cargoes || []).filter(cargo => scheduledKeys.has(cargo.key));
  const eventBlocksByCargoDate = new Map();
  for (const event of rangeEvents) {
    const totalSpanDays = loadingSpanDays(event);
    let segmentStartDay = 0;
    let segmentDate = event.scheduleDate;
    while (segmentStartDay < totalSpanDays) {
      const parsedDate = parseIso(segmentDate);
      if (!parsedDate) break;
      const daysToMonthEnd = new Date(parsedDate.getFullYear(), parsedDate.getMonth() + 1, 0).getDate() - parsedDate.getDate() + 1;
      const segmentDays = Math.min(totalSpanDays - segmentStartDay, daysToMonthEnd);
      if (segmentDate >= rangeStart && segmentDate <= rangeEnd) {
        const key = `${normCargo(event.cargo)}|${segmentDate}`;
        if (!eventBlocksByCargoDate.has(key)) eventBlocksByCargoDate.set(key, []);
        eventBlocksByCargoDate.get(key).push({ event, segmentStartDay, segmentDays, totalSpanDays });
      }
      segmentStartDay += segmentDays;
      segmentDate = addIsoDays(segmentDate, segmentDays);
    }
  }
  return {
    factory,
    days,
    rangeStart,
    rangeEnd,
    rangeEvents,
    rangeQuantity: rangeEvents.reduce((sum, event) => sum + numericValue(event.quantity), 0),
    closedCount: rangeEvents.filter(event => event.isClosed).length,
    cargoNames: (factory?.cargoes || []).map(cargo => cargo.name),
    calendarCargoes,
    eventBlocksByCargoDate,
    unscheduled: factory?.unscheduled || [],
  };
}

function FactoryCalendarPanel({ view, displayMonths, rangeLabel, today, selectedDate, onSelectDate, onSelectEvent, compact = false }) {
  const { factory, rangeEvents, rangeQuantity, closedCount, cargoNames, calendarCargoes, eventBlocksByCargoDate } = view;
  const cargoColor = name => colorFor(name, cargoNames);
  return (
    <section className={`vc-ledger-shell${compact ? ' is-compact' : ''}`}>
      <header className="vc-ledger-title">
        <div><strong>{factory.label}</strong><span>{rangeLabel}</span></div>
        <div><span>{calendarCargoes.length} cargo{calendarCargoes.length === 1 ? '' : 'es'} · {rangeEvents.length} vessel{rangeEvents.length === 1 ? '' : 's'}{closedCount ? ` · ${closedCount} closed` : ''}</span><b>{fmtNum(rangeQuantity)} mts</b></div>
      </header>
      <div className="vc-ledger-scroll">
        {calendarCargoes.length ? (
          <table className="vc-ledger" style={{ minWidth: `${96 + (calendarCargoes.length * 250)}px` }}>
            <colgroup><col className="vc-date-col" />{calendarCargoes.map(cargo => <React.Fragment key={cargo.key}><col className="vc-stock-col" /><col className="vc-shipment-col" /></React.Fragment>)}</colgroup>
            <thead>
              <tr><th rowSpan="2">Date</th>{calendarCargoes.map((cargo, cargoIndex) => {
                const events = rangeEvents.filter(event => normCargo(event.cargo) === cargo.key);
                const quantity = events.reduce((sum, event) => sum + numericValue(event.quantity), 0);
                return <th key={cargo.key} colSpan="2" className={`vc-cargo-group${cargoIndex % 2 ? ' vc-cargo-alt' : ''}`} style={{ '--vc-cargo-color': cargoColor(cargo.name) }}><strong>{cargo.name}</strong><small>{fmtNum(quantity)} mts</small></th>;
              })}</tr>
              <tr>{calendarCargoes.map((cargo, cargoIndex) => <React.Fragment key={cargo.key}><th className={cargoIndex % 2 ? 'vc-cargo-alt' : ''}>Stock</th><th className={cargoIndex % 2 ? 'vc-cargo-alt' : ''}>Vessel / quantity / schedule</th></React.Fragment>)}</tr>
            </thead>
            <tbody>
              {displayMonths.map(displayMonth => {
                const prefix = `${displayMonth.getFullYear()}-${String(displayMonth.getMonth() + 1).padStart(2, '0')}`;
                const monthEvents = rangeEvents.filter(event => event.scheduleDate.startsWith(prefix));
                const monthEndDate = isoDate(monthDays(displayMonth).at(-1));
                return (
                  <React.Fragment key={prefix}>
                    <tr className="vc-month-divider"><th colSpan={1 + (calendarCargoes.length * 2)}>{formatMonth(displayMonth)}</th></tr>
                    {monthDays(displayMonth).map(day => {
                      const date = isoDate(day);
                      const weekend = day.getDay() === 0 || day.getDay() === 6;
                      return (
                        <tr key={date} data-vc-date={date} className={`${date === today ? 'is-today' : ''}${date === selectedDate ? ' is-selected' : ''}`}>
                          <td className={weekend ? 'is-weekend' : ''}><button type="button" className="vc-ledger-date" onClick={() => onSelectDate(date)}>{formatLedgerDate(day)}</button></td>
                          {calendarCargoes.map((cargo, cargoIndex) => {
                            const stock = stockValueAt(cargo, date);
                            const eventBlocks = eventBlocksByCargoDate.get(`${cargo.key}|${date}`) || [];
                            const color = cargoColor(cargo.name);
                            const alternateClass = cargoIndex % 2 ? ' vc-cargo-alt' : '';
                            return (
                              <React.Fragment key={cargo.key}>
                                <td className={`vc-ledger-stock ${stockClass(stock)}${alternateClass}`}>{stock == null ? '-' : <><strong>{fmtNum(stock)}</strong><small> mts</small></>}</td>
                                <td className={`vc-schedule-cell${eventBlocks.length ? ' has-calendar-block' : ''}${alternateClass}`}>{eventBlocks.map(({ event, segmentStartDay, segmentDays, totalSpanDays }, blockIndex) => {
                                  const startsHere = segmentStartDay === 0;
                                  const blockCount = eventBlocks.length;
                                  const laneWidth = 100 / blockCount;
                                  const vesselColor = vesselColorFor(event);
                                  return <button type="button" key={`${event.id}-${segmentStartDay}`} className={`vc-grid-event is-calendar-block${segmentDays < 1 ? ' is-fractional' : ''}${segmentDays <= 0.25 ? ' is-quarter-day' : ''}${segmentDays > 0.25 && segmentDays <= 0.5 ? ' is-half-day' : ''}${event.vessel.toLowerCase() === 'tbn' ? ' is-tbn' : ''}${event.isClosed ? ' is-closed' : ''}${startsHere ? ' is-loading-start' : ' is-loading-continuation'}${segmentStartDay + segmentDays === totalSpanDays ? ' is-loading-end' : ''}`} onClick={() => onSelectEvent({ event, stock, color: vesselColor, factory })} style={{ '--vc-vessel-color': vesselColor, '--vc-span-days': segmentDays, left: `calc(${blockIndex * laneWidth}% + 3px)`, width: `calc(${laneWidth}% - 6px)` }} title={`${event.vessel}: ${fmtNum(event.quantity)} mts ${event.cargo}; estimated loading ${formatLoadingDuration(event)}`}><span><b>{event.vessel}</b><em>{fmtNum(event.quantity)} mts</em></span><small>{event.isClosed ? <u>CLOSED</u> : null}{startsHere ? <><i className={event.scheduleSource === 'ETA' ? 'is-eta' : 'is-cr'}>{event.scheduleSource}</i>{event.scheduleSource === 'ETA' ? event.eta : event.cargoReadiness}</> : <span className="vc-loading-label">Continued</span>}<span className="vc-loading-duration">{fmtNum(event.loadingHours)}h · {fmtNum(event.loadingDays)}d</span></small></button>;
                                })}</td>
                              </React.Fragment>
                            );
                          })}
                        </tr>
                      );
                    })}
                    <tr className="vc-month-total"><th>{formatMonth(displayMonth).toUpperCase()}</th>{calendarCargoes.map(cargo => {
                      const events = monthEvents.filter(event => normCargo(event.cargo) === cargo.key);
                      const quantity = events.reduce((sum, event) => sum + numericValue(event.quantity), 0);
                      const endingStock = stockValueAt(cargo, monthEndDate);
                      const cargoIndex = calendarCargoes.findIndex(item => item.key === cargo.key);
                      const alternateClass = cargoIndex % 2 ? 'vc-cargo-alt' : '';
                      return <React.Fragment key={cargo.key}><th className={alternateClass}>{endingStock == null ? '-' : `${fmtNum(endingStock)} mts`}</th><th className={alternateClass}>{events.length} vessel{events.length === 1 ? '' : 's'} · {fmtNum(quantity)} mts</th></React.Fragment>;
                    })}</tr>
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        ) : <div className="vc-empty-month">No scheduled vessels for {factory.label} between {rangeLabel}.</div>}
      </div>
    </section>
  );
}

export default function VesselCalendar() {
  const [data, setData] = useState({ factories: [], dateRange: {}, updatedAt: null });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [factoryId, setFactoryId] = useState('eup-bontang');
  const [showAllFactories, setShowAllFactories] = useState(false);
  const [selectedDate, setSelectedDate] = useState(() => isoDate(new Date()));
  const [selectedEvent, setSelectedEvent] = useState(null);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setRefreshing(true);
    try {
      const response = await api.get('/sheets/vessel-calendar');
      setData(response.data);
      setError('');
    } catch (loadError) {
      setError(loadError.response?.data?.error || 'Failed to load Vessel Calendar');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load({ silent: true }); }, [load]);
  useDataRefresh({ databases: ['DB6', 'DB9'], resources: ['vessel-calendar'], onRefresh: () => load({ silent: true }), fallbackMs: 15000 });

  const displayMonths = useMemo(() => monthsBetween(data.dateRange?.start, data.dateRange?.end), [data.dateRange]);
  const days = useMemo(() => displayMonths.flatMap(item => monthDays(item)), [displayMonths]);
  const rangeStart = days.length ? isoDate(days[0]) : '';
  const rangeEnd = days.length ? isoDate(days[days.length - 1]) : '';
  const factoryViews = useMemo(() => data.factories.map(item => buildFactoryView(item, displayMonths)), [data.factories, displayMonths]);
  const activeView = factoryViews.find(item => item.factory.id === factoryId) || factoryViews[0] || null;
  const factory = activeView?.factory || null;
  const today = isoDate(new Date());

  useEffect(() => {
    if (!data.factories.length) return;
    if (!data.factories.some(item => item.id === factoryId)) setFactoryId(data.factories[0].id);
  }, [data.factories, factoryId]);

  const rangeLabel = displayMonths.length === 1
    ? formatMonth(displayMonths[0])
    : `${formatMonth(displayMonths[0])} - ${formatMonth(displayMonths[displayMonths.length - 1])}`;

  const goToday = () => {
    const date = isoDate(new Date());
    setSelectedDate(date);
    window.requestAnimationFrame(() => document.querySelector(`[data-vc-date="${date}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };

  const chooseFactory = id => {
    setFactoryId(id);
    setShowAllFactories(false);
    setSelectedEvent(null);
  };

  if (loading && !data.factories.length) return <div className="vc-state">Loading Vessel Calendar...</div>;

  return (
    <div className="vessel-calendar-page">
      <header className="vc-page-header">
        <div><h2>Vessel Calendar</h2><p>Updated {formatUpdated(data.updatedAt)}</p></div>
        <div className="vc-month-controls">
          <strong>{rangeLabel}</strong>
          <button type="button" className="vc-command-button" onClick={goToday}>Today</button>
          <button type="button" className="vc-icon-button" onClick={() => load()} disabled={refreshing} title="Refresh" aria-label="Refresh Vessel Calendar"><RefreshIcon /></button>
        </div>
      </header>

      {error ? <div className="vc-error">{error}</div> : null}

      <nav className="vc-factory-tabs" aria-label="Factories">
        <button type="button" className={showAllFactories ? 'is-active' : ''} onClick={() => { setShowAllFactories(true); setSelectedEvent(null); }}><span>All Factories</span><b>4</b></button>
        {data.factories.map(item => {
          const count = item.vessels.filter(vessel => vessel.scheduleDate >= rangeStart && vessel.scheduleDate <= rangeEnd).length;
          return <button type="button" key={item.id} className={!showAllFactories && item.id === factory?.id ? 'is-active' : ''} onClick={() => chooseFactory(item.id)}><span>{item.label}</span><b>{count}</b></button>;
        })}
      </nav>

      {factoryViews.length ? (
        <>
          <div className="vc-legend"><span><i className="is-vessel" /> Colour identifies vessel</span><span><i className="is-eta" /> ETA</span><span><i className="is-cr" /> Cargo Readiness fallback</span><span><i className="is-closed" /> Closed vessel</span><span><i className="is-today" /> Today</span></div>

          {showAllFactories ? (
            <div className="vc-all-grid">
              {factoryViews.map(view => <FactoryCalendarPanel key={view.factory.id} view={view} displayMonths={displayMonths} rangeLabel={rangeLabel} today={today} selectedDate={selectedDate} onSelectDate={setSelectedDate} onSelectEvent={setSelectedEvent} compact />)}
            </div>
          ) : activeView ? <FactoryCalendarPanel view={activeView} displayMonths={displayMonths} rangeLabel={rangeLabel} today={today} selectedDate={selectedDate} onSelectDate={setSelectedDate} onSelectEvent={setSelectedEvent} /> : null}

          {!showAllFactories && activeView?.unscheduled.length ? (
            <section className="vc-unscheduled">
              <header><h3>Unscheduled</h3><span>{activeView.unscheduled.length}</span></header>
              <div>{activeView.unscheduled.map(event => <span key={event.id} className={event.isClosed ? 'is-closed' : ''}><b>{event.vessel}</b> · {event.cargo} · {fmtNum(event.quantity)} mts</span>)}</div>
            </section>
          ) : null}
        </>
      ) : <div className="vc-state">No factory calendar data is available.</div>}

      {selectedEvent ? <VesselDetail {...selectedEvent} onClose={() => setSelectedEvent(null)} /> : null}
    </div>
  );
}
