import React, { useEffect, useRef, useState } from 'react';

export function MultiSelectFilter({ label, options, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    const closeOutside = event => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = event => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  const toggle = option => {
    onChange(selected.includes(option)
      ? selected.filter(value => value !== option)
      : [...selected, option]);
  };
  const summary = selected.length === options.length
    ? 'All'
    : selected.length === 0
      ? 'None'
      : `${selected.length} selected`;

  return (
    <div className="demm-filter" ref={rootRef}>
      <span className="demm-filter-label">{label}</span>
      <button
        type="button"
        className="demm-filter-trigger"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span>{summary}</span><span className="demm-filter-chevron" aria-hidden="true">{open ? '▲' : '▼'}</span>
      </button>
      {open ? (
        <div className="demm-filter-menu">
          <div className="demm-filter-actions">
            <button type="button" onClick={() => onChange([...options])}>Select all</button>
            <button type="button" onClick={() => onChange([])}>Clear</button>
          </div>
          <div className="demm-filter-options">
            {options.map(option => (
              <label className={selected.includes(option) ? 'is-selected' : ''} key={option}>
                <input
                  type="checkbox"
                  checked={selected.includes(option)}
                  onChange={() => toggle(option)}
                />
                <span>{option}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function DemurrageFilters({ search, onSearch, options, filters, onFilter, settlement, onSettlement }) {
  return (
    <div className="demm-controls">
      <label className="demm-search">
        <span className="demm-filter-label">Search</span>
        <input
          type="search"
          value={search}
          onChange={event => onSearch(event.target.value)}
          placeholder="Vessel, VSL ID, cargo, port, shipper or record"
        />
      </label>
      <MultiSelectFilter label="Entity" options={options.entities} selected={filters.entities} onChange={value => onFilter('entities', value)} />
      <MultiSelectFilter label="Cargo" options={options.cargos} selected={filters.cargos} onChange={value => onFilter('cargos', value)} />
      <MultiSelectFilter label="Loadport" options={options.loadports} selected={filters.loadports} onChange={value => onFilter('loadports', value)} />
      <MultiSelectFilter label="Status" options={options.statuses} selected={filters.statuses} onChange={value => onFilter('statuses', value)} />
      <label className="demm-filter demm-settlement-filter">
        <span className="demm-filter-label">Settlement</span>
        <select value={settlement} onChange={event => onSettlement(event.target.value)}>
          <option value="outstanding">Outstanding</option>
          <option value="completed">Completed</option>
          <option value="all">All</option>
        </select>
      </label>
    </div>
  );
}
