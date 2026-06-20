// ==UserScript==
// @name        NexStar Planner
// @namespace   nexuslegacy-tools
// @description Fleet, research, and building cost planner. Pulls live data from the game API — no setup required.
// @version     0.5.0
// @match       https://*.nexuslegacy.space/*
// @grant       GM_getValue
// @grant       GM_setValue
// @run-at      document-idle
// @noframes
// @updateURL   https://raw.githubusercontent.com/Khazrihl/NexStar/main/planner/nexstar-planner.user.js
// @downloadURL https://raw.githubusercontent.com/Khazrihl/NexStar/main/planner/nexstar-planner.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────
  const TOOL_NAME = 'NexStar Planner';
  const VERSION   = '0.5.0';

  const RES_KEYS = ['ore', 'silicates', 'hydrogen', 'alloys',
    'cryoIce', 'plasmaCore', 'bioExtract', 'darkMatter', 'quantumDust', 'antimatter'];

  const RES_LABEL = {
    ore: 'Ore', silicates: 'Sil', hydrogen: 'H₂', alloys: 'Alloys',
    cryoIce: 'Ice', plasmaCore: 'Plasma', bioExtract: 'Bio',
    darkMatter: 'Dark', quantumDust: 'Dust', antimatter: 'AM',
  };

  // API rare cost keys → planet field names
  const RARE_MAP = {
    cryo_ice: 'cryoIce', plasma_core: 'plasmaCore', bio_extract: 'bioExtract',
    dark_matter: 'darkMatter', quantum_dust: 'quantumDust', antimatter: 'antimatter',
  };

  // ── State ──────────────────────────────────────────────────────────────────
  let state = {
    tab: 'ships',           // 'ships' | 'research' | 'buildings' | 'summary'
    planet: null,           // current planet data
    ships: null,            // shipyard response
    research: null,         // research response
    queue: [],              // [{type, key, name, qty, cost, time, label}]
    loading: false,
    error: null,
    planFlash: false,       // brief flash on Plan badge when item added
    // filters
    shipFilter: 'all',      // 'all' | 'available' | 'locked'
    resFilter: 'all',       // 'all' | 'available' | 'in_progress' | 'completed'
    resBranch: 'all',       // 'all' | 'economy' | 'military' | 'science'
    buildFilter: 'all',     // 'all' | 'upgradeable'
    // search
    shipSearch: '',
    resSearch: '',
    buildSearch: '',
    // collapsed groups — key is group label, resets on tab switch
    collapsed: {},
  };

  // ── Flash helper ───────────────────────────────────────────────────────────
  let _clearConfirm = false;

  function flashBtn(id) {
    // Brief green flash on a button by id — works even after innerHTML rewrite
    // because we call it AFTER render, targeting the live DOM
    setTimeout(() => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.add('nxp-btn-flash');
      setTimeout(() => el && el.classList.remove('nxp-btn-flash'), 700);
    }, 0);
  }

  // ── Persistence ────────────────────────────────────────────────────────────
  function queueKey() {
    const name = currentPlanetName() || 'default';
    return `plannerQueue_${name}`;
  }
  function saveQueue() {
    try { GM_setValue(queueKey(), JSON.stringify(state.queue)); } catch (e) { /* */ }
  }
  function loadQueue() {
    try { const q = GM_getValue(queueKey(), '[]'); state.queue = JSON.parse(q) || []; } catch (e) { state.queue = []; }
  }
  loadQueue();

  // ── API ────────────────────────────────────────────────────────────────────
  const gFetch = (path) =>
    fetch(path, { credentials: 'include', headers: { accept: 'application/json' } })
      .then(r => r.ok ? r.json() : null).catch(() => null);

  function currentPlanetId() {
    // Try to extract from the page URL or planet switcher data
    const m = location.href.match(/planets?[=/](\d+)/);
    if (m) return +m[1];
    // Fallback: scrape planet switcher hidden id if present
    const el = document.querySelector('[data-planet-id]');
    return el ? +el.dataset.planetId : null;
  }

  function currentPlanetName() {
    const el = document.querySelector('.planet-switcher .ps-name');
    return el ? el.textContent.trim() : '';
  }

  async function fetchAll() {
    state.loading = true;
    state.error = null;
    render();

    // Try to resolve planet id from /api/auth/me if URL method fails
    let pid = currentPlanetId();
    if (!pid) {
      const me = await gFetch('/api/auth/me');
      if (me && me.planets && me.planets.length) {
        const pname = currentPlanetName();
        const p = me.planets.find(x => x.name === pname) || me.planets[0];
        pid = p && p.id;
      }
    }

    if (!pid) {
      state.error = 'Could not resolve planet ID. Open a colony page first.';
      state.loading = false;
      render();
      return;
    }

    const [planetData, shipData, resData] = await Promise.all([
      gFetch(`/api/planets/${pid}`),
      gFetch(`/api/planets/${pid}/shipyard`),
      gFetch('/api/research'),
    ]);

    state.planet  = planetData  || null;
    state.ships   = shipData    || null;
    state.research = resData    || null;
    state.loading = false;

    if (!state.planet) state.error = 'Failed to load planet data.';
    render();
  }

  // ── Cost helpers ───────────────────────────────────────────────────────────
  function shipCost(ship, qty = 1) {
    const c = {};
    if (ship.costOre)       c.ore       = ship.costOre       * qty;
    if (ship.costSilicates) c.silicates = ship.costSilicates * qty;
    if (ship.costHydrogen)  c.hydrogen  = ship.costHydrogen  * qty;
    if (ship.costAlloys)    c.alloys    = ship.costAlloys     * qty;
    for (const [k, v] of Object.entries(ship.rareCosts || {})) {
      const field = RARE_MAP[k] || k;
      if (v) c[field] = (c[field] || 0) + v * qty;
    }
    return c;
  }

  function researchCost(tech) {
    // Use nextCost* fields (cost of next level)
    const c = {};
    if (tech.nextCostOre)       c.ore       = tech.nextCostOre;
    if (tech.nextCostSilicates) c.silicates = tech.nextCostSilicates;
    if (tech.nextCostHydrogen)  c.hydrogen  = tech.nextCostHydrogen;
    if (tech.nextCostAlloys)    c.alloys    = tech.nextCostAlloys;
    for (const [k, v] of Object.entries(tech.nextRareCosts || {})) {
      const field = RARE_MAP[k] || k;
      if (v) c[field] = (c[field] || 0) + v;
    }
    return c;
  }

  function buildingCost(building) {
    const def = building.definition;
    if (!def) return {};
    const n  = building.level + 1; // target level
    const sw = def.costDoubleAfter > 0 ? def.costDoubleAfter : 10;
    const cf = def.costFactor      || 1;
    const hf = def.highLevelFactor || cf;

    let factor;
    if (n <= sw) {
      factor = Math.pow(cf, n - 1);
    } else {
      factor = Math.pow(cf, sw - 1) * Math.pow(hf, n - sw);
    }

    const c = {};
    if (def.baseCostOre)       c.ore       = Math.round(def.baseCostOre       * factor);
    if (def.baseCostSilicates) c.silicates = Math.round(def.baseCostSilicates * factor);
    if (def.baseCostHydrogen)  c.hydrogen  = Math.round(def.baseCostHydrogen  * factor);
    if (def.baseCostAlloys)    c.alloys    = Math.round(def.baseCostAlloys    * factor);
    return c;
  }

  function totalQueueCost() {
    const total = {};
    for (const item of state.queue) {
      for (const [k, v] of Object.entries(item.cost)) {
        total[k] = (total[k] || 0) + v;
      }
    }
    return total;
  }

  function stockpile() {
    const p = state.planet && state.planet.planet;
    if (!p) return {};
    return {
      ore: p.ore || 0, silicates: p.silicates || 0,
      hydrogen: p.hydrogen || 0, alloys: p.alloys || 0,
      cryoIce: p.cryoIce || 0, plasmaCore: p.plasmaCore || 0,
      bioExtract: p.bioExtract || 0, darkMatter: p.darkMatter || 0,
      quantumDust: p.quantumDust || 0, antimatter: p.antimatter || 0,
    };
  }

  function productionRates() {
    const p = state.planet && state.planet.planet;
    if (!p) return {};
    return {
      ore: p.oreRate || 0, silicates: p.silicatesRate || 0,
      hydrogen: p.hydrogenRate || 0, alloys: p.alloysRate || 0,
      cryoIce: p.cryoIceRate || 0, plasmaCore: p.plasmaCoreRate || 0,
      bioExtract: p.bioExtractRate || 0, darkMatter: p.darkMatterRate || 0,
      quantumDust: p.quantumDustRate || 0, antimatter: p.antimatterRate || 0,
    };
  }

  // Returns hours to cover the gap, or null if already covered
  function timeToGoal(cost) {
    const stock = stockpile();
    const rates = productionRates();
    let maxHours = 0;
    let hasGap = false;
    for (const [k, needed] of Object.entries(cost)) {
      const have = stock[k] || 0;
      const gap  = needed - have;
      if (gap <= 0) continue;
      hasGap = true;
      const rate = rates[k] || 0;
      if (rate <= 0) return Infinity;
      maxHours = Math.max(maxHours, gap / rate);
    }
    return hasGap ? maxHours : 0;
  }

  // ── Formatting ─────────────────────────────────────────────────────────────
  function fmtNum(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return Math.round(n).toLocaleString();
  }

  function fmtTime(seconds) {
    if (!seconds || seconds === Infinity) return '∞';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 24) return `${Math.round(h/24)}d`;
    if (h > 0)  return `${h}h ${m}m`;
    return `${m}m`;
  }

  function fmtHours(hours) {
    if (hours === Infinity) return '∞ (no production)';
    if (hours === 0) return 'Ready now';
    return fmtTime(hours * 3600);
  }

  // ── Queue helpers ──────────────────────────────────────────────────────────
  function addToQueue(item) {
    state.queue.push(item);
    saveQueue();
    // Flash the Plan badge briefly instead of switching tabs
    state.planFlash = true;
    render();
    setTimeout(() => { state.planFlash = false; render(); }, 800);
  }

  function removeFromQueue(idx) {
    state.queue.splice(idx, 1);
    saveQueue();
    render();
  }

  function clearQueue() {
    state.queue = [];
    saveQueue();
    render();
  }

  // ── DOM ────────────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'nxp-panel';
  panel.style.display = 'none';
  document.body.appendChild(panel);

  const toggleBtn = document.createElement('div');
  toggleBtn.id = 'nxp-toggle';
  toggleBtn.title = 'NexStar Planner';
  toggleBtn.textContent = '📋 Plan';
  toggleBtn.onclick = () => {
    const open = panel.style.display !== 'none';
    if (open) {
      panel.style.display = 'none';
    } else {
      panel.style.display = 'flex';
      if (!state.planet && !state.loading) fetchAll();
    }
  };

  // Inject into topbar-right, re-inject if React removes it
  function injectToggle() {
    const right = document.querySelector('.topbar-right');
    if (right && !toggleBtn.isConnected) {
      right.insertBefore(toggleBtn, right.firstChild);
    }
  }
  const waitTopbar = setInterval(() => {
    if (document.querySelector('.topbar-right')) {
      clearInterval(waitTopbar);
      injectToggle();
      new MutationObserver(injectToggle)
        .observe(document.querySelector('.topbar-right'), { childList: true });
    }
  }, 500);

  // ── Styles ─────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    /* NexStar Planner — tactical overlay */
    #nxp-toggle {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 0 10px;
      height: 100%;
      cursor: pointer;
      font: 600 12px/1 'Consolas', 'Courier New', monospace;
      color: #e8a838;
      border-left: 1px solid rgba(232,168,56,0.2);
      border-right: 1px solid rgba(232,168,56,0.2);
      letter-spacing: 0.06em;
      transition: background 0.12s;
      white-space: nowrap;
    }
    #nxp-toggle:hover {
      background: rgba(232,168,56,0.1);
    }

    #nxp-panel {
      position: fixed;
      top: 48px;
      right: 8px;
      width: 520px;
      max-height: calc(100vh - 64px);
      z-index: 99997;
      background: #0a0d14;
      border: 1px solid #1e2535;
      border-radius: 0 0 10px 10px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.7), 0 0 0 1px rgba(232,168,56,0.08);
      display: flex;
      flex-direction: column;
      font-family: 'Consolas', 'Courier New', monospace;
      font-size: 12px;
      color: #b8c4d4;
      overflow: hidden;
    }

    /* Header */
    #nxp-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid #1e2535;
      background: #0d1018;
      flex-shrink: 0;
    }
    #nxp-header .nxp-title {
      font-size: 11px;
      font-weight: 700;
      color: #e8a838;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      flex: 1;
    }
    #nxp-header .nxp-ver {
      font-size: 9px;
      color: #3a4a5a;
      letter-spacing: 0.06em;
      margin-right: 4px;
    }
      font-size: 10px;
      color: #5a6a7a;
      letter-spacing: 0.06em;
    }
    #nxp-header .nxp-refresh {
      cursor: pointer;
      color: #5a6a7a;
      font-size: 14px;
      padding: 0 4px;
      transition: color 0.1s;
    }
    #nxp-header .nxp-refresh:hover { color: #e8a838; }
    #nxp-header .nxp-close {
      cursor: pointer;
      color: #5a6a7a;
      font-size: 16px;
      padding: 0 4px;
      line-height: 1;
      transition: color 0.1s;
    }
    #nxp-header .nxp-close:hover { color: #f87171; }

    /* Tabs */
    #nxp-tabs {
      display: flex;
      border-bottom: 1px solid #1e2535;
      flex-shrink: 0;
      background: #0d1018;
    }
    .nxp-tab {
      flex: 1;
      padding: 8px 4px;
      text-align: center;
      cursor: pointer;
      font-size: 10px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: #3a4a5a;
      border-bottom: 2px solid transparent;
      transition: color 0.1s, border-color 0.1s;
      position: relative;
    }
    .nxp-tab:hover { color: #7a9ab4; }
    .nxp-tab.active {
      color: #e8a838;
      border-bottom-color: #e8a838;
    }
    .nxp-tab .nxp-badge {
      display: inline-block;
      background: #e8a838;
      color: #0a0d14;
      border-radius: 8px;
      font-size: 9px;
      font-weight: 700;
      padding: 0 4px;
      margin-left: 4px;
      vertical-align: middle;
      transition: background 0.3s, transform 0.3s;
    }
    .nxp-tab .nxp-badge.flash {
      background: #4ade80;
      transform: scale(1.25);
    }

    /* Search bar */
    .nxp-search-bar {
      padding: 6px 10px 2px;
      border-bottom: 1px solid #111620;
      position: relative;
    }
    .nxp-search-input {
      width: 100%;
      background: #0d1018;
      border: 1px solid #1e2535;
      border-radius: 4px;
      color: #cdd8e8;
      font: inherit;
      font-size: 11px;
      padding: 4px 24px 4px 8px;
      box-sizing: border-box;
      outline: none;
      transition: border-color 0.1s;
    }
    .nxp-search-input:focus { border-color: #e8a838; }
    .nxp-search-input::placeholder { color: #3a4a5a; }
    .nxp-search-clear {
      position: absolute;
      right: 16px;
      top: 50%;
      transform: translateY(-40%);
      cursor: pointer;
      color: #3a4a5a;
      font-size: 14px;
      line-height: 1;
      padding: 2px 4px;
      transition: color 0.1s;
    }
    .nxp-search-clear:hover { color: #f87171; }

    /* Branch/category group headers */
    .nxp-group-hd {
      padding: 5px 14px 3px;
      font-size: 9px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #e8a838;
      background: rgba(232,168,56,0.05);
      border-top: 1px solid rgba(232,168,56,0.12);
      border-bottom: 1px solid #0e1118;
      margin-top: 2px;
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: background 0.1s;
    }
    .nxp-group-hd:first-child { margin-top: 0; border-top: none; }
    .nxp-group-hd:hover { background: rgba(232,168,56,0.1); }
    .nxp-group-hd .nxp-chevron {
      font-size: 8px;
      opacity: 0.6;
      transition: transform 0.15s;
      display: inline-block;
    }
    .nxp-group-hd.collapsed .nxp-chevron { transform: rotate(-90deg); }

    /* Body */
    #nxp-body {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 0;
    }
    #nxp-body::-webkit-scrollbar { width: 4px; }
    #nxp-body::-webkit-scrollbar-track { background: transparent; }
    #nxp-body::-webkit-scrollbar-thumb { background: #1e2535; border-radius: 2px; }

    /* Section headers */
    .nxp-section-hd {
      padding: 8px 14px 4px;
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #3a4a5a;
      border-bottom: 1px solid #111620;
    }

    /* Filter bar */
    .nxp-filter-bar {
      display: flex;
      gap: 4px;
      padding: 6px 14px;
      border-bottom: 1px solid #111620;
      flex-wrap: wrap;
    }
    .nxp-filter-btn {
      padding: 2px 8px;
      border-radius: 10px;
      border: 1px solid #1e2535;
      cursor: pointer;
      font-size: 10px;
      font-family: inherit;
      background: transparent;
      color: #5a6a7a;
      transition: all 0.1s;
    }
    .nxp-filter-btn:hover { border-color: #e8a838; color: #e8a838; }
    .nxp-filter-btn.active { background: rgba(232,168,56,0.12); border-color: #e8a838; color: #e8a838; }

    /* Ship / tech / building rows */
    .nxp-row {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 8px 14px;
      border-bottom: 1px solid #0e1118;
      transition: background 0.08s;
    }
    .nxp-row:hover { background: rgba(255,255,255,0.02); }
    .nxp-row.locked { opacity: 0.45; }

    .nxp-row-info { flex: 1; min-width: 0; }
    .nxp-row-name {
      font-size: 12px;
      color: #cdd8e8;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .nxp-row-name.available { color: #4ade80; }
    .nxp-row-name.in-progress { color: #38bdf8; }
    .nxp-row-name.locked { color: #5a6a7a; }
    .nxp-row-sub {
      font-size: 10px;
      color: #4a5a6a;
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Cost chips */
    .nxp-costs {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
      margin-top: 4px;
    }
    .nxp-cost-chip {
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 10px;
      background: rgba(255,255,255,0.05);
      color: #7a8a9a;
      white-space: nowrap;
    }
    .nxp-cost-chip.cant-afford { color: #f87171; background: rgba(248,113,113,0.08); }
    .nxp-cost-chip.can-afford  { color: #4ade80; background: rgba(74,222,128,0.06); }

    /* Qty input + add button */
    .nxp-row-actions {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 4px;
      flex-shrink: 0;
    }
    .nxp-qty-wrap {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .nxp-qty {
      width: 44px;
      background: #0d1018;
      border: 1px solid #1e2535;
      border-radius: 4px;
      color: #cdd8e8;
      font: inherit;
      font-size: 11px;
      text-align: center;
      padding: 2px 4px;
    }
    .nxp-qty:focus { outline: none; border-color: #e8a838; }
    .nxp-add-btn {
      padding: 3px 8px;
      border-radius: 4px;
      border: 1px solid rgba(232,168,56,0.4);
      background: rgba(232,168,56,0.08);
      color: #e8a838;
      cursor: pointer;
      font: inherit;
      font-size: 10px;
      white-space: nowrap;
      transition: all 0.1s;
    }
    .nxp-add-btn:hover { background: rgba(232,168,56,0.18); border-color: #e8a838; }
    .nxp-add-btn:disabled {
      opacity: 0.3;
      cursor: not-allowed;
      border-color: #1e2535;
      background: transparent;
      color: #5a6a7a;
    }

    /* Build time chip */
    .nxp-time-chip {
      font-size: 10px;
      color: #5a6a7a;
      padding: 1px 5px;
      border: 1px solid #1e2535;
      border-radius: 3px;
      white-space: nowrap;
    }

    /* Gap bars (signature element) */
    .nxp-gap-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 3px 14px;
    }
    .nxp-gap-label {
      width: 36px;
      font-size: 10px;
      color: #4a5a6a;
      text-align: right;
      flex-shrink: 0;
    }
    .nxp-gap-bar-wrap {
      flex: 1;
      height: 4px;
      background: #0e1118;
      border-radius: 2px;
      overflow: hidden;
    }
    .nxp-gap-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.3s ease;
    }
    .nxp-gap-fill.ok    { background: #4ade80; }
    .nxp-gap-fill.close { background: #e8a838; }
    .nxp-gap-fill.far   { background: #f87171; }
    .nxp-gap-amt {
      font-size: 10px;
      color: #4a5a6a;
      white-space: nowrap;
      min-width: 80px;
      text-align: right;
    }
    .nxp-gap-amt.ok   { color: #4ade80; }
    .nxp-gap-amt.short { color: #f87171; }

    /* Summary queue */
    .nxp-q-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 14px;
      border-bottom: 1px solid #0e1118;
    }
    .nxp-q-idx {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: #1a2030;
      border: 1px solid #2a3545;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      color: #5a6a7a;
      flex-shrink: 0;
    }
    .nxp-q-info { flex: 1; min-width: 0; }
    .nxp-q-name {
      font-size: 11px;
      color: #cdd8e8;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .nxp-q-sub { font-size: 10px; color: #4a5a6a; margin-top: 1px; }
    .nxp-q-remove {
      cursor: pointer;
      color: #3a4a5a;
      font-size: 14px;
      line-height: 1;
      padding: 0 4px;
      transition: color 0.1s;
      flex-shrink: 0;
    }
    .nxp-q-remove:hover { color: #f87171; }

    /* Summary totals */
    .nxp-total-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 4px;
      padding: 10px 14px;
    }
    .nxp-total-cell {
      background: #0d1018;
      border: 1px solid #1a2030;
      border-radius: 4px;
      padding: 5px 6px;
    }
    .nxp-total-label { font-size: 9px; color: #3a4a5a; letter-spacing: 0.08em; text-transform: uppercase; }
    .nxp-total-val   { font-size: 12px; color: #cdd8e8; margin-top: 1px; font-weight: 600; }
    .nxp-total-val.short { color: #f87171; }
    .nxp-total-val.ok    { color: #4ade80; }

    /* Time to goal banner */
    .nxp-ttg {
      margin: 4px 14px 8px;
      padding: 8px 12px;
      background: rgba(232,168,56,0.06);
      border: 1px solid rgba(232,168,56,0.2);
      border-radius: 6px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .nxp-ttg-label { font-size: 10px; color: #5a6a7a; letter-spacing: 0.08em; text-transform: uppercase; }
    .nxp-ttg-val   { font-size: 14px; color: #e8a838; font-weight: 700; }

    /* Misc */
    .nxp-empty {
      padding: 28px 14px;
      text-align: center;
      color: #3a4a5a;
      font-size: 11px;
      line-height: 1.7;
    }
    .nxp-loading {
      padding: 28px 14px;
      text-align: center;
      color: #5a6a7a;
      font-size: 11px;
    }
    .nxp-error {
      margin: 10px 14px;
      padding: 8px 10px;
      background: rgba(248,113,113,0.08);
      border: 1px solid rgba(248,113,113,0.25);
      border-radius: 5px;
      color: #f87171;
      font-size: 11px;
    }
    .nxp-clear-btn {
      display: block;
      margin: 8px 14px;
      padding: 5px;
      text-align: center;
      border: 1px solid #1e2535;
      border-radius: 4px;
      cursor: pointer;
      color: #5a6a7a;
      font: inherit;
      font-size: 10px;
      background: transparent;
      transition: all 0.1s;
    }
    .nxp-clear-btn:hover { border-color: #f87171; color: #f87171; }
    .nxp-clear-btn.nxp-clear-confirm {
      border-color: #f87171;
      color: #f87171;
      background: rgba(248,113,113,0.08);
      font-weight: 700;
    }
    .nxp-clear-btn.nxp-clear-confirm:hover {
      background: rgba(248,113,113,0.18);
    }

    /* Button flash animation */
    @keyframes nxp-flash-green {
      0%   { background: rgba(74,222,128,0.25); border-color: #4ade80; color: #4ade80; }
      100% { background: rgba(232,168,56,0.08); border-color: rgba(232,168,56,0.4); color: #e8a838; }
    }
    .nxp-btn-flash {
      animation: nxp-flash-green 0.7s ease-out forwards;
    }

    .nxp-divider {
      border: none;
      border-top: 1px solid #111620;
      margin: 0;
    }
    .nxp-status-row {
      padding: 4px 14px 6px;
      font-size: 10px;
      color: #3a5a4a;
    }
  `;
  document.head.appendChild(style);

  // ── Render helpers ─────────────────────────────────────────────────────────
  function costChips(cost, stock) {
    const chips = [];
    for (const k of RES_KEYS) {
      const v = cost[k];
      if (!v) continue;
      const have = stock[k] || 0;
      const cls  = have >= v ? 'can-afford' : 'cant-afford';
      chips.push(`<span class="nxp-cost-chip ${cls}">${RES_LABEL[k]} ${fmtNum(v)}</span>`);
    }
    return chips.length
      ? `<div class="nxp-costs">${chips.join('')}</div>`
      : '';
  }

  function gapBars(totalCost, stock, rates) {
    const rows = [];
    for (const k of RES_KEYS) {
      const needed = totalCost[k] || 0;
      if (!needed) continue;
      const have    = stock[k] || 0;
      const pct     = Math.min(100, (have / needed) * 100);
      const short   = needed - have;
      const cls     = pct >= 100 ? 'ok' : pct >= 50 ? 'close' : 'far';
      const amtCls  = pct >= 100 ? 'ok' : 'short';
      const amtTxt  = pct >= 100
        ? `✓ ${fmtNum(have)}`
        : `-${fmtNum(short)}`;
      rows.push(`
        <div class="nxp-gap-row">
          <div class="nxp-gap-label">${RES_LABEL[k]}</div>
          <div class="nxp-gap-bar-wrap">
            <div class="nxp-gap-fill ${cls}" style="width:${pct.toFixed(1)}%"></div>
          </div>
          <div class="nxp-gap-amt ${amtCls}">${amtTxt}</div>
        </div>`);
    }
    return rows.join('');
  }

  // ── Tab: Ships ─────────────────────────────────────────────────────────────
  function renderShips() {
    if (!state.ships) return '<div class="nxp-empty">No shipyard data.<br>Open a colony with a shipyard.</div>';
    const stock = stockpile();
    const mult  = state.ships.shipSpeedMult || 1;

    const filters = ['all', 'available', 'locked'];
    const filterBar = `
      <div class="nxp-search-bar">
        <input class="nxp-search-input" type="text" placeholder="Search ships…"
          data-search="ship" value="${state.shipSearch}">
        ${state.shipSearch ? `<span class="nxp-search-clear" data-action="clear-search" data-val="ship">×</span>` : ''}
      </div>
      <div class="nxp-filter-bar">
        ${filters.map(f => `<button class="nxp-filter-btn ${state.shipFilter === f ? 'active' : ''}"
          data-action="ship-filter" data-val="${f}">${f}</button>`).join('')}
      </div>`;

    const SIZE_ORDER  = { small: 0, medium: 1, large: 2, capital: 3 };
    const CLASS_ORDER = { recon: 0, combat: 1, special: 2, utility: 3 };

    let ships = state.ships.ships || [];
    if (state.shipFilter === 'available') ships = ships.filter(s => s.available);
    if (state.shipFilter === 'locked')    ships = ships.filter(s => !s.available);
    if (state.shipSearch) {
      const q = state.shipSearch.toLowerCase();
      ships = ships.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.shipClass.toLowerCase().includes(q) ||
        (s.shipyardName || '').toLowerCase().includes(q)
      );
    }

    // Sort by size then class
    ships = [...ships].sort((a, b) => {
      const sd = (SIZE_ORDER[a.shipSize] || 0) - (SIZE_ORDER[b.shipSize] || 0);
      if (sd !== 0) return sd;
      const cd = (CLASS_ORDER[a.shipClass] || 0) - (CLASS_ORDER[b.shipClass] || 0);
      if (cd !== 0) return cd;
      return a.sortOrder - b.sortOrder;
    });

    // Group by size + class for headers
    const html = [];
    let lastGroup = null;
    for (const ship of ships) {
      const group = `${ship.shipSize} · ${ship.shipClass}`;
      if (group !== lastGroup) {
        const collapsed = !!state.collapsed[group];
        html.push(`<div class="nxp-group-hd ${collapsed ? 'collapsed' : ''}"
          data-action="toggle-group" data-val="${group}">
          <span class="nxp-chevron">▾</span>${ship.shipSize} — ${ship.shipClass}
        </div>`);
        lastGroup = group;
      }
      if (state.collapsed[group]) continue;
      const cost     = shipCost(ship, 1);
      const buildSec = Math.round((ship.buildTime || 0) * mult);
      const canBuild = ship.available;
      const nameClass = canBuild ? 'available' : 'locked';
      const sub = [
        ship.shipyardName ? `${ship.shipyardName} Lv${ship.requiredShipyardLevel}` : '',
        !ship.researchMet ? '🔒 Research required' : '',
        !ship.shipyardMet ? `🔒 Shipyard Lv${ship.requiredShipyardLevel} required` : '',
      ].filter(Boolean).join(' · ');

      html.push(`
        <div class="nxp-row ${canBuild ? '' : 'locked'}">
          <div class="nxp-row-info">
            <div class="nxp-row-name ${nameClass}">${ship.name}</div>
            <div class="nxp-row-sub">${sub}</div>
            ${costChips(cost, stock)}
          </div>
          <div class="nxp-row-actions">
            <div class="nxp-qty-wrap">
              <input class="nxp-qty" type="number" min="1" max="999" value="1"
                id="nxp-sq-${ship.id}" onchange="this.value=Math.max(1,parseInt(this.value)||1)">
            </div>
            <div class="nxp-qty-wrap">
              <span class="nxp-time-chip">⏱ ${fmtTime(buildSec)}/ea</span>
              <button class="nxp-add-btn" id="nxp-add-ship-${ship.id}"
                data-action="add-ship" data-id="${ship.id}">+ Plan</button>
            </div>
          </div>
        </div>`);
    }

    return filterBar + (html.length
      ? html.join('')
      : '<div class="nxp-empty">No ships match this filter.</div>');
  }

  // ── Tab: Research ──────────────────────────────────────────────────────────
  function renderResearch() {
    if (!state.research) return '<div class="nxp-empty">No research data loaded.</div>';
    const stock = stockpile();
    const mult  = state.research.researchSpeedMult || 1;

    const branches = ['all', 'economy', 'military', 'science'];
    const statusFilters = ['all', 'available', 'in_progress', 'completed'];

    const filterBar = `
      <div class="nxp-search-bar">
        <input class="nxp-search-input" type="text" placeholder="Search research…"
          data-search="res" value="${state.resSearch}">
        ${state.resSearch ? `<span class="nxp-search-clear" data-action="clear-search" data-val="res">×</span>` : ''}
      </div>
      <div class="nxp-filter-bar">
        ${branches.map(b => `<button class="nxp-filter-btn ${state.resBranch === b ? 'active' : ''}"
          data-action="res-branch" data-val="${b}">${b}</button>`).join('')}
      </div>
      <div class="nxp-filter-bar" style="border-top:none;padding-top:2px">
        ${statusFilters.map(f => `<button class="nxp-filter-btn ${state.resFilter === f ? 'active' : ''}"
          data-action="res-filter" data-val="${f}">${f.replace('_',' ')}</button>`).join('')}
      </div>`;

    let techs = state.research.research || [];
    if (state.resBranch !== 'all')           techs = techs.filter(t => t.branch === state.resBranch);
    if (state.resFilter === 'available')     techs = techs.filter(t => t.status === null && t.eraUnlocked && !t.isMaxed);
    if (state.resFilter === 'in_progress')   techs = techs.filter(t => t.status === 'in_progress');
    if (state.resFilter === 'completed')     techs = techs.filter(t => t.status === 'completed');
    if (state.resSearch) {
      const q = state.resSearch.toLowerCase();
      techs = techs.filter(t =>
        t.name.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q)
      );
    }

    // Sort by branch then lab level then sortOrder
    const BRANCH_ORDER = { economy: 0, military: 1, science: 2 };
    techs = [...techs].sort((a, b) => {
      // When viewing a single branch, sort by lab level then sortOrder
      if (state.resBranch !== 'all') {
        return (a.requiredLabLevel - b.requiredLabLevel) || (a.sortOrder - b.sortOrder);
      }
      const bd = (BRANCH_ORDER[a.branch] || 0) - (BRANCH_ORDER[b.branch] || 0);
      if (bd !== 0) return bd;
      return (a.requiredLabLevel - b.requiredLabLevel) || (a.sortOrder - b.sortOrder);
    });

    // Build rows with branch + lab headers
    const html = [];
    let lastBranch = null, lastLab = null;

    for (const tech of techs) {
      const isCompleted   = tech.isMaxed || (tech.status === 'completed' && tech.level >= tech.maxLevel);
      const isInProgress  = tech.status === 'in_progress';
      const isAvailable   = tech.status === null && tech.eraUnlocked && !isCompleted;

      const queuedLevels   = state.queue.filter(q => q.type === 'research' && q.key === tech.key).length;
      const effectiveLevel = tech.level + queuedLevels;
      const nextLevel      = effectiveLevel + 1;
      const atMax          = nextLevel > tech.maxLevel;

      const cost    = researchCost(tech);
      const hasCost = Object.keys(cost).length > 0;
      const timeSec = Math.round((tech.nextResearchTime || 0) * mult);

      // Branch header (only when showing all branches)
      if (state.resBranch === 'all' && tech.branch !== lastBranch) {
        const collapsed = !!state.collapsed[`branch-${tech.branch}`];
        html.push(`<div class="nxp-group-hd ${collapsed ? 'collapsed' : ''}"
          data-action="toggle-group" data-val="branch-${tech.branch}">
          <span class="nxp-chevron">▾</span>${tech.branch}
        </div>`);
        lastBranch = tech.branch;
        lastLab = null;
      }
      if (state.resBranch === 'all' && state.collapsed[`branch-${tech.branch}`]) continue;

      // Lab level sub-header
      const labKey = `lab-${tech.branch}-${tech.requiredLabLevel}`;
      if (tech.requiredLabLevel !== lastLab) {
        const collapsed = !!state.collapsed[labKey];
        html.push(`<div class="nxp-section-hd" style="padding-left:${state.resBranch === 'all' ? '22' : '14'}px;cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px"
          data-action="toggle-group" data-val="${labKey}">
          <span style="font-size:8px;opacity:0.6;transition:transform 0.15s;display:inline-block;transform:${collapsed ? 'rotate(-90deg)' : 'rotate(0)'}">▾</span>Lab ${tech.requiredLabLevel}
        </div>`);
        lastLab = tech.requiredLabLevel;
      }
      if (state.collapsed[labKey]) continue;

      let nameClass = 'locked';
      if (isInProgress) nameClass = 'in-progress';
      else if (isAvailable) nameClass = 'available';
      else if (isCompleted) nameClass = '';

      const lvlTxt = tech.maxLevel > 1
        ? ` (Lv ${effectiveLevel}/${tech.maxLevel}${queuedLevels > 0 ? ` +${queuedLevels} queued` : ''})`
        : '';
      const statusTxt = (isCompleted && atMax) ? '✓ Max' :
        isInProgress ? '⟳ In Progress' :
        !tech.eraUnlocked ? '🔒 Era locked' :
        tech.requirements && tech.requirements.length
          ? `Req: ${tech.requirements.map(r => r.key.replace(/_/g,' ')).join(', ')}`
          : '';

      const canAdd = hasCost && !atMax && tech.eraUnlocked &&
        !(isInProgress && tech.maxLevel === 1);

      html.push(`
        <div class="nxp-row ${(isCompleted && atMax) ? 'locked' : ''}">
          <div class="nxp-row-info">
            <div class="nxp-row-name ${nameClass}">${tech.name}${lvlTxt}</div>
            <div class="nxp-row-sub">${tech.category.replace(/_/g,' ')}${statusTxt ? ' · ' + statusTxt : ''}</div>
            ${hasCost ? costChips(cost, stock) : ''}
          </div>
          <div class="nxp-row-actions">
            ${hasCost ? `<span class="nxp-time-chip">⏱ ${fmtTime(timeSec)}</span>` : ''}
            <button class="nxp-add-btn" id="nxp-add-res-${tech.key}" ${canAdd ? '' : 'disabled'}
              data-action="add-research" data-val="${tech.key}">+ Plan${queuedLevels > 0 ? ` Lv${nextLevel}` : ''}</button>
          </div>
        </div>`);
    }

    return filterBar + (html.length
      ? html.join('')
      : '<div class="nxp-empty">No research matches this filter.</div>');
  }



  // ── Tab: Buildings ─────────────────────────────────────────────────────────
  function renderBuildings() {
    const pd = state.planet;
    if (!pd) return '<div class="nxp-empty">No planet data loaded.</div>';
    const stock     = stockpile();
    const mult      = pd.buildSpeedMult || 1;
    const buildings = pd.buildings || [];

    const filters = ['all', 'upgradeable'];
    const filterBar = `
      <div class="nxp-search-bar">
        <input class="nxp-search-input" type="text" placeholder="Search buildings…"
          data-search="build" value="${state.buildSearch}">
        ${state.buildSearch ? `<span class="nxp-search-clear" data-action="clear-search" data-val="build">×</span>` : ''}
      </div>
      <div class="nxp-filter-bar">
        ${filters.map(f => `<button class="nxp-filter-btn ${state.buildFilter === f ? 'active' : ''}"
          data-action="build-filter" data-val="${f}">${f}</button>`).join('')}
      </div>`;

    let blist = buildings;
    if (state.buildFilter === 'upgradeable') {
      blist = blist.filter(b => {
        const def = b.definition;
        return def && b.level < def.maxLevel && def.requirementsMet && !b.isUpgrading;
      });
    }
    if (state.buildSearch) {
      const q = state.buildSearch.toLowerCase();
      blist = blist.filter(b =>
        (b.definition?.name || '').toLowerCase().includes(q) ||
        (b.definition?.category || '').toLowerCase().includes(q)
      );
    }

    const CAT_ORDER = { resource: 0, energy: 1, military: 2, defense: 3, utility: 4 };

    // Sort by category then name
    blist = [...blist].sort((a, b) => {
      const ca = CAT_ORDER[a.definition?.category] ?? 5;
      const cb = CAT_ORDER[b.definition?.category] ?? 5;
      if (ca !== cb) return ca - cb;
      return (a.definition?.name || '').localeCompare(b.definition?.name || '');
    });

    // Build rows with category group headers
    const html = [];
    let lastCat = null;

    for (const b of blist) {
      const def = b.definition;
      if (!def) continue;

      if (def.category !== lastCat) {
        const collapsed = !!state.collapsed[`bld-${def.category}`];
        html.push(`<div class="nxp-group-hd ${collapsed ? 'collapsed' : ''}"
          data-action="toggle-group" data-val="bld-${def.category}">
          <span class="nxp-chevron">▾</span>${def.category}
        </div>`);
        lastCat = def.category;
      }
      if (state.collapsed[`bld-${def.category}`]) continue;

      const cost      = buildingCost(b);
      const hasCost   = Object.keys(cost).length > 0;
      const isMaxed   = b.level >= def.maxLevel;
      const isUpg     = b.isUpgrading;
      const cantResearch = !def.requirementsMet;

      const baseBuild = def.baseBuildTime || 0;
      const rawTime   = baseBuild * Math.pow(def.buildTimeFactor || 1.5, b.level);
      const buildSec  = Math.round(rawTime * mult);

      let nameClass = '';
      if (isMaxed)    nameClass = 'locked';
      else if (isUpg) nameClass = 'in-progress';

      const sub = [
        `Lv ${b.level}/${def.maxLevel}`,
        isMaxed      ? '· Max' : '',
        isUpg        ? '· Upgrading…' : '',
        cantResearch ? '· Requirements not met' : '',
      ].filter(Boolean).join(' ');

      const canAdd = hasCost && !isMaxed && !isUpg && def.requirementsMet;

      html.push(`
        <div class="nxp-row">
          <div class="nxp-row-info">
            <div class="nxp-row-name ${nameClass}">${def.name}</div>
            <div class="nxp-row-sub">${sub}</div>
            ${hasCost && !isMaxed ? costChips(cost, stock) : ''}
          </div>
          <div class="nxp-row-actions">
            ${hasCost && !isMaxed ? `<span class="nxp-time-chip">⏱ ${fmtTime(buildSec)}</span>` : ''}
            <button class="nxp-add-btn" id="nxp-add-bld-${b.id}" ${canAdd ? '' : 'disabled'}
              data-action="add-building" data-id="${b.id}">+ Plan</button>
          </div>
        </div>`);
    }

    return filterBar + (html.length
      ? html.join('')
      : '<div class="nxp-empty">No buildings match this filter.</div>');
  }

  // ── Tab: Summary ───────────────────────────────────────────────────────────
  function renderSummary() {
    if (!state.queue.length) {
      return `<div class="nxp-empty">
        Your plan is empty.<br>
        Add ships, research, or buildings<br>from the other tabs.
      </div>`;
    }

    const stock = stockpile();
    const rates = productionRates();
    const total = totalQueueCost();
    const ttgH  = timeToGoal(total);

    // Queue list
    const qRows = state.queue.map((item, i) => {
      const costStr = Object.entries(item.cost)
        .filter(([,v]) => v > 0)
        .map(([k,v]) => `${RES_LABEL[k]} ${fmtNum(v)}`)
        .join(' · ') || '—';
      return `
        <div class="nxp-q-item">
          <div class="nxp-q-idx">${i+1}</div>
          <div class="nxp-q-info">
            <div class="nxp-q-name">${item.name}</div>
            <div class="nxp-q-sub">${item.typeLabel}${item.qty > 1 ? ` ×${item.qty}` : ''} · ${costStr}</div>
          </div>
          <span class="nxp-q-remove" data-action="remove-queue" data-val="${i}" title="Remove">×</span>
        </div>`;
    }).join('');

    // Totals grid
    const totalCells = RES_KEYS
      .filter(k => total[k] > 0)
      .map(k => {
        const have = stock[k] || 0;
        const ok   = have >= total[k];
        return `
          <div class="nxp-total-cell">
            <div class="nxp-total-label">${RES_LABEL[k]}</div>
            <div class="nxp-total-val ${ok ? 'ok' : 'short'}">${fmtNum(total[k])}</div>
          </div>`;
      }).join('');

    const ttgTxt = ttgH === 0 ? 'Ready now'
      : ttgH === Infinity ? '∞ (missing production)'
      : fmtTime(ttgH * 3600);

    const ttgBanner = `
      <div class="nxp-ttg">
        <div>
          <div class="nxp-ttg-label">Time to goal</div>
          <div class="nxp-ttg-val">${ttgTxt}</div>
        </div>
        <div style="flex:1"></div>
        <div style="font-size:10px;color:#3a4a5a;text-align:right">
          ${state.queue.length} item${state.queue.length !== 1 ? 's' : ''} in plan
        </div>
      </div>`;

    const bars = Object.keys(total).length > 0
      ? `<div class="nxp-section-hd">Resource gap</div>
         ${gapBars(total, stock, rates)}`
      : '';

    const clearBtn = _clearConfirm
      ? `<button class="nxp-clear-btn nxp-clear-confirm" data-action="clear-confirm">
          ⚠ Confirm — clear all ${state.queue.length} items?
        </button>
        <button class="nxp-clear-btn" data-action="clear-cancel" style="margin-top:0">
          Cancel
        </button>`
      : `<button class="nxp-clear-btn" data-action="clear-queue">
          Clear all planned items
        </button>`;

    return `
      <div class="nxp-section-hd">Planned items</div>
      ${qRows}
      <hr class="nxp-divider">
      <div class="nxp-section-hd">Total cost</div>
      <div class="nxp-total-grid">${totalCells || '<div style="padding:8px 14px;color:#3a4a5a;font-size:10px">No resource costs.</div>'}</div>
      ${ttgBanner}
      ${bars}
      ${clearBtn}`;
  }

  // ── Main render ────────────────────────────────────────────────────────────
  function render() {
    const pname = (state.planet && state.planet.planet && state.planet.planet.name)
      || currentPlanetName()
      || '—';

    const tabs = [
      { key: 'ships',    label: 'Ships' },
      { key: 'research', label: 'Research' },
      { key: 'buildings',label: 'Buildings' },
      { key: 'summary',  label: 'Plan', badge: state.queue.length || null, flash: state.planFlash },
    ];

    const tabsHtml = tabs.map(t => `
      <div class="nxp-tab ${state.tab === t.key ? 'active' : ''}"
        data-action="tab" data-val="${t.key}">
        ${t.label}${t.badge
          ? `<span class="nxp-badge ${t.flash ? 'flash' : ''}">${t.badge}</span>`
          : ''}
      </div>`).join('');

    let body = '';
    if (state.loading) {
      body = '<div class="nxp-loading">⟳ Loading data…</div>';
    } else if (state.error) {
      body = `<div class="nxp-error">${state.error}</div>`;
    } else if (!state.planet) {
      body = `<div class="nxp-empty">
        Click ↻ to load data,<br>or open a colony page first.
      </div>`;
    } else {
      if (state.tab === 'ships')     body = renderShips();
      if (state.tab === 'research')  body = renderResearch();
      if (state.tab === 'buildings') body = renderBuildings();
      if (state.tab === 'summary')   body = renderSummary();

      // Production status line at bottom
      const rates = productionRates();
      const rateStr = ['ore','silicates','hydrogen','alloys']
        .map(k => `${RES_LABEL[k]} +${fmtNum(rates[k])}/h`)
        .join(' · ');
      body += `<div class="nxp-status-row">⬡ ${pname} · ${rateStr}</div>`;
    }

    // Preserve focused search input and scroll position before wiping innerHTML
    const activeSearch = document.activeElement;
    const focusedSearch = activeSearch && activeSearch.dataset && activeSearch.dataset.search
      ? activeSearch.dataset.search : null;
    const selStart = focusedSearch ? activeSearch.selectionStart : null;
    const selEnd   = focusedSearch ? activeSearch.selectionEnd   : null;
    const scrollTop = panel.querySelector('#nxp-body')
      ? panel.querySelector('#nxp-body').scrollTop : 0;

    panel.innerHTML = `
      <div id="nxp-header">
        <span class="nxp-title">⬡ NexStar Planner</span>
        <span class="nxp-ver">v${VERSION}</span>
        <span class="nxp-planet">${pname}</span>
        <span class="nxp-refresh" data-action="refresh" title="Refresh data">↻</span>
        <span class="nxp-close" data-action="close" title="Close">×</span>
      </div>
      <div id="nxp-tabs">${tabsHtml}</div>
      <div id="nxp-body">${body}</div>`;

    // Restore scroll position
    const bodyEl = panel.querySelector('#nxp-body');
    if (bodyEl) bodyEl.scrollTop = scrollTop;

    // Restore focus to the search input that was active
    if (focusedSearch) {
      const el = panel.querySelector(`[data-search="${focusedSearch}"]`);
      if (el) {
        el.focus();
        try { el.setSelectionRange(selStart, selEnd); } catch (e) { /* */ }
      }
    }
  }

  // ── Event delegation (avoids CSP issues with inline onclick) ──────────────
  panel.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    const val    = el.dataset.val;
    const id     = el.dataset.id ? +el.dataset.id : null;

    if (action === 'tab')            { state.tab = val; state.collapsed = {}; render(); }
    else if (action === 'close')     { panel.style.display = 'none'; }
    else if (action === 'refresh')   { fetchAll(); }
    else if (action === 'ship-filter')   { state.shipFilter  = val; render(); }
    else if (action === 'res-filter')    { state.resFilter   = val; render(); }
    else if (action === 'res-branch')    { state.resBranch   = val; render(); }
    else if (action === 'build-filter')  { state.buildFilter = val; render(); }
    else if (action === 'clear-search')  {
      if (val === 'ship')  { state.shipSearch  = ''; render(); }
      if (val === 'res')   { state.resSearch   = ''; render(); }
      if (val === 'build') { state.buildSearch = ''; render(); }
    }
    else if (action === 'toggle-group') {
      state.collapsed[val] = !state.collapsed[val];
      render();
    }
    else if (action === 'add-ship')      { window.__nxp.addShip(id); }
    else if (action === 'add-research')  { window.__nxp.addResearch(val); }
    else if (action === 'add-building')  { window.__nxp.addBuilding(id); }
    else if (action === 'remove-queue')  { removeFromQueue(+val); }
    else if (action === 'clear-queue')   { _clearConfirm = true; render(); }
    else if (action === 'clear-confirm') { _clearConfirm = false; clearQueue(); }
    else if (action === 'clear-cancel')  { _clearConfirm = false; render(); }
  });

  // Search inputs — use input event, not click
  panel.addEventListener('input', e => {
    const el = e.target.closest('[data-search]');
    if (!el) return;
    const which = el.dataset.search;
    const val   = el.value;
    if (which === 'ship')  { state.shipSearch  = val; render(); }
    if (which === 'res')   { state.resSearch   = val; render(); }
    if (which === 'build') { state.buildSearch = val; render(); }
  });

  // ── Public API ─────────────────────────────────────────────────────────────
  window.__nxp = {
    setTab(t) { state.tab = t; render(); },
    close() { panel.style.display = 'none'; },
    refresh() { fetchAll(); },

    setShipFilter(f)  { state.shipFilter  = f; render(); },
    setResFilter(f)   { state.resFilter   = f; render(); },
    setBuildFilter(f) { state.buildFilter = f; render(); },

    addShip(shipId) {
      const ship = (state.ships && state.ships.ships || []).find(s => s.id === shipId);
      if (!ship) return;
      const qtyEl = document.getElementById(`nxp-sq-${shipId}`);
      const qty   = qtyEl ? Math.max(1, parseInt(qtyEl.value) || 1) : 1;
      const cost  = shipCost(ship, qty);
      const mult  = state.ships.shipSpeedMult || 1;
      const time  = Math.round((ship.buildTime || 0) * mult) * qty;
      addToQueue({
        type: 'ship', key: ship.key, name: ship.name, qty,
        typeLabel: 'Ship', cost, time,
      });
      flashBtn(`nxp-add-ship-${shipId}`);
      // do NOT switch tab
    },

    addResearch(techKey) {
      const tech = (state.research && state.research.research || []).find(t => t.key === techKey);
      if (!tech) return;

      // Count how many times this tech is already in the queue to determine next level
      const queued = state.queue.filter(q => q.type === 'research' && q.key === techKey).length;
      const effectiveLevel = tech.level + queued;
      const nextLevel      = effectiveLevel + 1;

      // Check against maxLevel
      if (nextLevel > tech.maxLevel) return;

      // Scale cost using costFactor ^ queued (same formula as the API uses per level)
      const baseCost = {
        ore: tech.costOre, silicates: tech.costSilicates,
        hydrogen: tech.costHydrogen, alloys: tech.costAlloys,
      };
      const rareCosts = tech.rareCosts || {};
      const factor = Math.pow(tech.costFactor || 1, effectiveLevel);
      const cost = {};
      if (baseCost.ore)       cost.ore       = Math.round(baseCost.ore       * factor);
      if (baseCost.silicates) cost.silicates = Math.round(baseCost.silicates * factor);
      if (baseCost.hydrogen)  cost.hydrogen  = Math.round(baseCost.hydrogen  * factor);
      if (baseCost.alloys)    cost.alloys    = Math.round(baseCost.alloys    * factor);
      for (const [k, v] of Object.entries(rareCosts)) {
        const field = RARE_MAP[k] || k;
        if (v) cost[field] = Math.round(v * factor);
      }

      const mult    = state.research.researchSpeedMult || 1;
      const rawTime = (tech.researchTime || 0) * Math.pow(tech.timeFactor || 1, effectiveLevel);
      const time    = Math.round(rawTime * mult);

      // Lab requirement warning — note it in the name if future level needs higher lab
      const labNote = tech.requiredLabLevel > 1
        ? ` [Lab ${tech.requiredLabLevel}]` : '';

      addToQueue({
        type: 'research', key: tech.key,
        name: `${tech.name}${tech.maxLevel > 1 ? ` → Lv${nextLevel}` : ''}${labNote}`,
        qty: 1, typeLabel: 'Research', cost, time,
        requiredLabLevel: tech.requiredLabLevel,
      });
      flashBtn(`nxp-add-res-${techKey}`);
      render(); // re-render to update button state (disable if now at max)
    },

    addBuilding(buildingId) {
      const pd = state.planet;
      if (!pd) return;
      const b = (pd.buildings || []).find(x => x.id === buildingId);
      if (!b || !b.definition) return;
      const cost = buildingCost(b);
      const def  = b.definition;
      const mult = pd.buildSpeedMult || 1;
      const rawT = (def.baseBuildTime || 0) * Math.pow(def.buildTimeFactor || 1.5, b.level);
      const time = Math.round(rawT * mult);
      addToQueue({
        type: 'building', key: def.key,
        name: `${def.name} → Lv${b.level + 1}`,
        qty: 1, typeLabel: 'Building', cost, time,
      });
      flashBtn(`nxp-add-bld-${buildingId}`);
    },

    removeFromQueue(idx) { removeFromQueue(idx); },
    clearQueue() { clearQueue(); },
  };

  // ── Planet switching detection ─────────────────────────────────────────────
  let _lastPlanetName = '';
  setInterval(() => {
    const name = currentPlanetName();
    if (name && name !== _lastPlanetName) {
      _lastPlanetName = name;
      loadQueue(); // load this colony's queue
      if (panel.style.display !== 'none') {
        fetchAll();
      } else {
        state.planet = null;
        state.ships  = null;
      }
      render();
    }
  }, 1500);

  // ── Init ───────────────────────────────────────────────────────────────────
  render();

})();
