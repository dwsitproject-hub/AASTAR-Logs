import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../services/api';
import useDataRefresh from '../../services/useDataRefresh';
import DemurrageRecordCard from './DemurrageRecordCard';
import { DemurrageFilters } from './DemurrageFilters';
import './DemurrageRecords.css';

const EMPTY_OPTIONS = { entities: [], cargos: [], loadports: [], statuses: [] };
const EMPTY_FILTERS = { entities: [], cargos: [], loadports: [], statuses: [] };

function keyFor(record) {
  return `${record.row}:${record.vslId}`;
}

function includesAny(values, selected, optionCount) {
  if (selected.length === optionCount) return true;
  return values.some(value => selected.includes(value));
}

function includesValue(value, selected, optionCount) {
  return selected.length === optionCount || selected.includes(value);
}

function matchesSearch(record, query) {
  if (!query) return true;
  return [
    record.vessel, record.vslId, record.voyage, record.entity, record.charterer,
    record.status, record.ops, record.demurrageRecords, record.remarks,
    ...(record.cargos || []), ...(record.loadports || []), ...(record.shippers || []),
  ].join('|').toLowerCase().includes(query);
}

export default function DemurrageRecords() {
  const [payload, setPayload] = useState({ records: [], options: EMPTY_OPTIONS, updatedAt: null });
  const [editors, setEditors] = useState({});
  const editorsRef = useRef(editors);
  const filtersInitialized = useRef(false);
  const optionsRef = useRef(EMPTY_OPTIONS);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [settlement, setSettlement] = useState('outstanding');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [saveStates, setSaveStates] = useState({});

  useEffect(() => { editorsRef.current = editors; }, [editors]);

  const applyPayload = useCallback(next => {
    const nextOptions = next.options || EMPTY_OPTIONS;
    const previousOptions = optionsRef.current;
    setPayload(next);
    setEditors(previous => {
      const merged = {};
      for (const record of next.records || []) {
        const key = keyFor(record);
        const current = previous[key];
        merged[key] = current && (
          current.value !== current.baseline
          || current.status !== current.statusBaseline
          || current.show !== current.showBaseline
          || current.nil !== current.nilBaseline
        )
          ? current
          : {
              value: record.demurrageRecords || '',
              baseline: record.demurrageRecords || '',
              status: Boolean(record.demurrageStatus),
              statusBaseline: Boolean(record.demurrageStatus),
              show: Boolean(record.showDemurrage),
              showBaseline: Boolean(record.showDemurrage),
              nil: Boolean(record.nilDemurrage),
              nilBaseline: Boolean(record.nilDemurrage),
            };
      }
      return merged;
    });
    if (!filtersInitialized.current) {
      const grEntity = nextOptions.entities.find(entity => entity.toUpperCase() === 'GR');
      setFilters({
        entities: grEntity ? [grEntity] : [...nextOptions.entities],
        cargos: [...nextOptions.cargos],
        loadports: [...nextOptions.loadports],
        statuses: [...nextOptions.statuses],
      });
      filtersInitialized.current = true;
    } else {
      setFilters(current => {
        const reconcile = name => {
          const wasAll = current[name].length === previousOptions[name].length
            && previousOptions[name].every(value => current[name].includes(value));
          return wasAll
            ? [...nextOptions[name]]
            : current[name].filter(value => nextOptions[name].includes(value));
        };
        return {
          entities: reconcile('entities'),
          cargos: reconcile('cargos'),
          loadports: reconcile('loadports'),
          statuses: reconcile('statuses'),
        };
      });
    }
    optionsRef.current = nextOptions;
  }, []);

  const fetchRecords = useCallback(async ({ silent = false } = {}) => {
    if (silent) setRefreshing(true);
    try {
      const response = await api.get('/sheets/demurrage-records');
      applyPayload(response.data);
      setError('');
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Demurrage Records could not be loaded.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [applyPayload]);

  useEffect(() => { fetchRecords(); }, [fetchRecords]);
  useDataRefresh({
    databases: ['DB6'],
    resources: ['demurrage-records', 'vessel-update'],
    onRefresh: () => fetchRecords({ silent: true }),
  });

  const visibleRecords = useMemo(() => {
    const query = search.trim().toLowerCase();
    const options = payload.options || EMPTY_OPTIONS;
    return payload.records.filter(record =>
      includesValue(record.entity, filters.entities, options.entities.length) &&
      includesValue(record.status, filters.statuses, options.statuses.length) &&
      includesAny(record.cargos || [], filters.cargos, options.cargos.length) &&
      includesAny(record.loadports || [], filters.loadports, options.loadports.length) &&
      (settlement === 'all'
        || (settlement === 'completed' && (record.demurrageStatus || record.nilDemurrage))
        || (settlement === 'outstanding' && !record.demurrageStatus && !record.nilDemurrage)) &&
      matchesSearch(record, query)
    ).sort((left, right) => {
      const leftId = String(left.vslId || '').trim();
      const rightId = String(right.vslId || '').trim();
      if (!leftId && rightId) return 1;
      if (leftId && !rightId) return -1;
      return rightId.localeCompare(leftId, undefined, { numeric: true, sensitivity: 'base' });
    });
  }, [payload.records, filters, search, settlement]);

  const setFilter = (name, value) => setFilters(current => ({ ...current, [name]: value }));
  const setDraft = (record, value) => {
    const key = keyFor(record);
    setEditors(current => ({
      ...current,
      [key]: {
        value,
        baseline: current[key]?.baseline ?? record.demurrageRecords ?? '',
        status: current[key]?.status ?? Boolean(record.demurrageStatus),
        statusBaseline: current[key]?.statusBaseline ?? Boolean(record.demurrageStatus),
        show: current[key]?.show ?? Boolean(record.showDemurrage),
        showBaseline: current[key]?.showBaseline ?? Boolean(record.showDemurrage),
        nil: current[key]?.nil ?? Boolean(record.nilDemurrage),
        nilBaseline: current[key]?.nilBaseline ?? Boolean(record.nilDemurrage),
      },
    }));
    setSaveStates(current => ({ ...current, [key]: { saving: false, saved: false, error: '' } }));
  };

  const setStatusDraft = (record, status) => {
    const key = keyFor(record);
    setEditors(current => ({
      ...current,
      [key]: {
        value: current[key]?.value ?? record.demurrageRecords ?? '',
        baseline: current[key]?.baseline ?? record.demurrageRecords ?? '',
        status,
        statusBaseline: current[key]?.statusBaseline ?? Boolean(record.demurrageStatus),
        show: current[key]?.show ?? Boolean(record.showDemurrage),
        showBaseline: current[key]?.showBaseline ?? Boolean(record.showDemurrage),
        nil: current[key]?.nil ?? Boolean(record.nilDemurrage),
        nilBaseline: current[key]?.nilBaseline ?? Boolean(record.nilDemurrage),
      },
    }));
    setSaveStates(current => ({ ...current, [key]: { saving: false, saved: false, error: '' } }));
  };

  const setShowDraft = (record, show) => {
    const key = keyFor(record);
    setEditors(current => ({
      ...current,
      [key]: {
        value: current[key]?.value ?? record.demurrageRecords ?? '',
        baseline: current[key]?.baseline ?? record.demurrageRecords ?? '',
        status: current[key]?.status ?? Boolean(record.demurrageStatus),
        statusBaseline: current[key]?.statusBaseline ?? Boolean(record.demurrageStatus),
        show,
        showBaseline: current[key]?.showBaseline ?? Boolean(record.showDemurrage),
        nil: current[key]?.nil ?? Boolean(record.nilDemurrage),
        nilBaseline: current[key]?.nilBaseline ?? Boolean(record.nilDemurrage),
      },
    }));
    setSaveStates(current => ({ ...current, [key]: { saving: false, saved: false, error: '' } }));
  };

  const setNilDraft = (record, nil) => {
    const key = keyFor(record);
    setEditors(current => ({
      ...current,
      [key]: {
        value: current[key]?.value ?? record.demurrageRecords ?? '',
        baseline: current[key]?.baseline ?? record.demurrageRecords ?? '',
        status: current[key]?.status ?? Boolean(record.demurrageStatus),
        statusBaseline: current[key]?.statusBaseline ?? Boolean(record.demurrageStatus),
        show: current[key]?.show ?? Boolean(record.showDemurrage),
        showBaseline: current[key]?.showBaseline ?? Boolean(record.showDemurrage),
        nil,
        nilBaseline: current[key]?.nilBaseline ?? Boolean(record.nilDemurrage),
      },
    }));
    setSaveStates(current => ({ ...current, [key]: { saving: false, saved: false, error: '' } }));
  };

  const saveRecord = async record => {
    const key = keyFor(record);
    const editor = editorsRef.current[key];
    if (!editor || (
      editor.value === editor.baseline
      && editor.status === editor.statusBaseline
      && editor.show === editor.showBaseline
      && editor.nil === editor.nilBaseline
    )) return;
    setSaveStates(current => ({ ...current, [key]: { saving: true, saved: false, error: '' } }));
    try {
      const response = await api.post('/sheets/demurrage-records/save', {
        row: record.row,
        vslId: record.vslId,
        record: editor.value,
        expectedRecord: editor.baseline,
        demurrageStatus: editor.status,
        expectedDemurrageStatus: editor.statusBaseline,
        showDemurrage: editor.show,
        expectedShowDemurrage: editor.showBaseline,
        nilDemurrage: editor.nil,
        expectedNilDemurrage: editor.nilBaseline,
      });
      const savedValue = response.data.record ?? editor.value;
      const savedStatus = response.data.demurrageStatus ?? editor.status;
      const savedShow = response.data.showDemurrage ?? editor.show;
      const savedNil = response.data.nilDemurrage ?? editor.nil;
      setEditors(current => ({
        ...current,
        [key]: {
          value: savedValue,
          baseline: savedValue,
          status: savedStatus,
          statusBaseline: savedStatus,
          show: savedShow,
          showBaseline: savedShow,
          nil: savedNil,
          nilBaseline: savedNil,
        },
      }));
      setPayload(current => ({
        ...current,
        records: current.records.map(item => keyFor(item) === key
          ? { ...item, demurrageRecords: savedValue, demurrageStatus: savedStatus, showDemurrage: savedShow, nilDemurrage: savedNil }
          : item),
      }));
      setSaveStates(current => ({ ...current, [key]: { saving: false, saved: true, error: '' } }));
    } catch (requestError) {
      setSaveStates(current => ({
        ...current,
        [key]: {
          saving: false,
          saved: false,
          error: requestError.response?.data?.error || 'Record could not be saved.',
        },
      }));
    }
  };

  const updatedLabel = payload.updatedAt
    ? new Date(payload.updatedAt).toLocaleString('en-SG', { dateStyle: 'medium', timeStyle: 'short' })
    : 'Not available';

  return (
    <div className="demm-records-page">
      <section className="demm-sticky-header" aria-label="Demurrage Records controls">
        <div className="demm-page-heading">
          <div>
            <p>OPERATIONS</p>
            <h1>Demurrage Records</h1>
          </div>
          <div className="demm-page-status">
            <strong>{visibleRecords.length}</strong> of {payload.records.length} vessels
            <span>{refreshing ? 'Refreshing DB6...' : `Updated ${updatedLabel}`}</span>
          </div>
        </div>
        <DemurrageFilters
          search={search}
          onSearch={setSearch}
          options={payload.options || EMPTY_OPTIONS}
          filters={filters}
          onFilter={setFilter}
          settlement={settlement}
          onSettlement={setSettlement}
        />
      </section>

      {error ? (
        <div className="demm-page-error" role="alert">
          <span>{error}</span><button type="button" onClick={() => fetchRecords()}>Retry</button>
        </div>
      ) : null}

      {loading ? <div className="demm-page-state">Loading vessel records...</div> : null}
      {!loading && !error && visibleRecords.length === 0 ? (
        <div className="demm-page-state">No vessels match the selected filters.</div>
      ) : null}
      {!loading && visibleRecords.length ? (
        <div className="demm-card-grid">
          {visibleRecords.map(record => {
            const key = keyFor(record);
            return (
              <DemurrageRecordCard
                key={key}
                record={record}
                editor={editors[key] || {
                  value: record.demurrageRecords || '',
                  baseline: record.demurrageRecords || '',
                  status: Boolean(record.demurrageStatus),
                  statusBaseline: Boolean(record.demurrageStatus),
                  show: Boolean(record.showDemurrage),
                  showBaseline: Boolean(record.showDemurrage),
                  nil: Boolean(record.nilDemurrage),
                  nilBaseline: Boolean(record.nilDemurrage),
                }}
                saveState={saveStates[key] || { saving: false, saved: false, error: '' }}
                onChange={value => setDraft(record, value)}
                onStatusChange={status => setStatusDraft(record, status)}
                onShowChange={show => setShowDraft(record, show)}
                onNilChange={nil => setNilDraft(record, nil)}
                onSave={() => saveRecord(record)}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
