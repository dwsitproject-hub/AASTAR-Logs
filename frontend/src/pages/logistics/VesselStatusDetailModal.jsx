import React, { useEffect, useMemo, useRef } from 'react';
import './VesselStatusDetailModal.css';

function text(value, fallback = '-') {
  const output = value == null ? '' : String(value).trim();
  return output || fallback;
}

function canonical(value) {
  return text(value, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function fmtQty(value) {
  const quantity = Number(value);
  return Number.isFinite(quantity) && quantity !== 0
    ? quantity.toLocaleString('en-US', { maximumFractionDigits: 3 })
    : '-';
}

function dateTime(date, time) {
  const day = text(date, '');
  const clock = text(time, '');
  if (!day && !clock) return '-';
  return [day, clock].filter(Boolean).join(' ');
}

function uniqueContracts(rows, field) {
  const seen = new Set();
  return rows.flatMap(row => row[field] || []).filter(contract => {
    const key = text(contract.id || contract.contractNo || contract.ref, '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function DetailField({ label, value, wide = false }) {
  return (
    <div className={`vs-detail-field${wide ? ' is-wide' : ''}`}>
      <dt>{label}</dt>
      <dd>{text(value)}</dd>
    </div>
  );
}

function ContractList({ contracts, type, onHover }) {
  if (!contracts.length) return <div className="vs-detail-empty">No linked {type.toLowerCase()} contracts.</div>;
  return (
    <div className="vs-detail-contract-list">
      {contracts.map((contract, index) => {
        const period = [text(contract.periodStart, ''), text(contract.periodEnd, '')].filter(Boolean).join(' - ');
        const cargo = text(contract.cargo, '');
        const quantity = Number(String(contract.qty || '').replace(/,/g, ''));
        const quantityLabel = Number.isFinite(quantity) && quantity
          ? `${fmtQty(quantity)}${cargo ? ` ${cargo}` : ''}`
          : cargo || '-';
        return (
          <article
            key={contract.id || contract.contractNo || `${type}-${index}`}
            className={`vs-detail-contract${type === 'Sales' ? ' is-sale' : ''}`}
            tabIndex={0}
            onMouseEnter={event => {
              const rect = event.currentTarget.getBoundingClientRect();
              onHover({
                contract,
                type,
                anchor: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
              });
            }}
            onMouseLeave={() => onHover(null)}
            onFocus={event => {
              const rect = event.currentTarget.getBoundingClientRect();
              onHover({
                contract,
                type,
                anchor: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
              });
            }}
            onBlur={() => onHover(null)}
          >
            <div className="vs-detail-contract-topline">
              <span>{text(contract.counterparty)}</span>
              <span>{text(contract.contractNo || contract.ref)}</span>
            </div>
            <div className="vs-detail-contract-meta">
              {quantityLabel}
              {period ? ` | ${period}` : ''}
              {contract.loadport ? ` | ${contract.loadport}` : ''}
              {contract.pricing ? ` | Price ${contract.pricing}` : ''}
              {contract.broker ? ` | Broker ${contract.broker}` : ''}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function ContractHoverDetail({ contract, type, anchor }) {
  const popupWidth = 520;
  const popupHeight = 330;
  const gap = 12;
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
  let left = anchor.right + gap;
  let top = anchor.top;
  if (left + popupWidth > viewportWidth - 8) left = anchor.left - popupWidth - gap;
  if (top + popupHeight > viewportHeight - 8) top = viewportHeight - popupHeight - 8;
  left = Math.max(8, left);
  top = Math.max(8, top);

  const period = [text(contract.periodStart, ''), text(contract.periodEnd, '')].filter(Boolean).join(' - ');
  const quantity = Number(String(contract.qty || '').replace(/,/g, ''));
  const quantityLabel = Number.isFinite(quantity) && quantity
    ? `${fmtQty(quantity)}${contract.cargo ? ` ${contract.cargo}` : ''}`
    : text(contract.cargo, '');
  const price = [text(contract.pricing, ''), text(contract.pricingType, '')].filter(Boolean).join(' ');
  const fields = [
    ['Type', type],
    ['Contract no.', contract.contractNo || contract.ref],
    ['Counterparty', contract.counterparty],
    ['Cargo / Qty', quantityLabel],
    ['Tolerance', contract.tolerance],
    ['Shipment period', period],
    ['Payment', contract.payment],
    ['Price', price],
    ['Loadport', contract.loadport],
    ['Broker', contract.broker],
    ['Broker ref.', contract.brokerRef],
    ['Status', contract.status],
    ['VSL ID', contract.vslId],
    ['Partial', contract.isPartial ? 'Yes' : ''],
  ].filter(([, value]) => text(value, '') !== '');

  return (
    <aside
      className={`vs-contract-hover${type === 'Sales' ? ' is-sale' : ''}`}
      style={{ left, top, width: popupWidth, maxHeight: popupHeight }}
      aria-hidden="true"
    >
      <div className="vs-contract-hover-header">
        <div>
          <strong>{text(contract.contractNo || contract.ref)}</strong>
          <span>{text(contract.counterparty)}</span>
        </div>
        <span className="vs-contract-hover-type">{type}</span>
      </div>
      <div className="vs-contract-hover-grid">
        {fields.map(([label, value]) => (
          <div key={label} className="vs-contract-hover-field">
            <span>{label}</span>
            <strong>{String(value)}</strong>
          </div>
        ))}
      </div>
    </aside>
  );
}

export default function VesselStatusDetailModal({
  detail,
  contractRows = [],
  contractsLoading = false,
  contractsError = '',
  onClose,
}) {
  const closeRef = useRef(null);
  const [hoveredContract, setHoveredContract] = React.useState(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKeyDown = event => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const matchingRows = useMemo(() => {
    const portIds = new Set((detail.loadports || []).map(port => canonical(port.vslId)).filter(Boolean));
    const loadports = new Set((detail.loadports || []).map(port => canonical(port.port)).filter(Boolean));
    const vessel = canonical(detail.vessel);
    return contractRows.filter(row => {
      const rowVslId = canonical(row.vslId);
      if (rowVslId && portIds.has(rowVslId)) return true;
      return canonical(row.vessel) === vessel && loadports.has(canonical(row.loadport));
    });
  }, [contractRows, detail]);

  const purchases = useMemo(() => uniqueContracts(matchingRows, 'purchaseContracts'), [matchingRows]);
  const sales = useMemo(() => uniqueContracts(matchingRows, 'salesContracts'), [matchingRows]);
  const loadports = detail.loadports || [];
  const dischargePorts = detail.dischargePorts || [];
  const totalCargo = loadports.reduce((sum, port) => sum + (Number(port.quantity) || 0), 0);
  const status = text(detail.status, 'Open');
  const isClosed = status.toLowerCase() === 'closed';

  return (
    <div className="vs-detail-backdrop" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        className="vs-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vs-detail-title"
      >
        <header className="vs-detail-header">
          <div>
            <div className="vs-detail-eyebrow">Shipment details</div>
            <h2 id="vs-detail-title" className="vs-detail-title">{text(detail.vessel, 'TBN')}</h2>
            <div className="vs-detail-chips">
              <span className={`vs-detail-chip ${isClosed ? 'is-closed' : 'is-open'}`}>{status}</span>
              <span className="vs-detail-chip">{text(detail.vslId, 'No VSL ID')}</span>
              <span className="vs-detail-chip">{text(detail.charterer, 'No charterer')}</span>
              {detail.nominated && <span className="vs-detail-chip">Nominated</span>}
            </div>
          </div>
          <button ref={closeRef} type="button" className="vs-detail-close" onClick={onClose} aria-label="Close vessel details" title="Close">
            &times;
          </button>
        </header>

        <div className="vs-detail-summary">
          <div className="vs-detail-summary-item">
            <div className="vs-detail-summary-label">Load calls</div>
            <div className="vs-detail-summary-value">{loadports.length}</div>
          </div>
          <div className="vs-detail-summary-item">
            <div className="vs-detail-summary-label">Total cargo</div>
            <div className="vs-detail-summary-value">{fmtQty(totalCargo)} MT</div>
          </div>
          <div className="vs-detail-summary-item">
            <div className="vs-detail-summary-label">Discharge calls</div>
            <div className="vs-detail-summary-value">{dischargePorts.length}</div>
          </div>
          <div className="vs-detail-summary-item">
            <div className="vs-detail-summary-label">Linked contracts</div>
            <div className="vs-detail-summary-value">{contractsLoading ? 'Loading' : purchases.length + sales.length}</div>
          </div>
        </div>

        <section className="vs-detail-section" aria-labelledby="vessel-particulars-heading">
          <h3 id="vessel-particulars-heading">Vessel</h3>
          <dl className="vs-detail-fields">
            <DetailField label="Charterer" value={detail.charterer} />
            <DetailField label="Entity" value={detail.entity} />
            <DetailField label="Shipment Month" value={detail.month} />
            <DetailField label="Voyage" value={detail.voyage} />
            <DetailField label="IMO" value={detail.imo} />
            <DetailField label="MMSI" value={detail.mmsi} />
            <DetailField label="Operations" value={detail.ops} />
            <DetailField label="Allocation" value={detail.allocation} />
            <DetailField label="Latitude" value={detail.latitude} />
            <DetailField label="Longitude" value={detail.longitude} />
            <DetailField label="Contractual L/C" value={detail.contractualLc} />
            <DetailField label="Nominated" value={detail.nominated ? 'Yes' : 'No'} />
          </dl>
        </section>

        <section className="vs-detail-section" aria-labelledby="laytime-heading">
          <h3 id="laytime-heading">Laytime &amp; commercial</h3>
          <dl className="vs-detail-fields">
            <DetailField label="Demurrage Rate" value={detail.demmurage} />
            <DetailField label="Load Rate" value={detail.laytimeRate} />
            <DetailField label="Laytime Starts" value={detail.laytimeStarts} />
            <DetailField label="Vessel Status" value={detail.status} />
            <DetailField label="Remarks" value={detail.remarks} wide />
          </dl>
        </section>

        <section className="vs-detail-section" aria-labelledby="route-heading">
          <h3 id="route-heading">Ports &amp; schedule</h3>
          <div className="vs-detail-table-wrap">
            <table className="vs-detail-table">
              <colgroup>
                <col style={{ width: 72 }} />
                <col style={{ width: 150 }} />
                <col style={{ width: 92 }} />
                <col style={{ width: 128 }} />
                <col style={{ width: 95 }} />
                <col style={{ width: 105 }} />
                <col style={{ width: 105 }} />
                <col style={{ width: 105 }} />
                <col style={{ width: 105 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Call</th>
                  <th>Port</th>
                  <th>Shipper</th>
                  <th>Cargo / Qty</th>
                  <th>Laycan / CR</th>
                  <th>ETA</th>
                  <th>ETB</th>
                  <th>ETC</th>
                  <th>Status / Price</th>
                </tr>
              </thead>
              <tbody>
                {(detail.ports || []).map(port => (
                  <tr key={`${port.slot}-${port.vslId || port.port}`}>
                    <td>
                      <span className={`vs-detail-movement${port.isDischarge ? ' is-discharge' : ''}`}>{port.movement}</span>
                      <span className="vs-detail-port-id">Port {port.slot}</span>
                    </td>
                    <td>
                      <span className="vs-detail-port-name">{text(port.port)}</span>
                      <span className="vs-detail-port-id">{text(port.vslId)}</span>
                    </td>
                    <td>{text(port.shipper)}</td>
                    <td>{port.quantity ? `${fmtQty(port.quantity)} ${text(port.cargo, '')}` : text(port.cargo)}</td>
                    <td className="vs-detail-date">
                      {text(port.laycan)}
                      <span className="vs-detail-port-id">CR {text(port.cargoReadiness)}</span>
                    </td>
                    <td className="vs-detail-date">{dateTime(port.eta, port.etaTime)}</td>
                    <td className="vs-detail-date">{dateTime(port.etb, port.etbTime)}</td>
                    <td className="vs-detail-date">{dateTime(port.etc, port.etcTime)}</td>
                    <td>
                      {text(port.status)}
                      <span className="vs-detail-port-id">{text(port.latestPrice, 'No price')}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="vs-detail-section" aria-labelledby="contracts-heading">
          <h3 id="contracts-heading">Matched contracts</h3>
          {contractsError && <div className="vs-detail-empty">{contractsError}</div>}
          {!contractsError && contractsLoading && <div className="vs-detail-empty">Loading linked contract details...</div>}
          {!contractsError && !contractsLoading && (
            <div className="vs-detail-contract-grid">
              <div className="vs-detail-contract-column">
                <div className="vs-detail-contract-heading">
                  <span>Purchase</span>
                  <span className="vs-detail-contract-count">{purchases.length}</span>
                </div>
                <ContractList contracts={purchases} type="Purchase" onHover={setHoveredContract} />
              </div>
              <div className="vs-detail-contract-column">
                <div className="vs-detail-contract-heading">
                  <span>Sales</span>
                  <span className="vs-detail-contract-count">{sales.length}</span>
                </div>
                <ContractList contracts={sales} type="Sales" onHover={setHoveredContract} />
              </div>
            </div>
          )}
        </section>
      </section>
      {hoveredContract && <ContractHoverDetail {...hoveredContract} />}
    </div>
  );
}
