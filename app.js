import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let allRuns = [];
let filteredRuns = [];
let selectedRun = null;
let currentBrand = null;
let currentMode = 'solid';
let activeVideoTab = 'rgb';
let activeSegment = { rgb: 0, thermal: 0 };
let tableCursor = 0;                 // how many rows of the current run are rendered
const TABLE_CHUNK = 100;             // runs hold up to 323 firebrands; render in chunks

let scene, camera, renderer, controls, gridHelper;
let currentGeometry = null, currentObject = null, currentBoxHelper = null;
let dimensionLines = null, midpoints = null;
const dimensionDivs = {};

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('vendor/draco/');

// Which factors describe each fuel family. A single fixed filter set cannot serve four
// designs: hazard rating exists only for bark, sample length only for candlebark.
const FACETS_BY_FAMILY = {
  branchlet: ['species', 'structure', 'hrr_kw'],
  fibrous_bark: ['species', 'hazard_rating', 'hrr_kw', 'trunk_section'],
  candlebark: ['structure', 'sample_length_cm', 'hrr_kw'],
  preliminary_branchlet_test: ['species'],
  all: ['hrr_kw'],
};
const FACET_LABEL = {
  species: 'Species',
  structure: 'Fuel structure',
  hazard_rating: 'Bark hazard rating',
  trunk_section: 'Trunk section',
  sample_length_cm: 'Sample length (cm)',
  hrr_kw: 'Heat release rate (kW)',
};
let facetState = {};

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initApp();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function initApp() {
  // Loading the catalogue and wiring the interface are separate failures and must report
  // separately. Previously one try/catch covered both, so a WebGL failure during setup
  // displayed "could not load the database" over a catalogue that had loaded perfectly.
  try {
    const response = await fetch('database.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    allRuns = await response.json();
  } catch (error) {
    console.error('Could not load database.json:', error);
    document.getElementById('runs-list').innerHTML = `
      <div class="empty-state" style="margin: 20px; border-color: #ef4444;">
        <div class="empty-state-icon">!</div>
        <h3>Could not load the catalogue</h3>
        <p>database.json is missing or unreadable.</p>
      </div>`;
    return;
  }

  const meshes = allRuns.reduce((n, r) => n + r.firebrands.filter(b => b.mesh_path).length, 0);
  document.getElementById('stat-runs').textContent = allRuns.length;
  document.getElementById('stat-meshes').textContent = meshes.toLocaleString();

  // Each subsystem is wired independently, so one that fails cannot take the rest of the
  // interface down with it — browsing and the tables stay usable without WebGL.
  const step = (name, fn) => {
    try { fn(); } catch (e) { console.error(`Setup step "${name}" failed:`, e); return false; }
    return true;
  };
  step('filters', setupFilters);
  step('theme', setupThemeToggle);
  step('video tabs', setupVideoTabs);
  step('render controls', setupRenderControls);
  step('video focus', setupVideoFocusToggle);
  step('sidebar', setupSidebarToggle);

  if (!step('3D viewport', initThreeViewport)) {
    viewportUnavailable('This browser could not start the 3D viewer, so meshes cannot be '
      + 'displayed. Everything else on the page still works.');
  }

  step('facets', rebuildFacets);
  step('list', applyFilters);
  step('deep link', openFromHash);
  window.addEventListener('hashchange', openFromHash);
}

/**
 * Open the experiment named in the URL fragment, so a link to one experiment can be shared
 * or cited. Without this the only way to reach a run is to find it in the list again.
 */
function openFromHash() {
  const match = /^#run=(.+)$/.exec(decodeURIComponent(location.hash || ''));
  if (!match) return;
  const run = allRuns.find(r => r.id === match[1]);
  if (!run || (selectedRun && selectedRun.id === run.id)) return;
  selectRun(run);
  document.querySelectorAll('.run-item').forEach(el =>
    el.classList.toggle('active', el.getAttribute('data-id') === run.id));
}

/** Report a dead viewport in the viewport, not as a database error. */
function viewportUnavailable(message) {
  const container = document.getElementById('three-container');
  if (!container) return;
  const box = document.getElementById('canvas-loading');
  if (box) {
    box.style.display = 'flex';
    const spinner = box.querySelector('.spinner');
    if (spinner) spinner.style.display = 'none';
    const text = box.querySelector('.loading-text');
    if (text) text.textContent = message;
  }
}

function initTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  applyTheme(saved);
}

function applyTheme(theme) {
  const themeBtn = document.getElementById('theme-toggle');
  const sun = themeBtn?.querySelector('.sun-icon');
  const moon = themeBtn?.querySelector('.moon-icon');
  document.body.classList.toggle('light-mode', theme === 'light');
  document.body.classList.toggle('dark-mode', theme !== 'light');
  if (sun) sun.style.display = theme === 'light' ? 'none' : 'block';
  if (moon) moon.style.display = theme === 'light' ? 'block' : 'none';
  updateGridColors();
}

function setupThemeToggle() {
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const next = document.body.classList.contains('dark-mode') ? 'light' : 'dark';
    localStorage.setItem('theme', next);
    applyTheme(next);
  });
}

function updateGridColors() {
  if (!gridHelper || !scene) return;
  const isLight = document.body.classList.contains('light-mode');
  disposeObject3D(gridHelper);
  scene.remove(gridHelper);
  gridHelper = new THREE.GridHelper(100, 10,
    new THREE.Color(isLight ? '#6d28d9' : '#7c3aed'),
    new THREE.Color(isLight ? '#cbd5e1' : '#242f44'));
  if (currentGeometry?.boundingBox) gridHelper.position.y = currentGeometry.boundingBox.min.y;
  scene.add(gridHelper);
}

// ---------------------------------------------------------------------------
// Filtering — facets follow the selected family
// ---------------------------------------------------------------------------
function setupFilters() {
  document.getElementById('filter-fuel-type').addEventListener('change', () => {
    facetState = {};
    rebuildFacets();
    applyFilters();
  });
  document.getElementById('sort-select').addEventListener('change', applyFilters);

  const search = document.getElementById('search-input');
  const clear = document.getElementById('clear-search');
  search.addEventListener('input', () => {
    clear.style.display = search.value ? 'block' : 'none';
    applyFilters();
  });
  clear.addEventListener('click', () => {
    search.value = '';
    clear.style.display = 'none';
    applyFilters();
  });
}

/** Build the facet controls that apply to the currently selected family. */
function rebuildFacets() {
  const family = document.getElementById('filter-fuel-type').value;
  const host = document.getElementById('dynamic-facets');
  host.innerHTML = '';

  const pool = family === 'all' ? allRuns : allRuns.filter(r => r.fuel_type === family);
  for (const key of FACETS_BY_FAMILY[family] || FACETS_BY_FAMILY.all) {
    const values = [...new Set(pool.map(r => r[key]).filter(v => v !== null && v !== undefined))]
      .sort((a, b) => (typeof a === 'number' ? a - b : String(a).localeCompare(String(b))));
    if (values.length < 2) continue;   // a facet with one value filters nothing

    const wrap = document.createElement('div');
    wrap.className = 'panel-section';
    wrap.innerHTML = `
      <label class="filter-label" for="facet-${key}">${FACET_LABEL[key] || key}</label>
      <select id="facet-${key}" class="form-select" data-facet="${key}">
        <option value="all">All</option>
        ${values.map(v => `<option value="${String(v)}">${String(v)}</option>`).join('')}
      </select>`;
    host.appendChild(wrap);
    wrap.querySelector('select').addEventListener('change', (e) => {
      facetState[key] = e.target.value;
      applyFilters();
    });
  }
}

function applyFilters() {
  const q = document.getElementById('search-input').value.trim().toLowerCase();
  const family = document.getElementById('filter-fuel-type').value;
  const sortVal = document.getElementById('sort-select').value;

  filteredRuns = allRuns.filter(run => {
    if (family !== 'all' && run.fuel_type !== family) return false;

    for (const [key, want] of Object.entries(facetState)) {
      if (!want || want === 'all') continue;
      if (String(run[key]) !== want) return false;
    }

    if (q) {
      // Search every descriptive field plus the firebrand identifiers, not just three.
      const hay = [run.id, run.title, run.fuel_label, run.species, run.hazard_rating,
                   run.structure, run.trunk_section, run.size_class,
                   run.hrr_kw ? `${run.hrr_kw} kw` : '']
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) {
        const inBrands = run.firebrands.some(b =>
          b.file_id.toLowerCase().includes(q) || (b.uid || '').toLowerCase().includes(q));
        if (!inBrands) return false;
      }
    }
    return true;
  });

  filteredRuns.sort((a, b) => {
    switch (sortVal) {
      case 'id-desc': return b.title.localeCompare(a.title, undefined, { numeric: true });
      case 'hrr-desc': return (b.hrr_kw || 0) - (a.hrr_kw || 0);
      case 'hrr-asc': return (a.hrr_kw || 0) - (b.hrr_kw || 0);
      case 'brands-desc': return b.firebrands.length - a.firebrands.length;
      case 'brands-asc': return a.firebrands.length - b.firebrands.length;
      default: return a.title.localeCompare(b.title, undefined, { numeric: true });
    }
  });

  renderRunsList();
}

// ---------------------------------------------------------------------------
// Sidebar — grouped tree, because the release is a hierarchy, not a flat list
// ---------------------------------------------------------------------------
function subgroupOf(run) {
  switch (run.fuel_type) {
    case 'fibrous_bark': return `${run.species || '—'} · ${run.hazard_rating || '—'}`;
    case 'candlebark': return run.structure || '—';
    case 'preliminary_branchlet_test': return 'All preliminary runs';
    default: return run.species || '—';
  }
}

function renderRunsList() {
  const host = document.getElementById('runs-list');
  host.innerHTML = '';
  document.getElementById('filtered-count').textContent = filteredRuns.length;

  if (!filteredRuns.length) {
    host.innerHTML = `<div class="empty-list-msg">No experiments match these filters.</div>`;
    return;
  }

  // family -> subgroup -> runs
  const tree = new Map();
  for (const run of filteredRuns) {
    if (!tree.has(run.fuel_label)) tree.set(run.fuel_label, new Map());
    const sub = tree.get(run.fuel_label);
    const key = subgroupOf(run);
    if (!sub.has(key)) sub.set(key, []);
    sub.get(key).push(run);
  }

  // With few results the tree is noise, so fall back to a flat list.
  const flat = filteredRuns.length <= 12;

  for (const [familyLabel, subs] of tree) {
    const famCount = [...subs.values()].reduce((n, a) => n + a.length, 0);
    const famEl = document.createElement('div');
    famEl.className = 'tree-family';
    famEl.innerHTML = `
      <button class="tree-header" aria-expanded="true">
        <span class="tree-caret">▾</span>
        <span class="tree-name">${familyLabel}</span>
        <span class="tree-count">${famCount}</span>
      </button>
      <div class="tree-body"></div>`;
    const body = famEl.querySelector('.tree-body');
    famEl.querySelector('.tree-header').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!open));
      btn.querySelector('.tree-caret').textContent = open ? '▸' : '▾';
      body.style.display = open ? 'none' : 'block';
    });

    for (const [subName, runs] of [...subs].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (flat || subs.size === 1 && tree.size === 1) {
        runs.forEach(r => body.appendChild(runItem(r)));
        continue;
      }
      const subEl = document.createElement('div');
      subEl.className = 'tree-sub';
      subEl.innerHTML = `
        <button class="tree-subheader" aria-expanded="false">
          <span class="tree-caret">▸</span>
          <span class="tree-name">${subName}</span>
          <span class="tree-count">${runs.length}</span>
        </button>
        <div class="tree-subbody" style="display:none;"></div>`;
      const subBody = subEl.querySelector('.tree-subbody');
      runs.forEach(r => subBody.appendChild(runItem(r)));
      subEl.querySelector('.tree-subheader').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const open = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!open));
        btn.querySelector('.tree-caret').textContent = open ? '▸' : '▾';
        subBody.style.display = open ? 'none' : 'block';
      });
      body.appendChild(subEl);
    }
    host.appendChild(famEl);
  }
}

function runItem(run) {
  const el = document.createElement('div');
  el.className = 'run-item' + (selectedRun && selectedRun.id === run.id ? ' active' : '');
  el.setAttribute('data-id', run.id);
  const n = run.firebrands.length;
  const media = [];
  if (run.rgb_videos.length) media.push(`${run.rgb_videos.length} RGB`);
  if (run.thermal_videos.length) media.push(`${run.thermal_videos.length} thermal`);

  el.innerHTML = `
    <div class="run-item-header">
      <span class="run-item-title" title="${run.id}">${run.title}</span>
      <span class="run-item-count">${n} firebrand${n === 1 ? '' : 's'}</span>
    </div>
    <div class="run-item-badges">
      ${run.hrr_kw ? `<span class="badge badge-accent">${run.hrr_kw} kW</span>` : ''}
      ${run.size_class ? `<span class="badge badge-secondary">${run.size_class}</span>` : ''}
      ${media.length ? `<span class="badge badge-info">${media.join(' · ')}</span>` : ''}
    </div>`;
  el.addEventListener('click', () => {
    document.querySelectorAll('.run-item').forEach(x => x.classList.remove('active'));
    el.classList.add('active');
    selectRun(run);
    if (window.matchMedia('(max-width: 900px)').matches) closeSidebar();
  });
  return el;
}

// ---------------------------------------------------------------------------
// Run detail
// ---------------------------------------------------------------------------
function selectRun(run) {
  selectedRun = run;
  activeSegment = { rgb: 0, thermal: 0 };
  // Reflect the selection in the URL so the view can be linked to or cited.
  const target = `#run=${encodeURIComponent(run.id)}`;
  if (location.hash !== target) history.replaceState(null, '', target);

  document.getElementById('no-selection-screen').style.display = 'none';
  document.getElementById('active-workspace').style.display = 'grid';

  document.getElementById('detail-title').textContent = run.title;
  document.getElementById('detail-id').textContent = run.id;

  const badges = document.getElementById('detail-badges');
  const chips = [
    ['badge-primary', run.fuel_label],
    ['badge-secondary', run.species],
    ['badge-accent', run.hrr_kw ? `${run.hrr_kw} kW` : null],
    ['badge-info', run.hazard_rating ? `${run.hazard_rating} hazard` : null],
    ['badge-info', run.structure],
    ['badge-info', run.trunk_section ? `Section ${run.trunk_section}` : null],
    ['badge-info', run.sample_length_cm ? `${run.sample_length_cm} cm` : null],
  ].filter(([, v]) => v);
  badges.innerHTML = chips.map(([c, v]) => `<span class="badge ${c}">${v}</span>`).join('');

  updateVideoPlayers(run);
  populateFirebrandsTable(run);
  onViewportResize();
}

/** Copy the machine id, which is what a citation needs. */
window.copyRunId = function () {
  const id = document.getElementById('detail-id').textContent;
  navigator.clipboard?.writeText(id).then(() => {
    const btn = document.getElementById('btn-copy-id');
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = old; }, 1200);
  });
};

// ---------------------------------------------------------------------------
// Video — every segment reachable, not just the first
// ---------------------------------------------------------------------------
function updateVideoPlayers(run) {
  renderSegmentStrip('rgb', run.rgb_videos.map((p, i) => ({ path: p, label: segLabel(p, i) })));
  renderSegmentStrip('thermal', (run.thermal_segments || []).map((s, i) => ({
    path: s.path, label: s.label || segLabel(s.path, i), threshold_degC: s.threshold_degC,
  })));
  loadSegment('rgb', 0);
  loadSegment('thermal', 0);
}

function segLabel(path, i) {
  const base = (path || '').split('/').pop() || '';
  return base.replace(/\.[^.]+$/, '') || `Part ${i + 1}`;
}

function renderSegmentStrip(kind, segments) {
  const strip = document.getElementById(`segments-${kind}`);
  if (!strip) return;
  // A trailing letter on a section (S13a, S13b) is a continuation of one recording, so these
  // are parts of an experiment. The old viewer loaded [0] and hid the rest.
  if (segments.length <= 1) { strip.innerHTML = ''; strip.style.display = 'none'; return; }
  strip.style.display = 'flex';
  strip.innerHTML = `<span class="segment-hint">${segments.length} parts:</span>` +
    segments.map((s, i) =>
      `<button class="segment-btn${i === 0 ? ' active' : ''}" data-kind="${kind}" data-i="${i}">${s.label}</button>`
    ).join('');
  strip.querySelectorAll('.segment-btn').forEach(btn => {
    btn.addEventListener('click', () => loadSegment(kind, Number(btn.dataset.i)));
  });
}

function loadSegment(kind, index) {
  const run = selectedRun;
  if (!run) return;
  const list = kind === 'rgb'
    ? run.rgb_videos.map(p => ({ path: p }))
    : (run.thermal_segments || []);
  const video = document.getElementById(`video-${kind}`);
  const empty = document.getElementById(`video-${kind}-empty`);

  document.querySelectorAll(`#segments-${kind} .segment-btn`).forEach((b, i) =>
    b.classList.toggle('active', i === index));

  if (!list.length) {
    video.pause(); video.removeAttribute('src'); video.load();
    video.style.display = 'none';
    empty.style.display = 'flex';
    empty.querySelector('span').textContent = kind === 'rgb'
      ? 'No RGB recording survives for this experiment.'
      : 'No thermal recording survives for this experiment.';
    return;
  }
  activeSegment[kind] = index;
  const seg = list[index];
  video.pause();
  video.src = seg.path;
  video.load();
  video.style.display = 'block';
  empty.style.display = 'none';

  if (kind === 'thermal') updateThermalLegend(seg);
}

/** Each record was re-encoded on its own span; the bar was previously hardcoded, in Kelvin. */
function updateThermalLegend(seg) {
  const lo = document.getElementById('legend-temp-low');
  const hi = document.getElementById('legend-temp-high');
  const note = document.getElementById('legend-note');
  if (!lo || !hi) return;
  if (seg && seg.threshold_degC !== null && seg.threshold_degC !== undefined) {
    lo.textContent = `${seg.threshold_degC.toFixed(0)} °C`;
    hi.textContent = 'peak';
    if (note) note.textContent = 'Colour spans this record’s own encoded range.';
  } else {
    lo.textContent = '—';
    hi.textContent = '—';
    if (note) note.textContent = 'Encoded range not recorded for this file.';
  }
}

function setupVideoTabs() {
  const map = { rgb: 'thermal', thermal: 'rgb' };
  for (const kind of Object.keys(map)) {
    document.getElementById(`tab-btn-${kind}`).addEventListener('click', () => {
      activeVideoTab = kind;
      document.getElementById(`tab-btn-${kind}`).classList.add('active');
      document.getElementById(`tab-btn-${map[kind]}`).classList.remove('active');
      document.getElementById(`viewport-${kind}`).style.display = 'block';
      document.getElementById(`viewport-${map[kind]}`).style.display = 'none';
      document.getElementById(`video-${map[kind]}`).pause();
    });
  }
}

function setupVideoFocusToggle() {
  const btn = document.getElementById('btn-toggle-video-focus');
  const workspace = document.getElementById('active-workspace');
  if (!btn || !workspace) return;
  btn.addEventListener('click', () => {
    const focused = workspace.classList.toggle('video-focused');
    const icon = btn.querySelector('.icon');
    const text = btn.querySelector('.text');
    if (icon) icon.textContent = focused ? '⤡' : '⤢';
    if (text) text.textContent = focused ? 'Shrink video' : 'Expand video';
    // No timer: the ResizeObserver on the canvas container picks the change up.
  });
}

function setupSidebarToggle() {
  const btn = document.getElementById('btn-sidebar-toggle');
  const scrim = document.getElementById('sidebar-scrim');
  btn?.addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
  scrim?.addEventListener('click', closeSidebar);
}
function closeSidebar() { document.body.classList.remove('sidebar-open'); }

// ---------------------------------------------------------------------------
// Firebrand table — chunked, flag-aware
// ---------------------------------------------------------------------------
function populateFirebrandsTable(run) {
  const body = document.getElementById('firebrands-table-body');
  body.innerHTML = '';
  tableCursor = 0;
  document.getElementById('firebrands-count').textContent = run.firebrands.length;

  const flagged = run.firebrands.filter(b => b.flags && b.flags.length).length;
  const summary = document.getElementById('table-flag-summary');
  if (summary) {
    summary.textContent = flagged
      ? `${flagged} of ${run.firebrands.length} carry a data-quality note — hover the flag to read it.`
      : '';
  }

  if (!run.firebrands.length) {
    body.innerHTML = `<tr><td colspan="10" class="table-empty">No firebrands were recovered in this experiment.</td></tr>`;
    showNoMeshState();
    return;
  }
  appendTableChunk();
  const first = body.querySelector('tr[data-idx]');
  if (first) first.click();
}

function appendTableChunk() {
  const run = selectedRun;
  const body = document.getElementById('firebrands-table-body');
  const more = document.getElementById('table-more-row');
  if (more) more.remove();

  const end = Math.min(tableCursor + TABLE_CHUNK, run.firebrands.length);
  const fmt = (v, d = 3) => (v === null || v === undefined) ? '<span class="na">not measured</span>' : v.toFixed(d);

  for (let i = tableCursor; i < end; i++) {
    const b = run.firebrands[i];
    const tr = document.createElement('tr');
    tr.setAttribute('data-idx', String(i));
    const flagCell = b.flags && b.flags.length
      ? `<span class="flag-chip" title="${b.flag_notes.join('. ')}">${b.flags.length}</span>`
      : '';
    // A value resting on a flagged input is greyed, so a 0.001 g balance floor is not
    // presented as though it were a reading.
    const massCls = b.flags?.includes('mass_at_balance_floor') ? ' class="suspect"' : '';
    const densCls = b.flags?.includes('density_implausible') ? ' class="suspect"' : '';
    tr.innerHTML = `
      <td class="mono">${b.file_id}${flagCell}</td>
      <td>${fmt(b.volume_mm3)}</td>
      <td>${fmt(b.surface_area_mm2)}</td>
      <td>${fmt(b.v_sa_mm, 4)}</td>
      <td>${fmt(b.length_mm, 2)}</td>
      <td>${fmt(b.width_mm, 2)}</td>
      <td>${fmt(b.height_mm, 2)}</td>
      <td${massCls}>${fmt(b.mass_g, 4)}</td>
      <td${densCls}>${fmt(b.density_kg_m3, 1)}</td>
      <td><a class="row-dl" href="${b.mesh_path || '#'}" download title="Download this mesh">↓</a></td>`;
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.row-dl')) return;
      document.querySelectorAll('#firebrands-table-body tr').forEach(x => x.classList.remove('active-row'));
      tr.classList.add('active-row');
      loadDracoMesh(b.mesh_path, b);
    });
    body.appendChild(tr);
  }
  tableCursor = end;

  if (tableCursor < run.firebrands.length) {
    const tr = document.createElement('tr');
    tr.id = 'table-more-row';
    const remaining = run.firebrands.length - tableCursor;
    tr.innerHTML = `<td colspan="10" class="table-more">
      <button class="btn btn-secondary btn-small" id="btn-load-more">
        Show ${Math.min(TABLE_CHUNK, remaining)} more of ${remaining} remaining
      </button></td>`;
    body.appendChild(tr);
    tr.querySelector('#btn-load-more').addEventListener('click', appendTableChunk);
  }
}

// ---------------------------------------------------------------------------
// Three.js
// ---------------------------------------------------------------------------
/** Release GPU buffers. Without this the context degrades as a visitor browses. */
function disposeObject3D(obj) {
  if (!obj) return;
  obj.traverse?.(child => {
    if (child.geometry) child.geometry.dispose();
    const m = child.material;
    if (Array.isArray(m)) m.forEach(x => x.dispose());
    else if (m) m.dispose();
  });
  if (obj.geometry && !obj.traverse) obj.geometry.dispose();
  if (obj.material && !obj.traverse) {
    Array.isArray(obj.material) ? obj.material.forEach(x => x.dispose()) : obj.material.dispose();
  }
}

function clearSceneObjects({ keepGeometry = false } = {}) {
  for (const ref of ['currentObject', 'currentBoxHelper', 'dimensionLines']) {
    const obj = { currentObject, currentBoxHelper, dimensionLines }[ref];
    if (obj) { scene.remove(obj); disposeObject3D(obj); }
  }
  currentObject = null; currentBoxHelper = null; dimensionLines = null; midpoints = null;
  if (!keepGeometry && currentGeometry) { currentGeometry.dispose(); currentGeometry = null; }
}

function setupRenderControls() {
  const modes = { 'control-solid': 'solid', 'control-wireframe': 'wireframe', 'control-points': 'points' };
  for (const [id, mode] of Object.entries(modes)) {
    document.getElementById(id).addEventListener('click', () => {
      currentMode = mode;
      updateModeButtons();
      applyRenderMode();
    });
  }
  document.getElementById('control-reset').addEventListener('click', () => {
    if (currentObject) fitCameraToObject(currentObject);
  });
}

function updateModeButtons() {
  for (const [id, mode] of Object.entries({
    'control-solid': 'solid', 'control-wireframe': 'wireframe', 'control-points': 'points',
  })) {
    document.getElementById(id).className =
      `btn btn-small ${currentMode === mode ? 'btn-primary' : 'btn-secondary'}`;
  }
}

function initThreeViewport() {
  const container = document.getElementById('three-container');
  if (!container) return;

  const createLabel = (id) => {
    let el = document.getElementById(id);
    if (el) return el;
    el = document.createElement('div');
    el.id = id;
    el.className = 'dimension-label';
    Object.assign(el.style, {
      position: 'absolute', pointerEvents: 'none',
      transform: 'translate(-50%, -50%)', display: 'none',
    });
    container.appendChild(el);
    return el;
  };
  dimensionDivs.length = createLabel('dimension-label-length');
  dimensionDivs.width = createLabel('dimension-label-width');
  dimensionDivs.height = createLabel('dimension-label-height');

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1));
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  renderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    console.warn('WebGL context lost.');
    showCanvasMessage('Graphics context lost. Select a firebrand to restart the viewer.', false);
  }, false);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, aspectOf(container), 0.1, 1000);
  camera.position.set(20, 20, 20);

  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const d1 = new THREE.DirectionalLight(0xffffff, 0.8); d1.position.set(15, 30, 20); scene.add(d1);
  const d2 = new THREE.DirectionalLight(0xffffff, 0.4); d2.position.set(-15, -15, -15); scene.add(d2);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.minDistance = 2;
  controls.maxDistance = 200;

  const isLight = document.body.classList.contains('light-mode');
  gridHelper = new THREE.GridHelper(100, 10,
    new THREE.Color(isLight ? '#6d28d9' : '#7c3aed'),
    new THREE.Color(isLight ? '#cbd5e1' : '#242f44'));
  scene.add(gridHelper);

  // Observe the element, not the window: sidebar collapse and the focus toggle change the
  // canvas size without a window resize event.
  if (window.ResizeObserver) new ResizeObserver(onViewportResize).observe(container);
  window.addEventListener('resize', onViewportResize);

  animate();
}

function aspectOf(container) {
  const w = container.clientWidth, h = container.clientHeight;
  return (w > 0 && h > 0) ? w / h : 1;
}

function onViewportResize() {
  const container = document.getElementById('three-container');
  if (!container || !renderer || !camera) return;
  const w = container.clientWidth, h = container.clientHeight;
  // A zero dimension makes aspect Infinity and the projection matrix NaN, which blanks the
  // canvas until reload. It happens whenever the panel is hidden or mid-transition.
  if (w === 0 || h === 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function ensureRendererActive() {
  if (renderer && renderer.getContext && !renderer.getContext().isContextLost?.()) return;
  const container = document.getElementById('three-container');
  if (!container) return;
  if (renderer) { renderer.dispose(); renderer.domElement.remove(); }
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1));
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
}

function loadDracoMesh(meshPath, brand) {
  ensureRendererActive();
  currentBrand = brand;

  if (!meshPath) { showNoMeshState(); return; }

  const hud = document.getElementById('mesh-hud-overlay');
  showCanvasMessage('Loading mesh… <span id="loading-percent">0%</span>', true);
  if (hud) hud.style.display = 'none';

  clearSceneObjects();

  dracoLoader.load(
    meshPath,
    (geometry) => {
      document.getElementById('canvas-loading').style.display = 'none';
      currentGeometry = geometry;
      currentGeometry.computeVertexNormals();
      currentGeometry.computeBoundingBox();
      currentGeometry.center();

      if (gridHelper) gridHelper.position.y = currentGeometry.boundingBox.min.y;

      applyRenderMode();
      midpoints = createDimensionLines(currentGeometry.boundingBox);
      fitCameraToObject(currentObject);
      updateHud(brand);
      if (hud) hud.style.display = 'flex';
    },
    (xhr) => {
      const span = document.getElementById('loading-percent');
      if (!span) return;
      span.textContent = xhr.total > 0
        ? `${Math.round((xhr.loaded / xhr.total) * 100)}%`
        : `${Math.round(xhr.loaded / 1024)} KB`;
    },
    (error) => {
      console.error('Error loading mesh:', error);
      showCanvasMessage('This mesh could not be loaded.', false);
    }
  );
}

function updateHud(brand) {
  const set = (id, value, unit, digits) => {
    const el = document.getElementById(id);
    if (el) el.textContent = (value === null || value === undefined)
      ? 'not measured' : `${value.toFixed(digits)} ${unit}`;
  };
  set('hud-val-volume', brand.volume_mm3, 'mm³', 3);
  set('hud-val-area', brand.surface_area_mm2, 'mm²', 3);
  set('hud-val-vsa', brand.v_sa_mm, 'mm', 4);
  set('hud-val-mass', brand.mass_g, 'g', 4);
  set('hud-val-density', brand.density_kg_m3, 'kg/m³', 1);

  const uidEl = document.getElementById('hud-val-uid');
  if (uidEl) uidEl.textContent = brand.uid || brand.file_id;

  const warn = document.getElementById('hud-flags');
  if (warn) {
    if (brand.flags && brand.flags.length) {
      warn.style.display = 'block';
      warn.textContent = brand.flag_notes.join('. ') + '.';
    } else {
      warn.style.display = 'none';
    }
  }
  const dl = document.getElementById('hud-download');
  if (dl) {
    if (brand.mesh_path) { dl.href = brand.mesh_path; dl.style.display = 'inline-block'; }
    else dl.style.display = 'none';
  }
}

function showCanvasMessage(message, showSpinner = true) {
  const screen = document.getElementById('canvas-loading');
  if (!screen) return;
  screen.style.display = 'flex';
  const spinner = screen.querySelector('.spinner');
  if (spinner) spinner.style.display = showSpinner ? 'block' : 'none';
  const text = screen.querySelector('.loading-text');
  if (text) text.innerHTML = message;
}

function showNoMeshState() {
  clearSceneObjects();
  currentBrand = null;
  const hud = document.getElementById('mesh-hud-overlay');
  if (hud) hud.style.display = 'none';
  showCanvasMessage('No 3D mesh is available for this firebrand.', false);
}

function applyRenderMode() {
  if (!currentGeometry) return;
  if (currentObject) { scene.remove(currentObject); disposeObject3D(currentObject); }
  if (currentBoxHelper) { scene.remove(currentBoxHelper); disposeObject3D(currentBoxHelper); }

  const color = 0xf97316;
  if (currentMode === 'points') {
    currentObject = new THREE.Points(currentGeometry,
      new THREE.PointsMaterial({ color, size: 0.3, sizeAttenuation: true }));
  } else {
    currentObject = new THREE.Mesh(currentGeometry, new THREE.MeshStandardMaterial({
      color, roughness: 0.4, metalness: 0.1,
      wireframe: currentMode === 'wireframe', side: THREE.DoubleSide,
    }));
  }
  scene.add(currentObject);
  currentBoxHelper = new THREE.BoxHelper(currentObject, 0xf97316);
  scene.add(currentBoxHelper);
}

function createDimensionLines(bbox) {
  if (dimensionLines) { scene.remove(dimensionLines); disposeObject3D(dimensionLines); }
  dimensionLines = new THREE.Group();

  const { min, max } = bbox;
  const dx = max.x - min.x, dy = max.y - min.y, dz = max.z - min.z;
  const offset = Math.max(dx, dy, dz) * 0.15 + 1.0;
  const material = new THREE.LineBasicMaterial({ color: 0x06b6d4, transparent: true, opacity: 0.7 });

  const lStart = new THREE.Vector3(min.x, min.y - offset, max.z + offset);
  const lEnd = new THREE.Vector3(max.x, min.y - offset, max.z + offset);
  const wStart = new THREE.Vector3(min.x - offset, min.y - offset, min.z);
  const wEnd = new THREE.Vector3(min.x - offset, min.y - offset, max.z);
  const hStart = new THREE.Vector3(min.x - offset, min.y, max.z + offset);
  const hEnd = new THREE.Vector3(min.x - offset, max.y, max.z + offset);

  const addLine = (a, b) => dimensionLines.add(
    new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), material));

  addLine(lStart, lEnd); addLine(wStart, wEnd); addLine(hStart, hEnd);
  const tick = Math.max(dx, dy, dz) * 0.04 + 0.2;
  addLine(new THREE.Vector3(lStart.x, lStart.y, lStart.z - tick), new THREE.Vector3(lStart.x, lStart.y, lStart.z + tick));
  addLine(new THREE.Vector3(lEnd.x, lEnd.y, lEnd.z - tick), new THREE.Vector3(lEnd.x, lEnd.y, lEnd.z + tick));
  addLine(new THREE.Vector3(wStart.x - tick, wStart.y, wStart.z), new THREE.Vector3(wStart.x + tick, wStart.y, wStart.z));
  addLine(new THREE.Vector3(wEnd.x - tick, wEnd.y, wEnd.z), new THREE.Vector3(wEnd.x + tick, wEnd.y, wEnd.z));
  addLine(new THREE.Vector3(hStart.x - tick, hStart.y, hStart.z), new THREE.Vector3(hStart.x + tick, hStart.y, hStart.z));
  addLine(new THREE.Vector3(hEnd.x - tick, hEnd.y, hEnd.z), new THREE.Vector3(hEnd.x + tick, hEnd.y, hEnd.z));

  scene.add(dimensionLines);
  return {
    lengthMidpoint: new THREE.Vector3().addVectors(lStart, lEnd).multiplyScalar(0.5),
    widthMidpoint: new THREE.Vector3().addVectors(wStart, wEnd).multiplyScalar(0.5),
    heightMidpoint: new THREE.Vector3().addVectors(hStart, hEnd).multiplyScalar(0.5),
  };
}

function fitCameraToObject(object) {
  if (!object) return;
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const fov = camera.fov * (Math.PI / 180);
  let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2)) * 1.8;

  camera.position.set(center.x + cameraZ * 0.7, center.y + cameraZ * 0.7, center.z + cameraZ * 0.7);
  controls.target.copy(center);
  camera.near = maxDim / 100;
  camera.far = cameraZ * 10;
  camera.updateProjectionMatrix();
  controls.update();
}

function updateDimensionLabels() {
  if (!midpoints || !dimensionLines || !currentGeometry || !currentBrand) {
    Object.values(dimensionDivs).forEach(d => { if (d) d.style.display = 'none'; });
    return;
  }
  const container = document.getElementById('three-container');
  if (!container) return;
  const width = container.clientWidth, height = container.clientHeight;
  if (!width || !height) return;

  const project = (point, element, text) => {
    if (!element) return;
    const vec = point.clone().project(camera);
    if (vec.z > 1) { element.style.display = 'none'; return; }
    element.innerHTML = text;
    element.style.display = 'block';
    const rect = element.getBoundingClientRect();
    const hw = rect.width / 2, hh = rect.height / 2;
    element.style.left = `${Math.max(hw + 4, Math.min(width - hw - 4, (vec.x * 0.5 + 0.5) * width))}px`;
    element.style.top = `${Math.max(hh + 4, Math.min(height - hh - 4, (-(vec.y * 0.5) + 0.5) * height))}px`;
  };

  const bb = currentGeometry.boundingBox;
  const len = currentBrand.length_mm ?? (bb.max.x - bb.min.x);
  const wid = currentBrand.width_mm ?? (bb.max.z - bb.min.z);
  const hei = currentBrand.height_mm ?? (bb.max.y - bb.min.y);
  project(midpoints.lengthMidpoint, dimensionDivs.length, `Length ${len.toFixed(1)} mm`);
  project(midpoints.widthMidpoint, dimensionDivs.width, `Width ${wid.toFixed(1)} mm`);
  project(midpoints.heightMidpoint, dimensionDivs.height, `Height ${hei.toFixed(1)} mm`);
}

function animate() {
  requestAnimationFrame(animate);
  if (controls) controls.update();
  if (renderer && scene && camera) renderer.render(scene, camera);
  updateDimensionLabels();
}
