// background.js
// Tracks active tab time, categorizes domains, sends break/get-back messages.

const DEFAULT_CATEGORY_MAP = {
  "social": ["youtube.com", "instagram.com", "twitter.com", "tiktok.com", "facebook.com", "reddit.com"],
  "games": ["roblox.com", "steampowered.com", "epicgames.com", "miniclip.com"],
  "school": ["classroom.google.com", "canvas.instructure.com", "google.com/drive", "docs.google.com"],
  "productive": ["notion.so", "github.com", "stackoverflow.com", "drive.google.com", "docs.google.com"]
};

// runtime state
let activeTabId = null;
let activeDomain = null;
let activeCategory = null;
let activeStart = Date.now();

// productive session tracking
let productiveSessionStart = null; // timestamp when consecutive productive started
let productiveAccumulated = 0; // milliseconds accumulated today (persisted)

// distracting streak tracking
let distractingStart = null;

// thresholds (ms)
const GET_BACK_THRESHOLD = 15 * 60 * 1000; // 15 minutes on distracting sites triggers get-back
const BREAK_THRESHOLDS = [2 * 60 * 60 * 1000, 3 * 60 * 60 * 1000, 4 * 60 * 60 * 1000];

async function loadPrefs() {
  const res = await chrome.storage.sync.get({
    categoryMap: DEFAULT_CATEGORY_MAP,
    breakThresholds: BREAK_THRESHOLDS // allow override (not used directly here)
  });
  return res;
}

function getCategoryForUrl(url, map) {
  try {
    const host = new URL(url).hostname + (new URL(url).pathname || "");
    // match by host contains any site string from map lists
    for (const [cat, patterns] of Object.entries(map)) {
      for (const p of patterns) {
        if (!p) continue;
        if (host.includes(p) || url.includes(p)) return cat;
      }
    }
  } catch (e) {
    // fallback: if url parse fails
  }
  return "other";
}

async function saveDomainTime(domain, category, deltaMs) {
  if (!domain) return;
  const key = "domainStats";
  const stored = await chrome.storage.local.get(key);
  const map = stored[key] || {};
  const entry = map[domain] || { time: 0, category: category || "other" };
  entry.time = (entry.time || 0) + deltaMs;
  entry.category = category || entry.category;
  map[domain] = entry;
  await chrome.storage.local.set({ [key]: map });
}

// called whenever active tab changes or updates
async function handleTabChange(tab) {
  const now = Date.now();
  // store time spent on previous active tab
  if (activeDomain && activeStart) {
    const delta = now - activeStart;
    // persist
    const prefs = await loadPrefs();
    const cat = activeCategory || getCategoryForUrl(activeDomain, prefs.categoryMap);
    await saveDomainTime(activeDomain, cat, delta);

    // update productive session or distracting streak based on that category
    if (cat === "productive" || cat === "school") {
      // if productiveSessionStart not set, set to activeStart of that productive period (we want consecutive productive)
      if (!productiveSessionStart) productiveSessionStart = activeStart;
      productiveAccumulated += delta;
      // reset distracting
      distractingStart = null;
    } else if (cat === "social" || cat === "games" || cat === "other") {
      // leave productive
      productiveSessionStart = null;
      // track distracting streak
      if (!distractingStart) distractingStart = now - delta; // when distracting began approx.
      // else continues
    }
  }

  // update active tab info
  if (!tab || !tab.url) {
    activeTabId = null;
    activeDomain = null;
    activeCategory = null;
    activeStart = now;
    return;
  }
  activeTabId = tab.id;
  activeDomain = new URL(tab.url).hostname;
  const prefs = await loadPrefs();
  activeCategory = getCategoryForUrl(tab.url, prefs.categoryMap);
  activeStart = now;
  // optionally broadcast the category/time info to content script in this tab
  try {
    chrome.tabs.sendMessage(tab.id, { action: "activeCategory", category: activeCategory }, (resp) => {
      if (chrome.runtime.lastError) return; // no receiver in some tabs - ignore
    });
  } catch (e) { }
}

// check thresholds periodically
async function periodicChecks() {
  const now = Date.now();

  // check productive session thresholds
  if (productiveSessionStart) {
    // effective productive duration: now - productiveSessionStart + accumulated (we kept accumulation from finished productive intervals)
    const productiveDuration = productiveAccumulated + (now - productiveSessionStart);
    // check highest threshold not yet shown - to avoid repeating, store lastShownThreshold in storage
    const s = await chrome.storage.local.get(["lastShownBreakThreshold"]);
    const lastShown = s.lastShownBreakThreshold || 0;
    for (const t of [4*60*60*1000, 3*60*60*1000, 2*60*60*1000]) {
      if (productiveDuration >= t && lastShown < t) {
        // show break message on active tab(s)
        pushToAllTabs({ action: "showBreak", reason: "long_work", thresholdMs: t });
        await chrome.storage.local.set({ lastShownBreakThreshold: t });
        break;
      }
    }
  }

  // check distracting streak
  if (distractingStart) {
    const distractingDuration = now - distractingStart;
    if (distractingDuration >= GET_BACK_THRESHOLD) {
      pushToAllTabs({ action: "getBackToWork", reason: "distracted", durationMs: distractingDuration });
      // to avoid repeating constantly, reset distractingStart so it requires a new streak
      distractingStart = null;
    }
  }

  // persist productiveAccumulated daily (or periodically)
  await chrome.storage.local.set({ productiveAccumulated });
}

function pushToAllTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      chrome.tabs.sendMessage(t.id, message, (resp) => {
        // Some tabs may not have the content script injected (or it has unloaded) -
        // that causes runtime.lastError which is expected. Swallow it to avoid
        // noisy console errors in the background service worker.
        if (chrome.runtime.lastError) return;
      });
    }
  });
}

// tab event listeners
chrome.tabs.onActivated.addListener(async (info) => {
  try {
    const tab = await chrome.tabs.get(info.tabId);
    handleTabChange(tab);
  } catch (e) {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // when tab becomes active + completes load, treat as change
  if (tab.active && changeInfo.status === "complete") {
    handleTabChange(tab);
  }
});

// track window focus changes too
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  // when Chrome loses focus, treat as leaving the active domain
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // simulate leaving
    await handleTabChange(null);
  } else {
    // get active tab for that window
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0]) handleTabChange(tabs[0]);
  }
});

// on install/load: init storage values
chrome.runtime.onInstalled.addListener(async () => {
  const prefs = await loadPrefs();
  await chrome.storage.local.set({ categoryMap: prefs.categoryMap, productiveAccumulated: 0, lastShownBreakThreshold: 0 });
  productiveAccumulated = 0;
  console.log("Blink installed/initialized");
});

// periodic timer
setInterval(periodicChecks, 30 * 1000); // check every 30s

// on startup restore
chrome.runtime.onStartup.addListener(async () => {
  const s = await chrome.storage.local.get(["productiveAccumulated"]);
  productiveAccumulated = s.productiveAccumulated || 0;
  // determine active tab
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs && tabs[0]) handleTabChange(tabs[0]);
});

// respond to messages from popup/content/options
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return;

  // Reset last shown break threshold
  if (msg.action === "resetBreakShown") {
    chrome.storage.local.set({ lastShownBreakThreshold: 0 });
    sendResponse({ ok: true });

  // open options in a new tab (from content)
  } else if (msg.action === "openOptionsTab") {
    chrome.tabs.create({ url: msg.url });
    sendResponse({ ok: true });

  // Add domain time from a content script (deltaMs)
  } else if (msg.action === "addDomainTime") {
    (async () => {
      try {
        const domain = msg.domain;
        const delta = Number(msg.deltaMs) || 0;
        if (!domain || delta <= 0) { sendResponse({ ok: false }); return; }
        const key = 'domainStats';
        const stored = await chrome.storage.local.get(key);
        const map = stored[key] || {};
        const entry = map[domain] || { time: 0, category: null, lastActive: 0 };
        entry.time = (entry.time || 0) + delta;
        entry.lastActive = Date.now();
        // attempt to set category if not present using prefs
        try {
          const prefs = await loadPrefs();
          const cat = getCategoryForUrl('https://' + domain, prefs.categoryMap);
          entry.category = entry.category || cat;
        } catch (e) {}
        map[domain] = entry;
        await chrome.storage.local.set({ [key]: map });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false });
      }
    })();
    return true; // async

  // Content asking for stored domain time
  } else if (msg.action === "getDomainTime") {
    (async () => {
      const key = 'domainStats';
      const stored = await chrome.storage.local.get(key);
      const map = stored[key] || {};
      const entry = map[msg.domain] || { time: 0, category: null, lastActive: 0 };
      sendResponse({ time: entry.time || 0, category: entry.category || null, lastActive: entry.lastActive || 0 });
    })();
    return true; // async

  // existing summary request used by popup
  } else if (msg.action === "getSummary") {
    (async () => {
      const data = await chrome.storage.local.get(["domainStats", "productiveAccumulated"]);
      sendResponse({ domainStats: data.domainStats || {}, productiveAccumulated: data.productiveAccumulated || productiveAccumulated });
    })();
    return true; // async response

  // start break from popup
  } else if (msg.action === "startBreakFromPopup") {
    const durationMs = msg.durationMs;
    pushToAllTabs({ action: "startBreak", durationMs });
    sendResponse({ ok: true });
  
  // Summarize action removed: the extension no longer uses an external summarizer API.
  // Keep a simple response so callers get a deterministic result instead of causing network calls.
  } else if (msg.action === 'summarize') {
    // Summarizer API intentionally removed. Respond with an informative error.
    try {
      sendResponse({ ok: false, error: 'summarizer_removed' });
    } catch (e) {
      // ignore
    }
  }
});

// Listen to system idle changes (requires "idle" permission in manifest)
if (chrome.idle && chrome.idle.onStateChanged) {
  chrome.idle.onStateChanged.addListener((state) => {
    // broadcast to all tabs so content scripts can pause counting
    pushToAllTabs({ action: 'idleState', state });
  });
}
