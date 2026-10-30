import React, { useEffect } from 'react';
import api from '../services/api';
import './decoy.css';

const archiveEvents = [
  ['06:42', 'Bridgewatch market ledger indexed', 'Complete'],
  ['06:18', 'Royal continent route archive reconciled', 'Complete'],
  ['05:55', 'Guild registry mirror checked', 'Complete'],
  ['05:20', 'Outlands field notes queued for review', 'Pending'],
  ['04:47', 'Artifact catalogue snapshot stored', 'Complete'],
];

export default function DecoyPage() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Royal Continent Archive';
    api.post('/auth/page-visit', { page: 'dummy', referrer: document.referrer }).catch(() => {});
    return () => { document.title = previousTitle; };
  }, []);

  return (
    <main className="atlas-page">
      <header className="atlas-header">
        <div className="atlas-mark" aria-hidden="true">RC</div>
        <div>
          <p className="atlas-kicker">The Royal Continent Archive</p>
          <h1>Albion Online Field Guide</h1>
        </div>
        <label className="atlas-search">
          <span>Search archive</span>
          <input type="search" placeholder="Search locations, factions, items..." />
        </label>
      </header>

      <div className="atlas-layout">
        <aside className="atlas-sidebar" aria-label="Archive sections">
          <p className="atlas-side-title">Explore</p>
          <a href="#overview">Overview</a>
          <a href="#regions">Regions</a>
          <a href="#cities">Royal cities</a>
          <a href="#ledger">Archive ledger</a>
          <p className="atlas-side-title atlas-side-spaced">Contribute</p>
          <a href="#notes">Field notes</a>
          <a href="#sources">Source index</a>
        </aside>

        <article className="atlas-article">
          <nav className="atlas-breadcrumb">Archive / Worlds / Albion</nav>
          <section id="overview">
            <p className="atlas-overline">World reference</p>
            <h2>Albion and the Royal Continent</h2>
            <p className="atlas-lead">
              Albion is a player-driven fantasy world shaped by gathering, crafting, trade, territorial conflict,
              and travel between its royal cities. This field guide collects neutral reference notes about its
              regions, roads, markets, and settlements.
            </p>
            <div className="atlas-notice">
              This community archive is being reorganized. Some entries may show older catalogue timestamps.
            </div>
          </section>

          <section id="regions" className="atlas-section">
            <h3>Regions at a glance</h3>
            <div className="atlas-region-grid">
              <div><strong>Forest</strong><span>Wooded routes, hide resources, and eastern settlements.</span></div>
              <div><strong>Highland</strong><span>Rock resources and roads surrounding Martlock.</span></div>
              <div><strong>Steppe</strong><span>Open plains associated with Bridgewatch trade routes.</span></div>
              <div><strong>Mountain</strong><span>Ore-rich northern terrain connected to Fort Sterling.</span></div>
            </div>
          </section>

          <section id="ledger" className="atlas-section">
            <div className="atlas-section-heading">
              <div>
                <p className="atlas-overline">System archive</p>
                <h3>Recent catalogue activity</h3>
              </div>
              <span className="atlas-status">Archive online</span>
            </div>
            <div className="atlas-ledger" role="table" aria-label="Recent archive activity">
              {archiveEvents.map(([time, event, state]) => (
                <div className="atlas-ledger-row" role="row" key={`${time}-${event}`}>
                  <time role="cell">{time}</time>
                  <span role="cell">{event}</span>
                  <span role="cell" className={state === 'Complete' ? 'is-complete' : 'is-pending'}>{state}</span>
                </div>
              ))}
            </div>
          </section>
        </article>

        <aside className="atlas-facts" aria-label="World facts">
          <div className="atlas-facts-title">Albion</div>
          <dl>
            <dt>Genre</dt><dd>Fantasy sandbox</dd>
            <dt>World</dt><dd>Persistent online realm</dd>
            <dt>Economy</dt><dd>Player driven</dd>
            <dt>Regions</dt><dd>Royal Continent, Outlands</dd>
            <dt>Archive revision</dt><dd>RC-2026.08</dd>
          </dl>
        </aside>
      </div>
      <footer className="atlas-footer">Royal Continent community reference archive</footer>
    </main>
  );
}
