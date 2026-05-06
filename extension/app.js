/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];
let displayedTabs = [];
let currentWindowId = null;
let tabScope = 'current';
let allWindowsView = 'windows';
let pinnedTabKeys = new Set();
let activeWindowsDragType = '';
let activeWindowsDragSourceId = null;

const PINNED_TABS_STORAGE_KEY = 'pinnedTabs';
const WINDOW_ORDER_STORAGE_KEY = 'windowOrder';

function normalizeTabId(value) {
  const numericId = Number(value);
  return Number.isInteger(numericId) ? numericId : null;
}

function getPinnedTabKey(tab) {
  if (!tab) return '';
  const tabId = normalizeTabId(tab.tabId ?? tab.id);
  const windowId = normalizeTabId(tab.windowId);
  if (tabId == null || windowId == null) return '';
  return `${windowId}:${tabId}`;
}

function setPinnedTabsState(nextPinnedTabs) {
  pinnedTabKeys = new Set(nextPinnedTabs.map(getPinnedTabKey).filter(Boolean));
}

function isTabPinnedHere(tab) {
  const key = getPinnedTabKey(tab);
  return Boolean(key && pinnedTabKeys.has(key));
}

function withPinnedState(tabs) {
  return tabs.map(tab => ({
    ...tab,
    pinnedHere: isTabPinnedHere(tab),
  }));
}

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const [tabs, currentWindow] = await Promise.all([
      chrome.tabs.query({}),
      chrome.windows.getCurrent(),
    ]);
    currentWindowId = currentWindow && currentWindow.id;
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      favIconUrl: t.favIconUrl || '',
      windowId: t.windowId,
      index:    t.index,
      lastAccessed: t.lastAccessed || 0,
      active:   t.active,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
    displayedTabs = [];
    currentWindowId = null;
  }
}

function normalizePinnedTab(pin) {
  if (!pin || !pin.url) return null;
  const tabId = normalizeTabId(pin.tabId ?? pin.id);
  const windowId = normalizeTabId(pin.windowId);
  if (tabId == null || windowId == null) return null;

  return {
    url: pin.url,
    title: pin.title || pin.url,
    windowId,
    tabId,
    pinnedAt: pin.pinnedAt || new Date().toISOString(),
  };
}

async function readPinnedTabs() {
  try {
    const stored = await chrome.storage.local.get(PINNED_TABS_STORAGE_KEY);
    const rawPinnedTabs = stored[PINNED_TABS_STORAGE_KEY];
    return Array.isArray(rawPinnedTabs)
      ? rawPinnedTabs.map(normalizePinnedTab).filter(Boolean)
      : [];
  } catch (err) {
    console.warn('[tab-out] Could not load pinned tabs:', err);
    return [];
  }
}

async function writePinnedTabs(nextPinnedTabs) {
  await chrome.storage.local.set({ [PINNED_TABS_STORAGE_KEY]: nextPinnedTabs });
  setPinnedTabsState(nextPinnedTabs);
}

function normalizeWindowOrderItem(item, fallbackOrder = 0) {
  const windowId = normalizeTabId(item?.windowId);
  if (windowId == null) return null;
  const order = Number.isFinite(Number(item.order)) ? Number(item.order) : fallbackOrder;

  return {
    windowId,
    label: item.label || '',
    order,
    updatedAt: item.updatedAt || new Date().toISOString(),
  };
}

async function readWindowOrder() {
  try {
    const stored = await chrome.storage.local.get(WINDOW_ORDER_STORAGE_KEY);
    const rawOrder = stored[WINDOW_ORDER_STORAGE_KEY];
    return Array.isArray(rawOrder)
      ? rawOrder.map(normalizeWindowOrderItem).filter(Boolean)
      : [];
  } catch (err) {
    console.warn('[tab-out] Could not load window order:', err);
    return [];
  }
}

async function writeWindowOrder(nextOrder) {
  const normalizedOrder = nextOrder
    .map((item, index) => normalizeWindowOrderItem(item, index + 1))
    .filter(Boolean);
  await chrome.storage.local.set({ [WINDOW_ORDER_STORAGE_KEY]: normalizedOrder });
}

async function saveWindowLabel(windowId, label) {
  const normalizedWindowId = normalizeTabId(windowId);
  if (normalizedWindowId == null) return false;

  const cleanLabel = String(label || '').trim();
  const storedOrder = await readWindowOrder();
  const storedById = new Map(storedOrder.map(item => [item.windowId, item]));
  const realTabs = withPinnedState(getRealTabs());
  const summaries = buildWindowSummaries(realTabs, storedOrder);
  const targetSummary = summaries.find(summary => summary.windowId === normalizedWindowId);
  if (!targetSummary) return false;

  const now = new Date().toISOString();
  const liveWindowIds = new Set(summaries.map(summary => summary.windowId));
  const nextOrder = summaries.map((summary, index) => {
    const stored = storedById.get(summary.windowId);
    return {
      windowId: summary.windowId,
      label: summary.windowId === normalizedWindowId ? cleanLabel : (stored?.label || ''),
      order: Number.isFinite(Number(stored?.order)) ? Number(stored.order) : index + 1,
      updatedAt: summary.windowId === normalizedWindowId ? now : (stored?.updatedAt || now),
    };
  });

  await writeWindowOrder(nextOrder.concat(storedOrder.filter(item => !liveWindowIds.has(item.windowId))));

  return true;
}

function getWindowLabelInputSnapshot(input) {
  const card = input?.closest?.('.window-card');
  const windowId = normalizeTabId(input?.dataset.windowId || card?.dataset.windowId);
  if (windowId == null) return null;

  return {
    windowId,
    label: input.value,
  };
}

function getEditingWindowLabels() {
  const labels = new Map();
  document.querySelectorAll('.window-title-input').forEach(input => {
    if (input.dataset.cancelled === 'true') return;
    const snapshot = getWindowLabelInputSnapshot(input);
    if (snapshot) labels.set(snapshot.windowId, String(snapshot.label || '').trim());
  });
  return labels;
}

async function prunePinnedTabsAgainstOpenTabs(tabs = openTabs) {
  const storedPinnedTabs = await readPinnedTabs();
  if (storedPinnedTabs.length === 0) {
    setPinnedTabsState([]);
    return [];
  }

  const openByKey = new Map((tabs || []).map(tab => [getPinnedTabKey(tab), tab]));
  const nextPinnedTabs = [];

  for (const pin of storedPinnedTabs) {
    const openTab = openByKey.get(getPinnedTabKey(pin));
    if (!openTab) continue;

    nextPinnedTabs.push({
      url: openTab.url || pin.url,
      title: openTab.title || pin.title || openTab.url || pin.url,
      windowId: openTab.windowId,
      tabId: openTab.id,
      pinnedAt: pin.pinnedAt,
    });
  }

  const changed = nextPinnedTabs.length !== storedPinnedTabs.length ||
    nextPinnedTabs.some((pin, index) => JSON.stringify(pin) !== JSON.stringify(storedPinnedTabs[index]));

  if (changed) {
    await writePinnedTabs(nextPinnedTabs);
  } else {
    setPinnedTabsState(nextPinnedTabs);
  }

  return nextPinnedTabs;
}

function findOpenTabForAction({ tabId, tabUrl, windowId }) {
  const numericTabId = normalizeTabId(tabId);
  if (numericTabId != null) {
    const matchById = openTabs.find(tab => tab.id === numericTabId);
    if (matchById) return matchById;
  }

  const numericWindowId = normalizeTabId(windowId);
  return openTabs.find(tab =>
    tab.url === tabUrl &&
    (numericWindowId == null || tab.windowId === numericWindowId)
  );
}

async function togglePinnedTab(tab) {
  if (!tab || !tab.url) return false;

  const tabId = normalizeTabId(tab.id ?? tab.tabId);
  const windowId = normalizeTabId(tab.windowId);
  if (tabId == null || windowId == null) return false;

  const storedPinnedTabs = await readPinnedTabs();
  const key = getPinnedTabKey({ windowId, tabId });
  const isPinned = storedPinnedTabs.some(pin => getPinnedTabKey(pin) === key);
  const nextPinnedTabs = isPinned
    ? storedPinnedTabs.filter(pin => getPinnedTabKey(pin) !== key)
    : [
        ...storedPinnedTabs,
        {
          url: tab.url,
          title: tab.title || tab.url,
          windowId,
          tabId,
          pinnedAt: new Date().toISOString(),
        },
      ];

  await writePinnedTabs(nextPinnedTabs);
  return !isPinned;
}

/**
 * getScopedTabs(tabs)
 *
 * Defaults the dashboard to the current Chrome window. The "All windows"
 * switch intentionally restores the old cross-window view.
 */
function getScopedTabs(tabs) {
  if (tabScope !== 'current' || currentWindowId == null) return tabs;
  return tabs.filter(t => t.windowId === currentWindowId);
}

/**
 * closeTabsByIds(tabIds)
 *
 * Closes exact tab IDs. This avoids closing matching URLs in other windows
 * when the dashboard is scoped to the current window.
 */
async function closeTabsByIds(tabIds) {
  const ids = [...new Set((tabIds || []).map(Number).filter(Number.isInteger))];
  if (ids.length > 0) await chrome.tabs.remove(ids);
  await fetchOpenTabs();
  await prunePinnedTabsAgainstOpenTabs(openTabs);
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url, tabId) {
  const numericTabId = Number(tabId);
  if (Number.isInteger(numericTabId)) {
    try {
      const tab = await chrome.tabs.get(numericTabId);
      if (tab) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return;
      }
    } catch {
      // Fall through to URL matching if the tab no longer exists.
    }
  }

  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const queriedTabs = await chrome.tabs.query({});
  const allTabs = tabScope === 'current' && currentWindowId != null
    ? queriedTabs.filter(t => t.windowId === currentWindowId)
    : queriedTabs;
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const pinnedMatching = matching.filter(isTabPinnedHere);
      const keep = pinnedMatching.find(t => t.active) || pinnedMatching[0] || matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id && !isTabPinnedHere(tab)) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) {
        if (!isTabPinnedHere(tab)) toClose.push(tab.id);
      }
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
  await prunePinnedTabsAgainstOpenTabs(openTabs);
  return toClose.length;
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       favIconUrl: "https://example.com/favicon.ico",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string, favIconUrl?: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    favIconUrl: tab.favIconUrl || '',
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

const SHOPEE_REGION_BY_DOMAIN = {
  'sg': 'SG',
  'co.id': 'ID',
  'com.my': 'MY',
  'co.th': 'TH',
  'vn': 'VN',
  'ph': 'PH',
  'tw': 'TW',
  'com.br': 'BR',
  'com.mx': 'MX',
  'cl': 'CL',
  'com.co': 'CO',
};

const SHOPEE_CS_DOMAIN_KEY = 'shopee-cs';

const GOOGLE_WORKSPACE_ICON_URLS = {
  document: 'https://ssl.gstatic.com/docs/doclist/images/mediatype/icon_1_document_x16.png',
  spreadsheets: 'https://ssl.gstatic.com/docs/doclist/images/mediatype/icon_1_spreadsheet_x16.png',
  presentation: 'https://ssl.gstatic.com/docs/doclist/images/mediatype/icon_1_presentation_x16.png',
  forms: 'https://ssl.gstatic.com/docs/doclist/images/mediatype/icon_1_form_x16.png',
  drawings: 'https://ssl.gstatic.com/docs/doclist/images/mediatype/icon_1_drawing_x16.png',
};

function getGoogleWorkspaceIconUrl(url) {
  try {
    const parsed = new URL(url);
    const pathRoot = parsed.pathname.split('/').filter(Boolean)[0];

    if (parsed.hostname === 'docs.google.com' && GOOGLE_WORKSPACE_ICON_URLS[pathRoot]) {
      return GOOGLE_WORKSPACE_ICON_URLS[pathRoot];
    }
  } catch {}

  return '';
}

function getFallbackIconUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname
      ? `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=64`
      : '';
  } catch {
    return '';
  }
}

function getTabIconUrl(tabOrUrl) {
  const url = typeof tabOrUrl === 'string' ? tabOrUrl : tabOrUrl?.url;
  const nativeIconUrl = typeof tabOrUrl === 'string' ? '' : (tabOrUrl?.favIconUrl || '');

  return nativeIconUrl || getGoogleWorkspaceIconUrl(url) || getFallbackIconUrl(url);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function getHostnameKey(url) {
  try {
    if (url && url.startsWith('file://')) return 'local-files';
    const parsed = new URL(url);
    return getShopeeCsContextFromHostname(parsed.hostname)
      ? SHOPEE_CS_DOMAIN_KEY
      : parsed.hostname;
  } catch {
    return '';
  }
}

function getShopeeCsContextFromHostname(hostname) {
  const normalized = String(hostname || '').replace(/^www\./, '').toLowerCase();
  const parts = normalized.split('.').filter(Boolean);
  const shopeeIndex = parts.indexOf('shopee');
  if (shopeeIndex <= 0 || shopeeIndex >= parts.length - 1) return null;

  const subdomains = parts.slice(0, shopeeIndex).filter(part => part !== 'www');
  const systemSubdomains = subdomains.filter(part => part !== 'uat');
  if (systemSubdomains.length !== 1 || systemSubdomains[0] !== 'cs') return null;

  const domainSuffix = parts.slice(shopeeIndex + 1).join('.');
  const region = SHOPEE_REGION_BY_DOMAIN[domainSuffix] || parts[parts.length - 1]?.toUpperCase();
  if (!region) return null;

  const environment = subdomains.includes('uat') ? 'UAT' : 'Live';

  return {
    region,
    environment,
    label: `${region} ${environment} · Shopee CS`,
  };
}

function getShopeePageLabel(pathname, searchParams) {
  const redirectUrl = searchParams?.get('redirect_url') || '';
  if (pathname.includes('/welcome') && redirectUrl) {
    try {
      return getShopeePageLabel(new URL(redirectUrl).pathname);
    } catch {}
  }

  const parts = pathname.split('/').filter(Boolean);
  const caseDetailIndex = parts.indexOf('case-detail');
  if (caseDetailIndex !== -1) {
    const caseId = parts[caseDetailIndex + 1] || '';
    return caseId ? `Case ${caseId.slice(-6)}` : 'Case Detail';
  }
  if (pathname.includes('/workstation/items')) return 'Workstation';
  if (pathname.includes('/workstation')) return 'Workstation';
  if (pathname.includes('/welcome')) return 'Welcome';
  if (pathname.includes('/login')) return 'Login';
  return '';
}

function stripShopeeTitleSuffix(title) {
  return String(title || '')
    .replace(/\s*[-|—–·]\s*(Shopee\s*)?(Customer Service|CS|Seller Center|Seller|SPX|Shopee)\s*$/i, '')
    .trim();
}

function getShopeeSmartTitle(title, url) {
  let parsed;
  try { parsed = new URL(url); }
  catch { return ''; }

  const context = getShopeeCsContextFromHostname(parsed.hostname);
  if (!context) return '';

  const pageLabel = getShopeePageLabel(parsed.pathname, parsed.searchParams);
  if (pageLabel) return `${context.label} · ${pageLabel}`;

  const titleIsUrl = !title || title === url || title.startsWith(parsed.hostname) || title.startsWith('http');
  const cleanBase = titleIsUrl ? '' : stripShopeeTitleSuffix(title);
  return cleanBase ? `${context.label} · ${cleanBase}` : context.label;
}

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (hostname === SHOPEE_CS_DOMAIN_KEY) return 'Shopee CS';
  const shopeeContext = getShopeeCsContextFromHostname(hostname);
  if (shopeeContext) return shopeeContext.label;
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');
  const shopeeTitle = getShopeeSmartTitle(title, url);
  if (shopeeTitle) return shopeeTitle;

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}

/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
  calendar:`<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25m10.5-2.25v2.25M3.75 8.25h16.5M5.25 5.25h13.5A1.5 1.5 0 0 1 20.25 6.75v12A1.5 1.5 0 0 1 18.75 20.25H5.25A1.5 1.5 0 0 1 3.75 18.75v-12A1.5 1.5 0 0 1 5.25 5.25Z" /></svg>`,
  mail:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M21.75 7.5v9A2.25 2.25 0 0 1 19.5 18.75h-15A2.25 2.25 0 0 1 2.25 16.5v-9m19.5 0A2.25 2.25 0 0 0 19.5 5.25h-15A2.25 2.25 0 0 0 2.25 7.5m19.5 0-8.28 5.52a2.25 2.25 0 0 1-2.49 0L2.25 7.5" /></svg>`,
  translate:`<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 5.25h8.25M8.625 3v2.25m1.875 0c-.54 2.25-1.77 4.26-3.48 5.83m0 0A11.2 11.2 0 0 1 4.5 12.75m2.52-1.67a11.23 11.23 0 0 0 3.105 1.67m1.125 6 3.75-8.25 3.75 8.25m-1.05-2.25h-5.4" /></svg>`,
  plus:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14m7-7H5" /></svg>`,
  pin:     `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M8 3h8m-6 0v8l-2 2v2h8v-2l-2-2V3m-2 12v6" /></svg>`,
  unpin:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14" /></svg>`,
  save:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>`,
  edit:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Z" /></svg>`,
  check:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}

function updateWindowScopeSwitch(allRealTabs, scopedRealTabs) {
  const switchEl = document.getElementById('windowScopeSwitch');
  if (!switchEl) return;

  const currentCount = currentWindowId == null
    ? allRealTabs.length
    : allRealTabs.filter(t => t.windowId === currentWindowId).length;
  const counts = {
    current: currentCount,
    all: allRealTabs.length,
  };

  switchEl.querySelectorAll('[data-scope]').forEach(btn => {
    const active = btn.dataset.scope === tabScope;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  switchEl.querySelectorAll('[data-scope-count]').forEach(el => {
    const scope = el.dataset.scopeCount;
    el.textContent = counts[scope] ?? scopedRealTabs.length;
  });
}

function refreshScopeStats() {
  const realTabs = withPinnedState(getRealTabs());
  displayedTabs = getScopedTabs(realTabs);
  updateWindowScopeSwitch(realTabs, displayedTabs);
  renderPinnedHere(realTabs);

  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = displayedTabs.length;
}


function buildChipActions(tab, safeUrl, safeTitle, safeTabId, safeWindowId) {
  const isCurrentWindowTab = currentWindowId == null || tab.windowId === currentWindowId;
  const pinTarget = isCurrentWindowTab ? 'this window' : "this tab's window";
  const pinTitle = tab.pinnedHere
    ? `Unpin from ${pinTarget}`
    : `Pin in ${pinTarget}; pinned tabs are skipped by batch close`;

  return `
    <div class="chip-actions">
      <div class="chip-action-menu">
        <button class="chip-action chip-save chip-inline-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" data-tab-id="${safeTabId}" title="Save for later" aria-label="Save for later">
          ${ICONS.save}
        </button>
        <button class="chip-action chip-pin${tab.pinnedHere ? ' is-active' : ''}" data-action="toggle-pin-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" data-tab-id="${safeTabId}" data-window-id="${safeWindowId}" title="${pinTitle}" aria-label="${pinTitle}" aria-pressed="${tab.pinnedHere ? 'true' : 'false'}">
          ${ICONS.pin}
        </button>
      </div>
      <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" data-tab-id="${safeTabId}" title="Close this tab">
        ${ICONS.close}
      </button>
    </div>`;
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = `${count > 1 ? ' chip-has-dupes' : ''}${tab.pinnedHere ? ' is-pinned' : ''}`;
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    const safeTabId = Number.isInteger(tab.id) ? String(tab.id) : '';
    const safeWindowId = Number.isInteger(tab.windowId) ? String(tab.windowId) : '';
    const faviconUrl = getTabIconUrl(tab);
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" data-tab-id="${safeTabId}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      ${buildChipActions(tab, safeUrl, safeTitle, safeTabId, safeWindowId)}
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

function sortTabsWithPinnedFirst(tabs) {
  return [...tabs].sort((a, b) => {
    if (a.pinnedHere !== b.pinnedHere) return a.pinnedHere ? -1 : 1;
    return (a.index || 0) - (b.index || 0);
  });
}

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group, groupIndex = 0) {
  const tabs      = sortTabsWithPinnedFirst(group.tabs || []);
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');
  const closeableCount = tabs.filter(tab => !tab.pinnedHere).length;
  const cardAnimationDelay = `${0.22 + Math.min(groupIndex, 12) * 0.035}s`;

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = `${count > 1 ? ' chip-has-dupes' : ''}${tab.pinnedHere ? ' is-pinned' : ''}`;
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    const safeTabId = Number.isInteger(tab.id) ? String(tab.id) : '';
    const safeWindowId = Number.isInteger(tab.windowId) ? String(tab.windowId) : '';
    const faviconUrl = getTabIconUrl(tab);
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" data-tab-id="${safeTabId}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      ${buildChipActions(tab, safeUrl, safeTitle, safeTabId, safeWindowId)}
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = closeableCount > 0
    ? `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      ${closeableCount === tabCount
        ? `Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}`
        : `Close ${closeableCount} unpinned`}
    </button>`
    : `
    <button class="action-btn close-tabs is-disabled" type="button" disabled title="All tabs in this domain are pinned">
      ${ICONS.close}
      All pinned
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}" style="--card-animation-delay: ${cardAnimationDelay};">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}

function getWindowLabel(realTabs, activeTab, storedLabel = '') {
  if (storedLabel) return storedLabel;

  const pinnedTab = realTabs.find(tab => tab.pinnedHere);
  const sourceTab = pinnedTab || activeTab || realTabs[0];
  const sourceDomain = getHostnameKey(sourceTab?.url);
  if (sourceDomain) return friendlyDomain(sourceDomain);

  const domainCounts = {};
  for (const tab of realTabs) {
    const domain = getHostnameKey(tab.url);
    if (domain) domainCounts[domain] = (domainCounts[domain] || 0) + 1;
  }
  const [dominantDomain] = Object.entries(domainCounts).sort((a, b) => b[1] - a[1])[0] || [];
  return dominantDomain ? friendlyDomain(dominantDomain) : 'Window';
}

function buildWindowSummaries(realTabs, storedOrder = []) {
  const storedByWindow = new Map(storedOrder.map(item => [item.windowId, item]));
  const tabsByWindow = new Map();

  for (const tab of realTabs) {
    if (!tabsByWindow.has(tab.windowId)) tabsByWindow.set(tab.windowId, []);
    tabsByWindow.get(tab.windowId).push(tab);
  }

  return [...tabsByWindow.entries()].map(([windowId, tabs]) => {
    const sortedTabs = [...tabs].sort((a, b) => (a.index || 0) - (b.index || 0));
    const activeTab = openTabs.find(tab => tab.windowId === windowId && tab.active);
    const activeRealTab = sortedTabs.find(tab => tab.active);
    const stored = storedByWindow.get(windowId);
    const pinnedCount = sortedTabs.filter(tab => tab.pinnedHere).length;
    const activeTitle = cleanTitle(stripTitleNoise(activeTab?.title || sortedTabs[0]?.title || ''), '');

    return {
      windowId,
      tabs: sortTabsWithPinnedFirst(sortedTabs),
      tabCount: sortedTabs.length,
      pinnedCount,
      activeTab,
      activeTitle: activeTitle || activeTab?.url || sortedTabs[0]?.url || 'No active tab',
      label: getWindowLabel(sortedTabs, activeRealTab, stored?.label),
      order: Number.isFinite(Number(stored?.order)) ? Number(stored.order) : Number.MAX_SAFE_INTEGER,
      isCurrent: windowId === currentWindowId,
    };
  }).sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.windowId - b.windowId;
  });
}

function renderWindowTab(tab) {
  const label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
  const safeLabel = escapeHtml(label);
  const safeUrl = escapeHtml(tab.url || '');
  const safeTabId = Number.isInteger(tab.id) ? String(tab.id) : '';
  const faviconUrl = getTabIconUrl(tab);
  const chipClass = `${tab.pinnedHere ? ' is-pinned' : ''}${tab.active ? ' is-active-tab' : ''}`;

  return `
    <div class="window-tab-chip clickable${chipClass}" draggable="true" data-action="focus-tab" data-tab-url="${safeUrl}" data-tab-id="${safeTabId}" data-window-id="${tab.windowId}" title="${safeLabel}">
      ${faviconUrl ? `<img class="window-tab-favicon" src="${escapeHtml(faviconUrl)}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="window-tab-title">${safeLabel}</span>
      ${tab.pinnedHere ? `<span class="window-tab-pin" title="Pinned here">${ICONS.pin}</span>` : ''}
      <button class="window-tab-close" data-action="close-single-tab" data-tab-url="${safeUrl}" data-tab-id="${safeTabId}" title="Close this tab" aria-label="Close ${safeLabel}">
        ${ICONS.close}
      </button>
    </div>`;
}

function buildWindowOverflowTabs(hiddenTabs) {
  const hiddenTabRows = hiddenTabs.map(tab => renderWindowTab(tab)).join('');
  return `
    <div class="window-tab-overflow-items" hidden>${hiddenTabRows}</div>
    <button type="button" class="window-tab-overflow clickable" data-action="expand-window-tabs">
      +${hiddenTabs.length} more
    </button>`;
}

function renderWindowCard(windowSummary) {
  const currentBadge = windowSummary.isCurrent ? '<span class="window-current-badge">Current</span>' : '';
  const pinnedBadge = windowSummary.pinnedCount > 0
    ? `<span class="window-mini-badge">${windowSummary.pinnedCount} pinned</span>`
    : '';
  const visibleTabs = windowSummary.tabs.slice(0, 12);
  const overflowCount = windowSummary.tabs.length - visibleTabs.length;
  const tabList = visibleTabs.map(tab => renderWindowTab(tab)).join('')
    + (overflowCount > 0 ? buildWindowOverflowTabs(windowSummary.tabs.slice(12)) : '');

  return `
    <article class="window-card${windowSummary.isCurrent ? ' is-current' : ''}" draggable="true" data-window-id="${windowSummary.windowId}">
      <div class="window-card-top">
        <div class="window-card-title-row">
          <h3 class="window-card-title">${escapeHtml(windowSummary.label)}</h3>
          <button class="window-title-edit" data-action="edit-window-label" data-window-id="${windowSummary.windowId}" title="Rename window" aria-label="Rename ${escapeHtml(windowSummary.label)}">
            ${ICONS.edit}
          </button>
          ${currentBadge}
          <span class="window-mini-badge">${windowSummary.tabCount} tab${windowSummary.tabCount !== 1 ? 's' : ''}</span>
          ${pinnedBadge}
        </div>
      </div>
      <div class="window-tab-list">${tabList}</div>
    </article>`;
}

async function renderWindowsView(board, realTabs) {
  if (!board) return;

  const storedOrder = await readWindowOrder();
  const summaries = buildWindowSummaries(realTabs, storedOrder);

  board.innerHTML = summaries.length > 0
    ? summaries.map(summary => renderWindowCard(summary)).join('')
    : '<div class="windows-empty-state">No open web tabs.</div>';
}

function isWindowsViewActive() {
  return tabScope === 'all' && allWindowsView === 'windows';
}

function startWindowLabelEdit(actionEl) {
  const card = actionEl.closest('.window-card');
  const titleEl = card?.querySelector('.window-card-title');
  if (!card || !titleEl || card.querySelector('.window-title-input')) return;

  const input = document.createElement('input');
  input.className = 'window-title-input';
  input.value = titleEl.textContent.trim();
  input.setAttribute('aria-label', 'Window name');
  input.dataset.windowId = actionEl.dataset.windowId || '';
  titleEl.replaceWith(input);

  card.draggable = false;
  actionEl.dataset.action = 'save-window-label';
  actionEl.title = 'Save window name';
  actionEl.setAttribute('aria-label', 'Save window name');
  actionEl.innerHTML = ICONS.check;

  input.focus();
  input.select();
}

async function saveWindowLabelFromCard(actionEl) {
  const card = actionEl.closest('.window-card');
  const input = card?.querySelector('.window-title-input');
  if (!card || !input) return false;
  if (input.dataset.cancelled === 'true') return false;
  if (input.dataset.saving === 'true') return true;

  const snapshot = getWindowLabelInputSnapshot(input);
  if (!snapshot) return false;

  input.dataset.saving = 'true';
  const saved = await saveWindowLabel(snapshot.windowId, snapshot.label);
  if (!saved) return false;

  await renderStaticDashboard();
  return true;
}

async function saveCurrentWindowOrder(sourceWindowId, targetWindowId, placement = 'before') {
  const storedOrder = await readWindowOrder();
  const realTabs = withPinnedState(getRealTabs());
  const summaries = buildWindowSummaries(realTabs, storedOrder);
  const originalIds = summaries.map(summary => summary.windowId);
  const nextIds = [...originalIds];
  const fromIndex = nextIds.indexOf(sourceWindowId);
  if (fromIndex === -1 || sourceWindowId === targetWindowId) return false;

  const [movedWindowId] = nextIds.splice(fromIndex, 1);
  const targetIndex = nextIds.indexOf(targetWindowId);
  if (targetIndex === -1) return false;

  const insertIndex = placement === 'after' ? targetIndex + 1 : targetIndex;
  nextIds.splice(insertIndex, 0, movedWindowId);
  if (nextIds.every((windowId, index) => windowId === originalIds[index])) return false;

  const storedById = new Map(storedOrder.map(item => [item.windowId, item]));
  const editingLabels = getEditingWindowLabels();
  const liveWindowIds = new Set(nextIds);
  const now = new Date().toISOString();
  const nextOrder = nextIds.map((windowId, index) => ({
    windowId,
    label: editingLabels.has(windowId) ? editingLabels.get(windowId) : (storedById.get(windowId)?.label || ''),
    order: index + 1,
    updatedAt: now,
  }));
  await writeWindowOrder(nextOrder.concat(storedOrder.filter(item => !liveWindowIds.has(item.windowId))));
  return true;
}

function getWindowDropPlacement(e, cardEl) {
  const rect = cardEl.getBoundingClientRect();
  return e.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
}

function clearWindowDropIndicators() {
  document.querySelectorAll('.window-card.is-drop-target, .window-card.is-drop-before, .window-card.is-drop-after').forEach(el => {
    el.classList.remove('is-drop-target', 'is-drop-before', 'is-drop-after');
  });
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Archive-only state should not reserve a full sidebar column.
    if (active.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
    list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
    list.style.display = 'block';
    empty.style.display = 'none';

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = getTabIconUrl(item);
  const ago = timeAgo(item.savedAt);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}

/* ----------------------------------------------------------------
   QUICK SHORTCUTS — shortcut-only links, no API access
   ---------------------------------------------------------------- */

const SHORTCUTS_STORAGE_KEY = 'quickShortcutGroups';

const DEFAULT_SHORTCUT_GROUPS = [
  {
    label: 'Google',
    links: [
      {
        label: 'Calendar',
        icon: 'calendar',
        url: 'https://calendar.google.com/calendar/u/0/r/week',
        title: 'Open Google Calendar week view',
      },
      {
        label: 'Mail',
        icon: 'mail',
        url: 'https://mail.google.com/mail/u/0/#inbox',
        title: 'Open Gmail inbox',
      },
      {
        label: 'Translate',
        icon: 'translate',
        url: 'https://translate.google.com/',
        title: 'Open Google Translate',
      },
    ],
  },
];

function createShortcutId() {
  return `shortcut-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeShortcutGroups(groups, options = {}) {
  if (!Array.isArray(groups)) return [];
  return groups
    .filter(group => group && group.label && Array.isArray(group.links))
    .map((group, groupIndex) => {
      const groupLabel = String(group.label).trim();
      return {
        label: groupLabel,
        links: group.links
          .filter(link => link && link.label && link.url)
          .map((link, linkIndex) => ({
            id: link.id
              ? String(link.id)
              : `${groupLabel}:${String(link.label).trim()}:${String(link.url).trim()}:${groupIndex}:${linkIndex}`,
            label: String(link.label).trim(),
            url: String(link.url).trim(),
            title: link.title ? String(link.title).trim() : String(link.label).trim(),
            icon: link.icon ? String(link.icon).trim() : '',
            userShortcut: Boolean(options.userShortcut || link.userShortcut),
          }))
          .filter(link => link.label && link.url),
      };
    })
    .filter(group => group.label && group.links.length > 0);
}

function mergeShortcutGroups(...groupLists) {
  const merged = [];

  for (const groupList of groupLists) {
    for (const group of normalizeShortcutGroups(groupList)) {
      const existing = merged.find(item => item.label.toLowerCase() === group.label.toLowerCase());
      if (existing) {
        existing.links.push(...group.links);
      } else {
        merged.push(group);
      }
    }
  }

  return merged;
}

async function getStoredShortcutGroups() {
  try {
    const data = await chrome.storage.local.get(SHORTCUTS_STORAGE_KEY);
    return normalizeShortcutGroups(data[SHORTCUTS_STORAGE_KEY], { userShortcut: true });
  } catch {
    return [];
  }
}

async function getShortcutGroups() {
  const storedGroups = await getStoredShortcutGroups();
  if (Array.isArray(window.LOCAL_SHORTCUT_GROUPS)) {
    return mergeShortcutGroups(window.LOCAL_SHORTCUT_GROUPS, storedGroups);
  }

  const personalGroups = Array.isArray(window.LOCAL_SHORTCUT_GROUPS_APPEND)
    ? window.LOCAL_SHORTCUT_GROUPS_APPEND
    : [];
  return mergeShortcutGroups(DEFAULT_SHORTCUT_GROUPS, personalGroups, storedGroups);
}

function getShortcutIcon(iconName) {
  return ICONS[iconName] || '';
}

function ensureShortcutEditor() {
  let editor = document.getElementById('shortcutEditor');
  if (editor) return editor;

  const strip = document.getElementById('shortcutStrip');
  if (!strip) return null;

  editor = document.createElement('form');
  editor.id = 'shortcutEditor';
  editor.className = 'shortcut-editor';
  editor.hidden = true;
  editor.innerHTML = `
    <input id="shortcutLabelInput" name="label" type="text" autocomplete="off" placeholder="Name" aria-label="Shortcut name">
    <input id="shortcutUrlInput" name="url" type="text" autocomplete="off" placeholder="https://..." aria-label="Shortcut URL">
    <input id="shortcutGroupInput" name="group" type="text" autocomplete="off" placeholder="Group" aria-label="Shortcut group">
    <button class="shortcut-save-btn" type="submit">Add</button>
    <button class="shortcut-cancel-btn" type="button" data-action="close-shortcut-form" aria-label="Cancel shortcut add">${ICONS.close}</button>
    <div class="shortcut-form-error" id="shortcutFormError" role="alert"></div>
  `;
  strip.after(editor);
  return editor;
}

function normalizeShortcutUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) throw new Error('URL is required');

  const withProtocol = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const parsed = new URL(withProtocol);

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported');
  }

  return parsed.href;
}

async function saveUserShortcut(shortcut) {
  const storedGroups = await getStoredShortcutGroups();
  const groupLabel = shortcut.group || 'Links';
  let group = storedGroups.find(item => item.label.toLowerCase() === groupLabel.toLowerCase());

  if (!group) {
    group = { label: groupLabel, links: [] };
    storedGroups.push(group);
  }

  group.links.push({
    id: createShortcutId(),
    label: shortcut.label,
    url: shortcut.url,
  });

  await chrome.storage.local.set({ [SHORTCUTS_STORAGE_KEY]: storedGroups });
}

async function deleteUserShortcut(shortcutId) {
  if (!shortcutId) return false;

  const storedGroups = await getStoredShortcutGroups();
  let removed = false;

  const nextGroups = storedGroups
    .map(group => {
      const links = group.links.filter(link => {
        const shouldRemove = link.id === shortcutId;
        if (shouldRemove) removed = true;
        return !shouldRemove;
      });
      return { label: group.label, links };
    })
    .filter(group => group.links.length > 0);

  if (!removed) return false;
  await chrome.storage.local.set({ [SHORTCUTS_STORAGE_KEY]: nextGroups });
  return true;
}

function setShortcutFormError(message) {
  const errorEl = document.getElementById('shortcutFormError');
  if (errorEl) errorEl.textContent = message || '';
}

function closeShortcutEditor() {
  const editor = document.getElementById('shortcutEditor');
  if (!editor) return;
  editor.hidden = true;
  setShortcutFormError('');
}

async function renderShortcutStrip() {
  const strip = document.getElementById('shortcutStrip');
  if (!strip) return;

  const groups = await getShortcutGroups();

  if (groups.length === 0) {
    strip.style.display = 'none';
    strip.replaceChildren();
    return;
  }

  strip.style.display = '';
  strip.replaceChildren(...groups.map(group => {
    const groupEl = document.createElement('div');
    groupEl.className = 'shortcut-group';

    const labelEl = document.createElement('span');
    labelEl.className = 'shortcut-group-label';
    labelEl.textContent = group.label;
    groupEl.appendChild(labelEl);

    for (const link of group.links) {
      const itemEl = document.createElement('span');
      itemEl.className = link.userShortcut ? 'shortcut-item is-user-shortcut' : 'shortcut-item';

      const linkEl = document.createElement('a');
      linkEl.className = 'shortcut-link';
      linkEl.href = link.url;
      linkEl.target = '_blank';
      linkEl.rel = 'noopener';
      linkEl.title = link.title || link.label;

      const icon = getShortcutIcon(link.icon);
      if (icon) {
        const iconEl = document.createElement('span');
        iconEl.className = 'shortcut-icon';
        iconEl.innerHTML = icon;
        linkEl.appendChild(iconEl);
      }

      const textEl = document.createElement('span');
      textEl.className = 'shortcut-text';
      textEl.textContent = link.label;
      linkEl.appendChild(textEl);
      itemEl.appendChild(linkEl);

      if (link.userShortcut) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'shortcut-delete-btn';
        deleteBtn.type = 'button';
        deleteBtn.dataset.action = 'delete-shortcut';
        deleteBtn.dataset.shortcutId = link.id;
        deleteBtn.title = `Remove ${link.label}`;
        deleteBtn.setAttribute('aria-label', `Remove ${link.label}`);
        deleteBtn.innerHTML = ICONS.close;
        itemEl.appendChild(deleteBtn);
      }

      groupEl.appendChild(itemEl);
    }

    return groupEl;
  }));

  const addButton = document.createElement('button');
  addButton.className = 'shortcut-add-btn';
  addButton.type = 'button';
  addButton.dataset.action = 'open-shortcut-form';
  addButton.title = 'Add shortcut';
  addButton.setAttribute('aria-label', 'Add shortcut');
  addButton.innerHTML = ICONS.plus;
  strip.appendChild(addButton);
}

function getCurrentWindowPinnedTabs(tabs) {
  if (currentWindowId == null) return [];
  return sortTabsWithPinnedFirst(tabs)
    .filter(tab => tab.windowId === currentWindowId && tab.pinnedHere);
}

function renderPinnedHere(tabs) {
  const section = document.getElementById('pinnedHereSection');
  const list = document.getElementById('pinnedHereList');
  if (!section || !list) return;

  const currentPinnedTabs = getCurrentWindowPinnedTabs(tabs);
  if (currentPinnedTabs.length === 0) {
    section.hidden = true;
    list.replaceChildren();
    return;
  }

  section.hidden = false;
  list.innerHTML = currentPinnedTabs.map(tab => {
    const label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const safeUrl = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    const safeTabId = Number.isInteger(tab.id) ? String(tab.id) : '';
    const safeWindowId = Number.isInteger(tab.windowId) ? String(tab.windowId) : '';
    const faviconUrl = getTabIconUrl(tab);

    return `<div class="pinned-chip clickable" data-action="focus-tab" data-tab-url="${safeUrl}" data-tab-id="${safeTabId}" title="${safeTitle}">
      ${faviconUrl ? `<img class="pinned-chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="pinned-chip-text">${label}</span>
      <button class="pinned-chip-unpin" data-action="toggle-pin-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" data-tab-id="${safeTabId}" data-window-id="${safeWindowId}" title="Unpin from this window" aria-label="Unpin ${safeTitle}">
        ${ICONS.unpin}
      </button>
    </div>`;
  }).join('');
}

/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();
  await renderShortcutStrip();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  await prunePinnedTabsAgainstOpenTabs(openTabs);
  const realTabs = withPinnedState(getRealTabs());
  displayedTabs = getScopedTabs(realTabs);
  updateWindowScopeSwitch(realTabs, displayedTabs);
  renderPinnedHere(realTabs);

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of displayedTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      const hostname = getHostnameKey(tab.url);
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');
  const allWindowsViewSwitch = document.getElementById('allWindowsViewSwitch');

  if (openTabsSection) {
    if (realTabs.length > 0) {
      const windowCount = new Set(realTabs.map(t => t.windowId)).size;
      const showWindowsView = isWindowsViewActive();
      const scopeLabel = tabScope === 'current'
        ? 'current window'
        : `${windowCount} window${windowCount !== 1 ? 's' : ''}`;

      if (openTabsSectionTitle) {
        openTabsSectionTitle.textContent = tabScope === 'current' ? 'Current window' : 'All windows';
      }
      if (openTabsSectionCount) {
        openTabsSectionCount.innerHTML = showWindowsView
          ? `${windowCount} window${windowCount !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; ${displayedTabs.length} tabs`
          : `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; ${scopeLabel}`;
      }
      if (allWindowsViewSwitch) {
        allWindowsViewSwitch.hidden = tabScope !== 'all';
        allWindowsViewSwitch.querySelectorAll('[data-view]').forEach(btn => {
          const active = btn.dataset.view === allWindowsView;
          btn.classList.toggle('is-active', active);
          btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
      }
      if (openTabsMissionsEl) {
        openTabsMissionsEl.className = showWindowsView ? 'windows-board' : 'missions';
        if (showWindowsView) {
          await renderWindowsView(openTabsMissionsEl, displayedTabs);
        } else {
          openTabsMissionsEl.innerHTML = domainGroups.length > 0
            ? domainGroups.map((g, index) => renderDomainCard(g, index)).join('')
            : `
              <div class="missions-empty-state">
                <div class="empty-title">No tabs in this window.</div>
                <div class="empty-subtitle">Switch to All windows to review the rest.</div>
              </div>
            `;
        }
      }
      openTabsSection.style.display = 'block';
    } else {
      openTabsSection.style.display = 'none';
      if (allWindowsViewSwitch) allWindowsViewSwitch.hidden = true;
    }
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = displayedTabs.length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Switch All windows between domain and window views ----
  if (action === 'set-all-windows-view') {
    const nextView = actionEl.dataset.view;
    if (nextView !== 'domain' && nextView !== 'windows') return;
    allWindowsView = nextView;
    tabScope = 'all';
    await renderStaticDashboard();
    return;
  }

  if (action === 'edit-window-label') {
    e.stopPropagation();
    startWindowLabelEdit(actionEl);
    return;
  }

  if (action === 'save-window-label') {
    e.stopPropagation();
    const saved = await saveWindowLabelFromCard(actionEl);
    showToast(saved ? 'Window name saved' : 'Could not save name');
    return;
  }

  // ---- Open lightweight shortcut add form ----
  if (action === 'open-shortcut-form') {
    const editor = ensureShortcutEditor();
    if (!editor) return;

    editor.hidden = !editor.hidden;
    setShortcutFormError('');

    if (!editor.hidden) {
      const groupInput = document.getElementById('shortcutGroupInput');
      if (groupInput && !groupInput.value) groupInput.value = 'Work';
      document.getElementById('shortcutLabelInput')?.focus();
    }
    return;
  }

  // ---- Close lightweight shortcut add form ----
  if (action === 'close-shortcut-form') {
    closeShortcutEditor();
    return;
  }

  // ---- Delete a user-added shortcut ----
  if (action === 'delete-shortcut') {
    e.preventDefault();
    e.stopPropagation();

    const removed = await deleteUserShortcut(actionEl.dataset.shortcutId);
    if (removed) {
      await renderShortcutStrip();
      showToast('Shortcut removed');
    }
    return;
  }

  // ---- Switch between current-window and all-window views ----
  if (action === 'set-window-scope') {
    const nextScope = actionEl.dataset.scope;
    if (nextScope !== 'current' && nextScope !== 'all') return;
    tabScope = nextScope;
    if (nextScope === 'all') {
      allWindowsView = 'windows';
    }
    await renderStaticDashboard();
    return;
  }

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tab Out tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Expand overflow rows in Windows view ("+N more") ----
  if (action === 'expand-window-tabs') {
    const overflowContainer = actionEl.parentElement.querySelector('.window-tab-overflow-items');
    if (overflowContainer) {
      overflowContainer.hidden = false;
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Pin or unpin a tab in the current Tab Out dashboard ----
  if (action === 'toggle-pin-tab') {
    e.stopPropagation();
    const tab = findOpenTabForAction({
      tabId: actionEl.dataset.tabId,
      tabUrl: actionEl.dataset.tabUrl,
      windowId: actionEl.dataset.windowId,
    });
    if (!tab) {
      await prunePinnedTabsAgainstOpenTabs(openTabs);
      await renderStaticDashboard();
      showToast('Tab is no longer open');
      return;
    }

    const pinned = await togglePinnedTab(tab);
    await renderStaticDashboard();
    showToast(pinned ? 'Pinned here' : 'Unpinned');
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl, actionEl.dataset.tabId);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    const tabId  = Number(actionEl.dataset.tabId);
    if (!tabUrl) return;

    // Close the tab in Chrome directly
    if (Number.isInteger(tabId)) {
      await closeTabsByIds([tabId]);
    } else {
      const allTabs = await chrome.tabs.query({});
      const scopedTabs = tabScope === 'current' && currentWindowId != null
        ? allTabs.filter(t => t.windowId === currentWindowId)
        : allTabs;
      const match = scopedTabs.find(t => t.url === tabUrl) || allTabs.find(t => t.url === tabUrl);
      if (match) await closeTabsByIds([match.id]);
    }

    playCloseSound();

    if (actionEl.closest('.window-tab-chip')) {
      await renderStaticDashboard();
      showToast('Tab closed');
      return;
    }

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    refreshScopeStats();

    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    const tabId    = Number(actionEl.dataset.tabId);
    if (!tabUrl) return;
    const sourceTab = Number.isInteger(tabId)
      ? openTabs.find(tab => tab.id === tabId)
      : null;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle, favIconUrl: sourceTab?.favIconUrl || '' });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close the tab in Chrome
    if (Number.isInteger(tabId)) {
      await closeTabsByIds([tabId]);
    } else {
      const allTabs = await chrome.tabs.query({});
      const scopedTabs = tabScope === 'current' && currentWindowId != null
        ? allTabs.filter(t => t.windowId === currentWindowId)
        : allTabs;
      const match = scopedTabs.find(t => t.url === tabUrl) || allTabs.find(t => t.url === tabUrl);
      if (match) await closeTabsByIds([match.id]);
    }

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved for later');
    refreshScopeStats();
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const closeableTabs = group.tabs.filter(t => !t.pinnedHere);
    const tabIds = closeableTabs.map(t => t.id);
    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    if (tabIds.length === 0) {
      showToast(`All tabs from ${groupLabel} are pinned`);
      return;
    }

    await closeTabsByIds(tabIds);

    if (card && closeableTabs.length === group.tabs.length) {
      playCloseSound();
      animateCardOut(card);
    } else {
      playCloseSound();
      await renderStaticDashboard();
    }

    if (closeableTabs.length === group.tabs.length) {
      const idx = domainGroups.indexOf(group);
      if (idx !== -1) domainGroups.splice(idx, 1);
    }

    const closeMessage = closeableTabs.length === group.tabs.length
      ? `Closed ${tabIds.length} tab${tabIds.length !== 1 ? 's' : ''} from ${groupLabel}`
      : `Closed ${tabIds.length} unpinned tab${tabIds.length !== 1 ? 's' : ''} from ${groupLabel}`;
    showToast(closeMessage);

    refreshScopeStats();
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    const closedCount = await closeDuplicateTabs(urls, true);
    if (closedCount === 0) {
      await renderStaticDashboard();
      showToast('Duplicate tabs are pinned');
      return;
    }

    playCloseSound();
    refreshScopeStats();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }
});

document.addEventListener('dragstart', (e) => {
  if (!isWindowsViewActive()) return;
  if (e.target.closest('[data-action="close-single-tab"], [data-action="edit-window-label"], [data-action="save-window-label"], [data-action="expand-window-tabs"]')) return;

  const tabEl = e.target.closest('.window-tab-chip[draggable="true"]');
  if (tabEl) {
    e.stopPropagation();
    activeWindowsDragType = 'tab';
    activeWindowsDragSourceId = null;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/tab-out-type', 'tab');
    e.dataTransfer.setData('text/tab-out-tab-id', tabEl.dataset.tabId || '');
    e.dataTransfer.setData('text/plain', tabEl.dataset.tabId || '');
    tabEl.classList.add('is-dragging');
    return;
  }

  const cardEl = e.target.closest('.window-card[draggable="true"]');
  if (!cardEl) return;

  activeWindowsDragType = 'window';
  activeWindowsDragSourceId = Number(cardEl.dataset.windowId);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/tab-out-type', 'window');
  e.dataTransfer.setData('text/tab-out-window-id', cardEl.dataset.windowId || '');
  e.dataTransfer.setData('text/plain', cardEl.dataset.windowId || '');
  cardEl.classList.add('is-dragging');
});

document.addEventListener('dragover', (e) => {
  if (!isWindowsViewActive()) return;
  const cardEl = e.target.closest('.window-card');
  if (!cardEl) return;

  e.preventDefault();
  clearWindowDropIndicators();
  if (activeWindowsDragType === 'window' && Number(cardEl.dataset.windowId) === activeWindowsDragSourceId) return;

  cardEl.classList.add('is-drop-target');
  if (activeWindowsDragType === 'window') {
    cardEl.classList.add(getWindowDropPlacement(e, cardEl) === 'after' ? 'is-drop-after' : 'is-drop-before');
  }
});

document.addEventListener('dragleave', (e) => {
  if (!isWindowsViewActive()) return;
  const cardEl = e.target.closest('.window-card');
  if (!cardEl || cardEl.contains(e.relatedTarget)) return;
  cardEl.classList.remove('is-drop-target', 'is-drop-before', 'is-drop-after');
});

document.addEventListener('drop', async (e) => {
  if (!isWindowsViewActive()) return;
  const cardEl = e.target.closest('.window-card');
  if (!cardEl) return;

  e.preventDefault();
  const placement = getWindowDropPlacement(e, cardEl);
  clearWindowDropIndicators();

  const dragType = e.dataTransfer.getData('text/tab-out-type') || activeWindowsDragType;
  const targetWindowId = Number(cardEl.dataset.windowId);
  if (!Number.isInteger(targetWindowId)) return;

  if (dragType === 'tab') {
    const tabId = Number(e.dataTransfer.getData('text/tab-out-tab-id'));
    const tab = openTabs.find(item => item.id === tabId);
    if (!Number.isInteger(tabId) || !tab || tab.windowId === targetWindowId) return;

    try {
      await chrome.tabs.move(tabId, { windowId: targetWindowId, index: -1 });
      await renderStaticDashboard();
      showToast('Tab moved');
    } catch (err) {
      console.warn('[tab-out] Failed to move tab:', err);
      showToast('Could not move tab');
    }
    return;
  }

  if (dragType === 'window') {
    const sourceWindowId = Number(e.dataTransfer.getData('text/tab-out-window-id'));
    if (!Number.isInteger(sourceWindowId) || sourceWindowId === targetWindowId) return;

    const changed = await saveCurrentWindowOrder(sourceWindowId, targetWindowId, placement);
    if (changed) {
      await renderStaticDashboard();
      showToast('Window order saved');
    }
  }
});

document.addEventListener('dragend', () => {
  activeWindowsDragType = '';
  activeWindowsDragSourceId = null;
  document.querySelectorAll('.is-dragging, .is-drop-target, .is-drop-before, .is-drop-after').forEach(el => {
    el.classList.remove('is-dragging', 'is-drop-target', 'is-drop-before', 'is-drop-after');
  });
});

document.addEventListener('focusout', (e) => {
  const input = e.target.closest?.('.window-title-input');
  if (!input || input.dataset.cancelled === 'true' || input.dataset.saving === 'true') return;

  const card = input.closest('.window-card');
  const nextTarget = e.relatedTarget;
  if (nextTarget && card?.contains(nextTarget) && nextTarget.closest?.('[data-action="save-window-label"]')) {
    return;
  }

  const snapshot = getWindowLabelInputSnapshot(input);
  if (!snapshot) return;
  input.dataset.saving = 'true';

  setTimeout(async () => {
    const saved = await saveWindowLabel(snapshot.windowId, snapshot.label);
    if (saved) {
      await renderStaticDashboard();
    } else {
      showToast('Could not save name');
    }
  }, 0);
});

document.addEventListener('keydown', (e) => {
  const windowTitleInput = e.target.closest?.('.window-title-input');
  if (windowTitleInput) {
    const card = windowTitleInput.closest('.window-card');
    const saveButton = card?.querySelector('[data-action="save-window-label"]');

    if (e.key === 'Enter' && saveButton) {
      e.preventDefault();
      saveButton.click();
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      windowTitleInput.dataset.cancelled = 'true';
      renderStaticDashboard();
      return;
    }
  }
});

// ---- Shortcut form submit — save user shortcut locally ----
document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'shortcutEditor') return;
  e.preventDefault();

  const labelInput = document.getElementById('shortcutLabelInput');
  const urlInput = document.getElementById('shortcutUrlInput');
  const groupInput = document.getElementById('shortcutGroupInput');

  const label = (labelInput?.value || '').trim();
  const group = (groupInput?.value || '').trim() || 'Links';

  if (!label) {
    setShortcutFormError('Name is required.');
    labelInput?.focus();
    return;
  }

  let url;
  try {
    url = normalizeShortcutUrl(urlInput?.value);
  } catch {
    setShortcutFormError('Enter a valid http or https URL.');
    urlInput?.focus();
    return;
  }

  try {
    await saveUserShortcut({ label, url, group });
    e.target.reset();
    if (groupInput) groupInput.value = group;
    closeShortcutEditor();
    await renderShortcutStrip();
    showToast('Shortcut added');
  } catch (err) {
    console.error('[tab-out] Failed to save shortcut:', err);
    setShortcutFormError('Failed to save shortcut.');
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
renderDashboard();
