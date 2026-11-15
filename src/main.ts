// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.

import { LngLatBounds, Marker, Map as MlMap, setWorkerUrl, type ErrorEvent } from 'maplibre-gl';
// MapLibre 6 loads its worker from a URL; let Vite bundle it so it also works on a static host.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import {
  CRATER_FEATURES_GEOJSON_URL,
  DATA_CACHE_TAG,
  ELLIPSE_GEOJSON_URL,
  FINE_GRID_URL,
  PLACE_NAMES_GEOJSON_URL,
  SITE_NAME,
} from './config';
import {
  DataLoadError,
  loadGridMeta,
  loadLayerCatalog,
  loadMobility,
  loadOptionalGeoJson,
  loadOptionalGridMeta,
  loadOptionalKureMeta,
  loadStops,
  type Corners,
  type GlobeContextMeta,
  type GridMeta,
  type LayerDef,
  type SimpleGeoJsonCollection,
} from './data';
import { makeGridGeo } from './grid';
import { getLang, onLangChange, setLang, ui } from './i18n';
import { initLayerPanel, type GlobeBaseId, type GlobeOverlayId } from './layers';
import { loadPresets, type MissionPreset } from './presets';
import { initRoute, type RouteController } from './route';
import { attachScaleBar } from './scalebar';
import { initStops } from './stops';
import { initTraverserSelector } from './traverser';

setWorkerUrl(maplibreWorkerUrl);

type ScenarioId = 'crewed' | 'rover';

const JEZERO_CENTER: [number, number] = [77.43, 18.45];
const JEZERO_BEACON_POS: [number, number] = [77.4509, 18.4446];
const GLOBE_DEFAULT_ZOOM = 1.9;
const GLOBE_ZOOM_THRESHOLD = 6.5;
const PLACE_LABEL_MIN_ZOOM = 8.8;
const HIRISE_LOCK_BOUNDS = new LngLatBounds([77.16, 18.25], [77.65, 18.73]);
const HIRISE_MIN_ZOOM = 10.0;
const LIVE_SITE_URL = 'https://demirataalbuz-maker.github.io/martian-map/';
const LIVE_QR_SVG_URL = `${import.meta.env.BASE_URL}live_qr.svg?v=${DATA_CACHE_TAG}`;

const statusEl = document.getElementById('status')!;
let fatalErrorEl: HTMLElement | null = null;

function clearFatalError(): void {
  if (fatalErrorEl) {
    fatalErrorEl.remove();
    fatalErrorEl = null;
  }
}

function showStatus(message: string, percent?: number): void {
  if (!message) {
    statusEl.replaceChildren();
    statusEl.classList.remove('error', 'has-progress');
    statusEl.hidden = true;
    return;
  }
  const hasPct = typeof percent === 'number' && Number.isFinite(percent);
  const clampedPct = hasPct ? Math.max(0, Math.min(100, Math.round(percent!))) : 0;

  statusEl.classList.remove('error');
  statusEl.classList.toggle('has-progress', hasPct);
  statusEl.replaceChildren();

  const textSpan = document.createElement('span');
  textSpan.className = 'status-text';
  textSpan.textContent = message;
  statusEl.append(textSpan);

  if (hasPct) {
    const track = document.createElement('span');
    track.className = 'status-progress-track';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(clampedPct));
    track.setAttribute('aria-label', message);
    const fill = document.createElement('span');
    fill.className = 'status-progress-fill';
    fill.style.width = `${clampedPct}%`;
    track.append(fill);
    statusEl.append(track);
  }
  statusEl.hidden = false;
}

function showFatalError(err: unknown): void {
  showStatus('');
  clearFatalError();
  const stage = document.querySelector('.stage') ?? document.body;
  const card = document.createElement('section');
  card.className = 'error-card';
  card.setAttribute('role', 'alert');

  const title = document.createElement('h2');
  title.textContent = ui('Mission data could not be loaded', 'Görev verileri yüklenemedi');

  const isDataErr = err instanceof DataLoadError;
  const fileLine = document.createElement('p');
  fileLine.className = 'error-card-file';
  if (isDataErr && err.url) {
    fileLine.textContent = `${ui('Failed file', 'Hatalı dosya')}: ${err.url}`;
  } else {
    fileLine.textContent = ui('Startup initialization interrupted.', 'Başlangıç yüklemesi kesildi.');
  }

  const reasonLine = document.createElement('p');
  reasonLine.className = 'error-card-reason';
  const rawMsg = isDataErr ? err.reason : err instanceof Error ? err.message : String(err);
  reasonLine.textContent = `${ui('Cause', 'Neden')}: ${rawMsg}`;

  const hint = document.createElement('p');
  hint.className = 'error-card-hint';
  hint.textContent = ui(
    'Verify that all dataset files under public/veri/ are present and valid JSON/binary assets (no HTML fallback responses).',
    'public/veri/ altındaki tüm veri dosyalarının mevcut ve geçerli JSON/ikili dosya (HTML hata sayfası değil) olduğunu kontrol edin.',
  );

  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'error-retry-btn';
  retryBtn.textContent = ui('Retry loading', 'Yeniden dene');
  retryBtn.addEventListener('click', () => {
    const u = new URL(window.location.href);
    u.searchParams.set('r', String(Date.now()));
    window.location.replace(u.href);
  });

  card.append(title, fileLine, reasonLine, hint, retryBtn);
  stage.append(card);
  fatalErrorEl = card;
}

function boundsOf(corners: Corners): LngLatBounds {
  const bounds = new LngLatBounds();
  for (const c of corners) bounds.extend(c);
  return bounds;
}

function normalizePlaceLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!/\s{2,}/.test(trimmed)) return trimmed;
  // Un-space map cartography labels like "J  E  Z  E  R  O" or "N   I   L   I      P   L   A   N   U   M".
  return trimmed
    .split(/\s{4,}/)
    .map((group) => {
      const tokens = group.trim().split(/\s+/);
      return tokens.every((t) => t.length === 1) ? tokens.join('') : tokens.join(' ');
    })
    .join(' ');
}

function setDrawerOpen(open: boolean, onToggle: () => void): void {
  const panel = document.getElementById('panel')!;
  const toggleBtn = document.getElementById('panel-toggle')!;
  panel.classList.toggle('collapsed', !open);
  toggleBtn.setAttribute('aria-expanded', String(open));
  toggleBtn.classList.toggle('active', open);
  onToggle();
}

function syncStaticLabels(): void {
  const lang = getLang();
  document.documentElement.lang = lang;
  document.getElementById('lang-en')?.classList.toggle('active', lang === 'en');
  document.getElementById('lang-tr')?.classList.toggle('active', lang === 'tr');

  const setText = (id: string, en: string, tr: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = ui(en, tr);
  };
  const setAttr = (el: Element | null, attr: string, en: string, tr: string) => {
    if (el) el.setAttribute(attr, ui(en, tr));
  };

  setText('btn-globe', '🌐 Mars Globe', '🌐 Mars Küresi');
  setAttr(document.getElementById('btn-globe'), 'title', 'Mars Globe (Why Jezero?)', 'Mars Küresi (Neden Jezero?)');
  setAttr(document.getElementById('btn-globe'), 'aria-label', 'Mars Globe (Why Jezero?)', 'Mars Küresi (Neden Jezero?)');
  setText('btn-qr', '⊞ QR', '⊞ QR');
  setAttr(document.getElementById('btn-qr'), 'title', 'Show live site QR code & link', 'Canlı site QR kodunu ve linkini göster');
  setAttr(document.getElementById('btn-qr'), 'aria-label', 'Show live site QR code & link', 'Canlı site QR kodunu ve linkini göster');
  setAttr(document.getElementById('qr-popover'), 'aria-label', 'Live site QR code and link', 'Canlı site QR kodu ve bağlantısı');

  setAttr(document.getElementById('top-scenarios'), 'aria-label', 'Mission scenario', 'Görev senaryosu');
  setText('scen-crewed', 'Crewed · 20 m', 'İnsanlı · 20 m');
  setText('scen-rover', 'Rover · 5 m HiRISE', 'Rover · 5 m HiRISE');
  setAttr(document.getElementById('top-traversers'), 'aria-label', 'Traverser selector', 'Gezgin seçici');

  setText('globe-kicker', 'GLOBAL MARS CONTEXT · z0–z5', 'KÜRESEL MARS GÖRÜNÜMÜ · z0–z5');
  setText('globe-title', 'Why Jezero Crater?', 'Neden Jezero Krateri?');
  setText(
    'globe-lead',
    'Because Jezero has the richest ready-to-use multi-resolution dataset achievable in a single day, it is our study area.',
    'Bir günde en çok hazır veriye sahip bölge olduğu için çalışma alanı Jezero.',
  );
  setText('globe-base-lbl', 'Global basemap', 'Küresel altlık');
  setText('globe-ovl-lbl', 'Global screening & environment', 'Küresel uygunluk ve çevre');
  setText('btn-explore-jezero', 'Explore Jezero Study Area ▸', 'Jezero Çalışma Alanına İn ▸');

  setText('synthetic-badge', 'SYNTHETIC DATA — not real Mars data', 'SENTETİK VERİ — gerçek Mars verisi değil');
  setText('top-sample', '★ Sample', '★ Örnek');
  setAttr(document.getElementById('top-sample'), 'aria-label', 'Load sample mission', 'Örnek görevi yükle');
  setText('top-params-btn', '⚙ Params', '⚙ Parametreler');
  setAttr(document.getElementById('top-params-btn'), 'aria-label', 'What-If parameter sandbox', 'Parametre sandığı');
  setText('top-undo', '↶ Undo', '↶ Geri Al');
  setAttr(document.getElementById('top-undo'), 'aria-label', 'Undo last point', 'Son noktayı geri al');
  setText('top-clear', '✕ Clear', '✕ Temizle');
  setAttr(document.getElementById('top-clear'), 'aria-label', 'Clear route', 'Rotayı temizle');

  setAttr(document.querySelector('.lang-switch'), 'aria-label', 'Language', 'Dil');
  setAttr(document.getElementById('lang-en'), 'aria-label', 'English', 'İngilizce');
  setAttr(document.getElementById('lang-tr'), 'aria-label', 'Turkish', 'Türkçe');

  setText('panel-toggle', '☰ Details & Layers', '☰ Detay & Katmanlar');
  setText('drawer-title', 'Route, Profiles & Layers', 'Rota, Profiller ve Katmanlar');
  setAttr(document.getElementById('drawer-close'), 'aria-label', 'Close details panel', 'Detay panelini kapat');
  setText('route-heading', 'Route & landing', 'Rota ve iniş');
  setAttr(document.getElementById('route-mode'), 'aria-label', 'Start mode', 'Başlangıç modu');
  setText('mode-auto', 'Recommend landing', 'İniş öner');
  setText('mode-manual', 'Manual start', 'Elle başlangıç');
  setText('lbl-roundtrip', 'Round-trip (return to landing / start)', 'Gidiş-dönüş (inişe / başlangıca dön)');
  setText('lbl-optimize-stops', 'Optimize stop visit order (up to 7 stops)', 'Durak sırasını optimize et (en fazla 7 durak)');
  setText('lbl-stop-min', 'Work per stop (min)', 'Durak başına çalışma (dk)');
  setText('lbl-allow-nodata', 'Allow crossing unmapped (no-data) terrain', 'Haritasız (veri yok) alandan geçmeye izin ver');
  setText('route-sample', 'Try sample mission', 'Örnek görevi dene');
  setText('route-undo', 'Undo last point', 'Son noktayı geri al');
  setText('route-clear', 'Clear route', 'Rotayı temizle');
  setText('route-download', 'Download route (GeoJSON)', 'Rotayı indir (GeoJSON)');
  setText('route-compare-summary', 'Compare all traversers on this mission', 'Tüm araçları bu görevde karşılaştır');
  setText('layers-heading', 'Layers', 'Katmanlar');

  setAttr(document.getElementById('map'), 'aria-label', 'Layered map of the traverse area', 'Çalışma alanı katmanlı haritası');
  setAttr(document.getElementById('globe-card'), 'aria-label', 'Global Mars context and Jezero selection', 'Küresel Mars bağlamı ve Jezero seçimi');
  setAttr(document.getElementById('globe-base-pills'), 'aria-label', 'Global basemap', 'Küresel altlık');
  setAttr(document.getElementById('globe-ovl-pills'), 'aria-label', 'Global screening overlay', 'Küresel uygunluk katmanı');
  setAttr(document.getElementById('params-popover'), 'aria-label', 'What-If parameter sandbox', 'Parametre sandığı');
  setAttr(document.getElementById('mission-dock'), 'aria-label', 'Mission summary and live fault simulator', 'Görev özeti ve arıza simülatörü');
  setAttr(document.getElementById('sim-scrub'), 'aria-label', 'Mission timeline scrub', 'Görev zaman çizelgesi');
  setAttr(document.getElementById('sim-speed'), 'title', 'Playback speed', 'Oynatma hızı');

  const emptyPromptEl = document.getElementById('empty-prompt');
  if (emptyPromptEl) {
    emptyPromptEl.innerHTML = ui(
      'Tap a science stop (◆) or click terrain to plan · <strong>★ Sample</strong> for 1-click demo',
      'Bir bilim durağına (◆) dokunun veya haritaya tıklayın · tek tıkla demo için <strong>★ Örnek</strong>',
    );
  }
}

function initQrPopover(): void {
  const btn = document.getElementById('btn-qr') as HTMLButtonElement | null;
  const pop = document.getElementById('qr-popover');
  if (!btn || !pop) return;

  let isOpen = false;
  let copiedResetTimer: number | undefined;

  const setOpen = (open: boolean): void => {
    isOpen = open;
    pop.hidden = !open;
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-expanded', String(open));
  };

  const render = (): void => {
    pop.replaceChildren();

    const head = document.createElement('div');
    head.className = 'qr-popover-head';
    const title = document.createElement('strong');
    title.className = 'qr-popover-title';
    title.textContent = ui('Live Site QR & Link', 'Canlı Site QR & Bağlantı');

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'drawer-close';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', ui('Close QR dialog', 'QR penceresini kapat'));
    closeBtn.addEventListener('click', () => setOpen(false));
    head.append(title, closeBtn);

    const sub = document.createElement('p');
    sub.className = 'qr-popover-sub';
    sub.textContent = ui(
      'Scan with any phone camera to open Marswalk Map directly (no login required):',
      'Telefon kamerasıyla okutup Marswalk Map sitesini doğrudan açın (giriş gerekmez):',
    );

    const imgWrap = document.createElement('div');
    imgWrap.className = 'qr-popover-img-wrap';
    const img = document.createElement('img');
    img.className = 'qr-popover-img';
    img.src = LIVE_QR_SVG_URL;
    img.width = 196;
    img.height = 196;
    img.alt = ui('QR code for Marswalk Map live site', 'Marswalk Map canlı site QR kodu');
    imgWrap.append(img);

    const urlLink = document.createElement('a');
    urlLink.className = 'qr-popover-url';
    urlLink.href = LIVE_SITE_URL;
    urlLink.target = '_blank';
    urlLink.rel = 'noopener noreferrer';
    urlLink.textContent = LIVE_SITE_URL;

    const actions = document.createElement('div');
    actions.className = 'qr-popover-actions';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'qr-copy-btn';
    copyBtn.textContent = ui('Copy Link', 'Linki Kopyala');
    copyBtn.addEventListener('click', () => {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard
          .writeText(LIVE_SITE_URL)
          .then(() => {
            copyBtn.textContent = ui('Copied ✓', 'Kopyalandı ✓');
            copyBtn.classList.add('copied');
            window.clearTimeout(copiedResetTimer);
            copiedResetTimer = window.setTimeout(() => {
              copyBtn.textContent = ui('Copy Link', 'Linki Kopyala');
              copyBtn.classList.remove('copied');
            }, 1800);
          })
          .catch(() => {
            window.open(LIVE_SITE_URL, '_blank', 'noopener,noreferrer');
          });
      } else {
        window.open(LIVE_SITE_URL, '_blank', 'noopener,noreferrer');
      }
    });
    actions.append(copyBtn);

    pop.append(head, sub, imgWrap, urlLink, actions);
  };

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    setOpen(!isOpen);
  });

  document.addEventListener('click', (event) => {
    if (!isOpen) return;
    const target = event.target as Node | null;
    if (target && (pop.contains(target) || btn.contains(target))) return;
    setOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (isOpen && event.key === 'Escape') {
      setOpen(false);
      btn.focus();
    }
  });

  onLangChange(render);
  render();
}

function initChromeControllers(onDrawerToggle: () => void): { openDrawer: () => void } {
  const panel = document.getElementById('panel')!;
  const toggleBtn = document.getElementById('panel-toggle')!;
  const closeBtn = document.getElementById('drawer-close')!;
  const langEnBtn = document.getElementById('lang-en')!;
  const langTrBtn = document.getElementById('lang-tr')!;

  toggleBtn.addEventListener('click', () => {
    const currentlyCollapsed = panel.classList.contains('collapsed');
    setDrawerOpen(currentlyCollapsed, onDrawerToggle);
  });
  closeBtn.addEventListener('click', () => setDrawerOpen(false, onDrawerToggle));

  langEnBtn.addEventListener('click', () => setLang('en'));
  langTrBtn.addEventListener('click', () => setLang('tr'));

  onLangChange(syncStaticLabels);
  syncStaticLabels();
  initQrPopover();

  return {
    openDrawer: () => setDrawerOpen(true, onDrawerToggle),
  };
}

/**
 * "★ Sample" preset menu: one-click demo missions grouped by traverser. Each entry
 * shows the outcome observed when the preset was verified (GO / CAUTION / NO-GO) as
 * a hint; the real outcome is always recomputed from the terrain when it is loaded.
 */
function initSampleMenu(): {
  toggle: () => boolean;
  setPresets: (presets: MissionPreset[], onPick: (preset: MissionPreset) => void) => void;
} {
  const btn = document.getElementById('top-sample') as HTMLButtonElement | null;
  const host = document.getElementById('params-popover')?.parentElement ?? null;
  let presets: MissionPreset[] = [];
  let pick: ((preset: MissionPreset) => void) | null = null;
  let menu: HTMLElement | null = null;

  const groupTitle = (gezgin: string): string =>
    gezgin === 'yuruyen_insan'
      ? ui('Walking astronaut', 'Yürüyen astronot')
      : gezgin === 'roverli_insan'
        ? ui('Crewed rover', 'Mürettebatlı rover')
        : gezgin === 'rover'
          ? ui('Uncrewed rover · 5 m HiRISE', 'İnsansız rover · 5 m HiRISE')
          : gezgin;

  const close = (): void => {
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    btn?.setAttribute('aria-expanded', 'false');
  };

  const render = (): void => {
    if (!menu) return;
    menu.replaceChildren();
    menu.setAttribute('aria-label', ui('Sample missions', 'Örnek görevler'));
    const head = document.createElement('div');
    head.className = 'sample-menu-head';
    const title = document.createElement('strong');
    title.textContent = ui('Sample missions', 'Örnek görevler');
    const note = document.createElement('span');
    note.textContent = ui(
      'Outcomes are computed live from the terrain and limits; nothing is forced.',
      'Sonuçlar arazi ve limitlerden canlı hesaplanır; hiçbiri zorlanmaz.',
    );
    head.append(title, note);
    menu.append(head);

    const order: string[] = [];
    for (const p of presets) if (!order.includes(p.gezgin)) order.push(p.gezgin);
    for (const gezgin of order) {
      const group = document.createElement('div');
      group.className = 'sample-menu-group';
      group.setAttribute('role', 'group');
      const label = document.createElement('div');
      label.className = 'sample-menu-group-title';
      label.textContent = groupTitle(gezgin);
      group.append(label);
      for (const p of presets.filter((x) => x.gezgin === gezgin)) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'sample-menu-item';
        const badge = document.createElement('span');
        badge.className = 'sample-menu-badge';
        badge.dataset.decision = p.beklenen;
        badge.textContent = p.beklenen;
        const text = document.createElement('span');
        text.className = 'sample-menu-text';
        const name = document.createElement('span');
        name.className = 'sample-menu-name';
        name.textContent = ui(p.ad_en, p.ad_tr);
        const desc = document.createElement('span');
        desc.className = 'sample-menu-desc';
        desc.textContent = ui(p.aciklama_en, p.aciklama_tr);
        text.append(name, desc);
        item.append(badge, text);
        item.addEventListener('click', () => {
          close();
          pick?.(p);
        });
        group.append(item);
      }
      menu.append(group);
    }
  };

  const ensureMenu = (): HTMLElement | null => {
    if (menu || !host) return menu;
    menu = document.createElement('div');
    menu.id = 'sample-menu';
    menu.className = 'sample-menu';
    menu.setAttribute('role', 'dialog');
    menu.hidden = true;
    host.append(menu);
    document.addEventListener('pointerdown', (e) => {
      const target = e.target as Node | null;
      if (!menu || menu.hidden || !target) return;
      if (menu.contains(target) || btn?.contains(target)) return;
      close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
    onLangChange(render);
    return menu;
  };

  return {
    toggle() {
      // No presets file: fall back to the single built-in sample mission.
      if (presets.length === 0 || !pick) return false;
      const node = ensureMenu();
      if (!node) return false;
      if (node.hidden) {
        render();
        node.hidden = false;
        btn?.setAttribute('aria-expanded', 'true');
      } else {
        close();
      }
      return true;
    },
    setPresets(next, onPick) {
      presets = next;
      pick = onPick;
      if (btn && next.length > 0) {
        btn.setAttribute('aria-haspopup', 'dialog');
        btn.setAttribute('aria-expanded', 'false');
      }
      if (menu && !menu.hidden) render();
    },
  };
}

function readNum(obj: unknown, path: string[]): number | null {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : null;
}

function initGlobeCard(
  globeMeta: GlobeContextMeta,
  catalogLayers: LayerDef[],
  onSelectBase: (id: GlobeBaseId) => void,
  onSelectOverlay: (id: GlobeOverlayId) => void,
  onExplore: () => void,
): void {
  const statsRoot = document.getElementById('globe-stats');
  const basePillsRoot = document.getElementById('globe-base-pills');
  const ovlPillsRoot = document.getElementById('globe-ovl-pills');
  const attributionEl = document.getElementById('globe-attribution');
  const exploreBtn = document.getElementById('btn-explore-jezero');

  let activeBase: GlobeBaseId = 'kure_viking_renkli';
  let activeOverlay: GlobeOverlayId = 'none';

  const crewedPassPct = ((readNum(globeMeta.kure, ['insanli', 'alan_orani', 'uygun']) ?? 0.4841) * 100).toFixed(1);
  const roboticPassPct = ((readNum(globeMeta.kure, ['robotik', 'alan_orani', 'uygun']) ?? 0.1822) * 100).toFixed(1);
  const jezElevM = Math.round(readNum(globeMeta.radyasyon, ['jezero', 'mola_m']) ?? -2636);
  const jezShield = (readNum(globeMeta.radyasyon, ['jezero', 'kolon_g_cm2']) ?? 19.2).toFixed(1);
  const jezDose = Math.round(readNum(globeMeta.radyasyon, ['jezero', 'doz_tahmini_uGy_gun']) ?? 248);
  const shieldThickerPct = (readNum(globeMeta.radyasyon, ['jezero', 'mars_yuzeyinin_yuzde_kaci_daha_ince_kalkanli']) ?? 69.6).toFixed(1);
  const dustJezeroPct = ((readNum(globeMeta.tozFirtinasi, ['jezero_firtina_sol_orani']) ?? 0.0021) * 100).toFixed(2);
  const dustMedianPct = ((readNum(globeMeta.tozFirtinasi, ['kuresel_medyan']) ?? 0.0223) * 100).toFixed(2);
  const dustCalmerPct = Math.round(100 - (readNum(globeMeta.tozFirtinasi, ['mars_yuzeyinin_yuzde_kaci_daha_az_firtinali']) ?? 18));

  const renderCard = (): void => {
    if (statsRoot) {
      statsRoot.replaceChildren();
      const chips: [string, string][] = [
        [ui('Crewed global gate', 'İnsanlı küresel eleme'), ui(`${crewedPassPct}% Mars · Jezero PASS`, `%${crewedPassPct} Mars · Jezero UYGUN`)],
        [ui('Robotic global gate', 'Robotik küresel eleme'), ui(`${roboticPassPct}% Mars · Jezero PASS`, `%${roboticPassPct} Mars · Jezero UYGUN`)],
        [
          ui('Atmospheric shield', 'Atmosfer kalkanı'),
          ui(`${jezShield} g/cm² (${jezElevM} m) · ~${jezDose} µGy/d (> ${shieldThickerPct}%)`, `${jezShield} g/cm² (${jezElevM} m) · ~${jezDose} µGy/gün (> %${shieldThickerPct})`),
        ],
        [
          ui('Dust storm sols', 'Toz fırtınası oranı'),
          ui(`${dustJezeroPct}% vs ${dustMedianPct}% median (calmer than ${dustCalmerPct}%)`, `%${dustJezeroPct} / %${dustMedianPct} medyan (%${dustCalmerPct} daha sakin)`),
        ],
      ];
      for (const [label, val] of chips) {
        const chip = document.createElement('div');
        chip.className = 'globe-stat-chip';
        const l = document.createElement('span');
        l.className = 'globe-stat-label';
        l.textContent = label;
        const v = document.createElement('span');
        v.className = 'globe-stat-val';
        v.textContent = val;
        chip.append(l, v);
        statsRoot.append(chip);
      }
    }

    if (basePillsRoot) {
      basePillsRoot.replaceChildren();
      const bases: [GlobeBaseId, string, string][] = [
        ['kure_viking_renkli', 'Viking Color (USGS)', 'Viking Renkli (USGS)'],
        ['kure_yukseklik', 'MOLA Elevation', 'MOLA Yükseklik'],
        ['kure_albedo', 'TES Albedo', 'TES Albedo'],
        ['kure_termal_atalet', 'Thermal Inertia', 'Termal Atalet'],
      ];
      for (const [id, en, tr] of bases) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `globe-pill${activeBase === id ? ' active' : ''}`;
        btn.textContent = ui(en, tr);
        btn.addEventListener('click', () => {
          activeBase = id;
          onSelectBase(id);
          renderCard();
        });
        basePillsRoot.append(btn);
      }
    }

    if (ovlPillsRoot) {
      ovlPillsRoot.replaceChildren();
      const overlays: [GlobeOverlayId, string, string][] = [
        ['kure_uygunluk_insanli', 'Crewed Screening', 'İnsanlı Eleme'],
        ['kure_uygunluk_robotik', 'Robotic Screening', 'Robotik Eleme'],
        ['kure_atmosfer_kalkani', 'Radiation Shield', 'Radyasyon Kalkanı'],
        ['kure_toz_firtinasi', 'Dust Storms', 'Toz Fırtınaları'],
        ['none', 'None', 'Yok'],
      ];
      for (const [id, en, tr] of overlays) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `globe-pill${activeOverlay === id ? ' active' : ''}`;
        btn.textContent = ui(en, tr);
        btn.addEventListener('click', () => {
          activeOverlay = id;
          onSelectOverlay(id);
          renderCard();
        });
        ovlPillsRoot.append(btn);
      }
    }

    if (attributionEl) {
      attributionEl.replaceChildren();
      const layerMap = new Map(catalogLayers.map((l) => [l.id, l]));
      const baseDef = layerMap.get(activeBase);
      if (baseDef) {
        const srcTxt = baseDef.kaynak || ui('not stated', 'belirtilmedi');
        const licTxt = baseDef.lisans ? ` · ${ui('License', 'Lisans')}: ${baseDef.lisans}` : '';
        const line = document.createElement('div');
        line.textContent = `${ui('Basemap source', 'Altlık kaynağı')}: ${srcTxt}${licTxt}`;
        attributionEl.append(line);
      }
      if (activeOverlay !== 'none') {
        const ovlDef = layerMap.get(activeOverlay);
        if (ovlDef && ovlDef.kaynak) {
          const licTxt = ovlDef.lisans ? ` · ${ovlDef.lisans}` : '';
          const line = document.createElement('div');
          line.textContent = `${ui('Overlay source', 'Katman kaynağı')}: ${ovlDef.kaynak}${licTxt}`;
          attributionEl.append(line);
        }
      }
    }
  };

  exploreBtn?.addEventListener('click', onExplore);
  onLangChange(renderCard);
  renderCard();
}

function addVectorDecorations(
  map: MlMap,
  ellipseGeo: SimpleGeoJsonCollection | null,
  cratersGeo: SimpleGeoJsonCollection | null,
  fineGrid: GridMeta | null,
): string[] {
  const layerIds: string[] = [];
  type GeoJsonInput = Extract<import('maplibre-gl').SourceSpecification, { type: 'geojson' }>['data'];

  if (ellipseGeo) {
    map.addSource('inis-elipsi', { type: 'geojson', data: ellipseGeo as unknown as GeoJsonInput });
    map.addLayer({
      id: 'inis-elipsi-fill',
      type: 'fill',
      source: 'inis-elipsi',
      layout: { visibility: 'none' },
      paint: { 'fill-color': '#ffd166', 'fill-opacity': 0.05 },
    });
    map.addLayer({
      id: 'inis-elipsi-line',
      type: 'line',
      source: 'inis-elipsi',
      layout: { visibility: 'none' },
      paint: { 'line-color': '#ffd166', 'line-width': 1.4, 'line-dasharray': [3, 2], 'line-opacity': 0.72 },
    });
    layerIds.push('inis-elipsi-fill', 'inis-elipsi-line');
  }

  if (cratersGeo) {
    map.addSource('konum-ozellikleri', { type: 'geojson', data: cratersGeo as unknown as GeoJsonInput });
    map.addLayer({
      id: 'crater-features-circle',
      type: 'circle',
      source: 'konum-ozellikleri',
      minzoom: 11.5,
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': 3.5,
        'circle-color': 'rgba(255, 209, 102, 0.06)',
        'circle-stroke-color': 'rgba(243, 233, 226, 0.42)',
        'circle-stroke-width': 1,
      },
    });
    layerIds.push('crater-features-circle');
  }

  if (fineGrid) {
    const [nw, ne, se, sw] = fineGrid.koseler;
    map.addSource('hirise-study-box', {
      type: 'geojson',
      data: {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [nw, ne, se, sw, nw] },
      },
    });
    map.addLayer({
      id: 'hirise-study-box-line',
      type: 'line',
      source: 'hirise-study-box',
      layout: { visibility: 'none' },
      paint: { 'line-color': '#4fd8ff', 'line-width': 1.8, 'line-dasharray': [3, 2], 'line-opacity': 0.85 },
    });
  }

  return layerIds;
}

async function start(): Promise<void> {
  let routeRef: RouteController | null = null;
  const chrome = initChromeControllers(() => routeRef?.syncCollapsedAlert());
  clearFatalError();
  const presetsPromise = loadPresets();
  const sampleMenu = initSampleMenu();

  let jsonDone = 0;
  const totalJson = 9;
  const trackJson = <T>(p: Promise<T>): Promise<T> =>
    p.then((res) => {
      jsonDone++;
      const pct = Math.round((jsonDone / totalJson) * 18);
      showStatus(ui(`Loading metadata & configs… ${pct}%`, `Meta veri ve ayarlar yükleniyor… %${pct}`), pct);
      return res;
    });
  showStatus(ui('Loading metadata & configs… 2%', 'Meta veri ve ayarlar yükleniyor… %2'), 2);

  const [catalog, ctxGrid, fineGrid, mobility, stopsCatalog, globeMeta, ellipseGeo, placesGeo, cratersGeo] = await Promise.all([
    trackJson(loadLayerCatalog()),
    trackJson(loadGridMeta()),
    trackJson(loadOptionalGridMeta(FINE_GRID_URL)),
    trackJson(loadMobility()),
    trackJson(loadStops()),
    trackJson(loadOptionalKureMeta()),
    trackJson(loadOptionalGeoJson(ELLIPSE_GEOJSON_URL)),
    trackJson(loadOptionalGeoJson(PLACE_NAMES_GEOJSON_URL)),
    trackJson(loadOptionalGeoJson(CRATER_FEATURES_GEOJSON_URL)),
  ]);
  showStatus(ui('Initializing Mars map view… 20%', 'Mars harita görünümü hazırlanıyor… %20'), 20);

  const ctxSiteName = catalog.siteName ?? ctxGrid.siteName ?? SITE_NAME;
  const siteNameEl = document.getElementById('site-name')!;
  const syncSiteLabel = (scenario: ScenarioId): void => {
    siteNameEl.textContent =
      scenario === 'rover'
        ? ui('Jezero crater · 5 m HiRISE (~20×21 km)', 'Jezero krateri · 5 m HiRISE (~20×21 km)')
        : ctxSiteName;
  };
  syncSiteLabel('crewed');

  const synthetic =
    catalog.synthetic || ctxGrid.synthetic || Boolean(fineGrid?.synthetic) || mobility.synthetic || stopsCatalog.synthetic;
  document.getElementById('synthetic-badge')!.hidden = !synthetic;

  const ctxGeo = makeGridGeo(ctxGrid);
  const fineGeo = fineGrid ? makeGridGeo(fineGrid) : null;
  const ctxBounds = boundsOf(ctxGrid.koseler);
  const fineBounds = fineGrid ? boundsOf(fineGrid.koseler) : null;

  const map = new MlMap({
    container: 'map',
    // No Earth basemap service: start centered on Mars in 3D globe projection.
    style: {
      version: 8,
      sources: {},
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0b090c' } }],
    },
    center: JEZERO_CENTER,
    zoom: GLOBE_DEFAULT_ZOOM,
    minZoom: 1,
    maxZoom: 22,
    renderWorldCopies: false,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();

  const btnGlobe = document.getElementById('btn-globe') as HTMLButtonElement | null;
  const scenCrewedBtn = document.getElementById('scen-crewed') as HTMLButtonElement | null;
  const scenRoverBtn = document.getElementById('scen-rover') as HTMLButtonElement | null;
  const globeCard = document.getElementById('globe-card');

  if (scenRoverBtn && !fineGrid) scenRoverBtn.disabled = true;

  map.on('load', () => {
    try {
      showStatus('');
      map.setProjection({ type: 'globe' });

      const layerCtrl = initLayerPanel(map, catalog.layers, document.getElementById('layer-list')!);
      const localVectorLayerIds = addVectorDecorations(map, ellipseGeo, cratersGeo, fineGrid);

      // Jezero pulsing globe beacon
      const beaconBtn = document.createElement('button');
      beaconBtn.type = 'button';
      beaconBtn.className = 'jezero-beacon';
      const beaconRing = document.createElement('span');
      beaconRing.className = 'jezero-beacon-ring';
      const beaconText = document.createElement('span');
      beaconText.className = 'jezero-beacon-label';
      const updateBeaconLabel = () => {
        beaconText.textContent = ui('Jezero Crater · Study Area', 'Jezero Krateri · Çalışma Alanı');
        beaconBtn.setAttribute('aria-label', ui('Fly to Jezero Crater study area', 'Jezero Krateri çalışma alanına uç'));
      };
      updateBeaconLabel();
      onLangChange(updateBeaconLabel);
      beaconBtn.append(beaconRing, beaconText);
      const jezeroBeacon = new Marker({ element: beaconBtn, anchor: 'left' }).setLngLat(JEZERO_BEACON_POS).addTo(map);

      // GeoJSON place-name labels (HTML markers avoid requiring MapLibre glyph PBF fonts)
      const placeMarkers: { marker: Marker; lonLat: [number, number] }[] = [];
      if (placesGeo) {
        for (const f of placesGeo.features) {
          if (f.geometry?.type !== 'Point' || !Array.isArray(f.geometry.coordinates)) continue;
          const rawText = typeof f.properties?.TextString === 'string' ? f.properties.TextString : '';
          const text = normalizePlaceLabel(rawText);
          if (!text) continue;
          const fontSize = typeof f.properties?.FontSize === 'number' ? f.properties.FontSize : 10;
          const lon = Number(f.geometry.coordinates[0]);
          const lat = Number(f.geometry.coordinates[1]);
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
          const labelEl = document.createElement('div');
          labelEl.className = `place-label-marker${fontSize >= 14 ? ' major' : ''}`;
          labelEl.textContent = text;
          labelEl.style.display = 'none';
          const marker = new Marker({ element: labelEl }).setLngLat([lon, lat]).addTo(map);
          placeMarkers.push({ marker, lonLat: [lon, lat] });
        }
      }

      const selector = initTraverserSelector(
        mobility.traversers,
        mobility.landingCraftCrewed ?? mobility.landingCraft,
        document.getElementById('route-traverser')!,
        (t) => routeRef?.setTraverser(t),
        ctxGrid,
        {
          ground: mobility.ground,
          topTraversersRoot: document.getElementById('top-traversers')!,
          paramsPopoverRoot: document.getElementById('params-popover')!,
          paramsButton: document.getElementById('top-params-btn') as HTMLButtonElement,
          onTraversersUpdated: (effective, active) => routeRef?.setTraversersAndActive(effective, active),
        },
      );

      let isGlobe = true;
      let activeScenario: ScenarioId = 'crewed';
      let programmaticMove = false;
      let cameraSeq = 0;
      let lastProjection: 'globe' | 'mercator' = 'globe';

      const setProjectionType = (nextProj: 'globe' | 'mercator'): void => {
        if (lastProjection === nextProj) return;
        lastProjection = nextProj;
        map.setProjection({ type: nextProj });
      };

      const route = initRoute(map, ctxGrid, ctxGeo, mobility.traversers[0], document.getElementById('route-panel')!, {
        synthetic,
        ground: mobility.ground,
        landingCraft: mobility.landingCraftCrewed ?? mobility.landingCraft,
        traversers: selector.getEffectiveTraversers(),
        stops: stopsCatalog.stops,
        initialGlobeMode: true,
        onSelectTraverser: (id) => selector.selectById(id),
        onRequireLocalView: () => enterLocalView(),
        onStartupProgress: (text, percent) => showStatus(text, percent),
        onFatalError: (message) => showFatalError(new Error(message)),
        topControls: {
          sampleBtn: document.getElementById('top-sample') as HTMLButtonElement,
          undoBtn: document.getElementById('top-undo') as HTMLButtonElement,
          clearBtn: document.getElementById('top-clear') as HTMLButtonElement,
          emptyPrompt: document.getElementById('empty-prompt'),
          missionDock: document.getElementById('mission-dock'),
          onOpenDrawer: chrome.openDrawer,
          onSampleClick: () => sampleMenu.toggle(),
        },
      });
      routeRef = route;

      const stopsCtrl = initStops(map, stopsCatalog.stops, (stop) => route.addPoint(stop.konum, stop.ad_en));
      const scaleBar = attachScaleBar(map, ctxGrid, document.getElementById('scalebar')!);

      const syncPlaceLabelsVisibility = (): void => {
        const showLabels = !isGlobe && map.getZoom() >= PLACE_LABEL_MIN_ZOOM;
        for (const p of placeMarkers) {
          const inScenario =
            showLabels && (activeScenario !== 'rover' || !fineGeo || fineGeo.lonLatToIndex(p.lonLat[0], p.lonLat[1]) !== null);
          p.marker.getElement().style.display = inScenario ? '' : 'none';
        }
      };

      const syncMapDecorations = (): void => {
        if (globeCard) globeCard.hidden = !isGlobe;
        btnGlobe?.classList.toggle('active', isGlobe);
        scenCrewedBtn?.classList.toggle('active', !isGlobe && activeScenario === 'crewed');
        scenRoverBtn?.classList.toggle('active', !isGlobe && activeScenario === 'rover');
        beaconBtn.style.display = isGlobe ? '' : 'none';

        if (map.getLayer('background')) {
          map.setPaintProperty('background', 'background-color', isGlobe ? '#0b090c' : '#14100e');
        }
        for (const id of localVectorLayerIds) {
          if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', isGlobe ? 'none' : 'visible');
        }
        if (map.getLayer('hirise-study-box-line')) {
          map.setLayoutProperty('hirise-study-box-line', 'visibility', !isGlobe && activeScenario === 'rover' ? 'visible' : 'none');
        }

        syncPlaceLabelsVisibility();
        layerCtrl.syncScenario(activeScenario, isGlobe);
        scaleBar.setVisible(!isGlobe);
        route.setGlobeMode(isGlobe);

        if (isGlobe) {
          stopsCtrl.setFilter(() => false);
        } else if (activeScenario === 'rover' && fineGeo) {
          stopsCtrl.setFilter((stop) => fineGeo.lonLatToIndex(stop.konum[0], stop.konum[1]) !== null);
        } else {
          stopsCtrl.setFilter(null);
        }
      };

      const applyScenarioBounds = (scenario: ScenarioId): void => {
        if (isGlobe || scenario !== 'rover' || !fineGrid) {
          map.setMaxBounds(null);
          map.setMinZoom(1);
          return;
        }
        map.setMaxBounds(HIRISE_LOCK_BOUNDS);
        map.setMinZoom(HIRISE_MIN_ZOOM);
      };

      const enterLocalView = (targetScenario: ScenarioId = activeScenario): void => {
        const fromGlobe = isGlobe;
        const seq = ++cameraSeq;
        programmaticMove = true;
        map.setMaxBounds(null);
        map.setMinZoom(1);
        isGlobe = false;
        syncMapDecorations();

        const targetBounds = targetScenario === 'rover' && fineBounds ? fineBounds : ctxBounds;
        if (fromGlobe) {
          const cam = map.cameraForBounds(targetBounds, { padding: 36 });
          map.once('moveend', () => {
            if (seq !== cameraSeq) return;
            setProjectionType('mercator');
            map.fitBounds(targetBounds, { padding: 36, duration: 0 });
            programmaticMove = false;
            applyScenarioBounds(activeScenario);
            syncPlaceLabelsVisibility();
          });
          map.flyTo({
            center: cam ? cam.center : JEZERO_CENTER,
            zoom: cam?.zoom ?? (targetScenario === 'rover' ? 11.2 : 9.3),
            bearing: 0,
            pitch: 0,
            duration: 2200,
            curve: 1.42,
            essential: true,
          });
        } else {
          setProjectionType('mercator');
          map.once('moveend', () => {
            if (seq !== cameraSeq) return;
            programmaticMove = false;
            applyScenarioBounds(activeScenario);
            syncPlaceLabelsVisibility();
          });
          map.fitBounds(targetBounds, { padding: 36, duration: 700, essential: true });
        }
      };

      const openGlobeView = (): void => {
        const seq = ++cameraSeq;
        programmaticMove = true;
        map.setMaxBounds(null);
        map.setMinZoom(1);
        isGlobe = true;
        setProjectionType('globe');
        syncMapDecorations();
        map.once('moveend', () => {
          if (seq !== cameraSeq) return;
          programmaticMove = false;
        });
        map.flyTo({ center: JEZERO_CENTER, zoom: GLOBE_DEFAULT_ZOOM, duration: 1600, curve: 1.35, essential: true });
      };

      const switchScenario = (next: ScenarioId): void => {
        if (next === 'rover' && (!fineGrid || !fineGeo)) return;
        const scenarioChanged = activeScenario !== next;
        activeScenario = next;
        syncSiteLabel(next);

        if (isGlobe) {
          enterLocalView(next);
        } else if (scenarioChanged) {
          const seq = ++cameraSeq;
          programmaticMove = true;
          map.setMaxBounds(null);
          map.setMinZoom(1);
          const targetBounds = next === 'rover' && fineBounds ? fineBounds : ctxBounds;
          map.once('moveend', () => {
            if (seq !== cameraSeq) return;
            programmaticMove = false;
            applyScenarioBounds(activeScenario);
            syncPlaceLabelsVisibility();
          });
          map.fitBounds(targetBounds, { padding: 36, duration: 550, essential: true });
        }

        if (scenarioChanged) {
          const targetGrid = next === 'rover' && fineGrid ? fineGrid : ctxGrid;
          const targetGeo = next === 'rover' && fineGeo ? fineGeo : ctxGeo;
          const targetLander =
            next === 'rover'
              ? mobility.landingCraftRobotic ?? mobility.landingCraft
              : mobility.landingCraftCrewed ?? mobility.landingCraft;
          const { active, effectiveList } = selector.setScenarioContext(next, targetGrid, targetLander);
          scaleBar.setGrid(targetGrid);
          route.setScenario(next, targetGrid, targetGeo, targetLander, active, effectiveList);
        }

        syncMapDecorations();
      };

      // Demo mission presets: switch to the preset's scenario and traverser, then plan it.
      const runPreset = (preset: MissionPreset): void => {
        if (preset.senaryo === 'rover' && (!fineGrid || !fineGeo)) return;
        switchScenario(preset.senaryo);
        route.loadPreset(preset, () => selector.selectById(preset.gezgin));
      };
      void presetsPromise.then((presets) => sampleMenu.setPresets(presets, runPreset));
      if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>).__marswalk = { runPreset, summary: () => route.getLastSummary() };
      }

      beaconBtn.addEventListener('click', () => enterLocalView());
      btnGlobe?.addEventListener('click', openGlobeView);
      scenCrewedBtn?.addEventListener('click', () => switchScenario('crewed'));
      scenRoverBtn?.addEventListener('click', () => switchScenario('rover'));

      initGlobeCard(
        globeMeta,
        catalog.layers,
        (baseId) => layerCtrl.setGlobeBase(baseId),
        (overlayId) => layerCtrl.setGlobeSuitability(overlayId),
        () => enterLocalView(),
      );

      map.on('zoomend', () => {
        syncPlaceLabelsVisibility();
        if (programmaticMove) return;
        const z = map.getZoom();
        if (isGlobe && z >= GLOBE_ZOOM_THRESHOLD) {
          isGlobe = false;
          setProjectionType('mercator');
          syncMapDecorations();
          applyScenarioBounds(activeScenario);
        } else if (!isGlobe && activeScenario === 'crewed' && z < GLOBE_ZOOM_THRESHOLD - 0.5) {
          isGlobe = true;
          map.setMaxBounds(null);
          setProjectionType('globe');
          syncMapDecorations();
        }
      });

      onLangChange(() => {
        syncSiteLabel(activeScenario);
      });

      // Keep Jezero marker from causing unused-var lint and keep clean startup sync
      void jezeroBeacon;
      syncMapDecorations();
    } catch (err: unknown) {
      console.error(err);
      showFatalError(err);
    }
  });

  map.on('error', (e: ErrorEvent) => {
    const msg = e.error?.message;
    if (msg && !/404/.test(msg)) console.warn('MapLibre notice:', msg);
  });

  let userMoved = false;
  map.on('movestart', (e) => {
    if ('originalEvent' in e && e.originalEvent) userMoved = true;
  });
  map.on('resize', () => {
    if (!userMoved && map.getZoom() < GLOBE_ZOOM_THRESHOLD) {
      map.jumpTo({ center: JEZERO_CENTER, zoom: GLOBE_DEFAULT_ZOOM });
    }
  });
}

start().catch((err: unknown) => {
  console.error(err);
  showFatalError(err);
});
