# Blink — API Reference

This document lists and documents the extension and web APIs used by the Blink extension (current codebase). It explains where each API is used, why, the inputs/outputs, required permissions, and any important notes or edge cases.

> Note: The external OpenAI summarizer previously used in `background.js` has been removed; references to it were deleted and calls now return `{ ok: false, error: 'summarizer_removed' }`.

---

## Table of contents

- Chrome extension APIs
  - chrome.storage (sync and local)
  - chrome.tabs
  - chrome.windows
  - chrome.runtime
  - chrome.idle
  - chrome.notifications (permission present, not actively used)
  - chrome.scripting (permission in manifest)
- Web / DOM / Browser APIs
  - Message passing (content script ↔ background ↔ popup)
  - Shadow DOM
  - MutationObserver
  - Pointer Events (pointerdown/move/up/cancel)
  - Window/document events (visibilitychange, addEventListener)
  - setInterval / clearInterval / Date.now
  - window.getSelection / document.body.innerText
- Manifest & permissions
- Messaging flows (how messages travel between popup/background/content)

---

## chrome.storage

Files: `background.js`, `popup.js`, `content.js`, `options.js`

Variants used:
- `chrome.storage.sync.get(keysOrDefaults, callback)` — reads synchronized settings (user-level small data)
- `chrome.storage.sync.set(obj, callback)` — saves UI/setting choices (e.g. enable floating, minimized state, theme)
- `chrome.storage.local.get(keyOrArray)` (used with `await` via Promises in background) — persistent local storage for domain stats and daily counters
- `chrome.storage.local.set({ key: value })` — persist domain statistics and counters

Why used:
- `sync` stores small UI preferences shared across synced browsers (floating UI enabled, minimized state, theme, etc.).
- `local` stores potentially larger runtime data like `domainStats`, `productiveAccumulated`, and `lastShownBreakThreshold`.

Inputs/Outputs:
- get: keys or object of default values; callback receives an object containing stored values.
- set: an object of key/value pairs.

Edge cases/notes:
- `chrome.storage` callbacks are used in content/popup; background often uses `await chrome.storage.*` assuming a Promise-returning wrapper (Manifest V3 supports `chrome.storage.*` returning a Promise in many environments or polyfilled in the codebase). Code uses both callback and async/await styles.

Example:
- Read sync pref in popup: `chrome.storage.sync.get({ floatingEnabled: true }, (res) => { enableToggle.checked = !!res.floatingEnabled; });`
- Persist domain stats in background: `await chrome.storage.local.set({ [key]: map });`

---

## chrome.tabs

Files: `background.js`, `popup.js`, `content.js`, `options.js`

APIs used:
- `chrome.tabs.query(queryInfo, callback)` — find active tab(s) or enumerate tabs
- `chrome.tabs.get(tabId)` — get a single tab
- `chrome.tabs.create({ url })` — open a new tab (used to open options)
- `chrome.tabs.sendMessage(tabId, message, callback)` — send a runtime message to the content script in a particular tab
- `chrome.tabs.onActivated.addListener(callback)` — listen for tab activation events
- `chrome.tabs.onUpdated.addListener(callback)` — listen for tab updates (e.g., completion)

Why used:
- Determine active tab to track which domain is active and when the active tab changes.
- Broadcast messages from the background to content scripts in tabs.
- Popup and options call `tabs.query` and `tabs.sendMessage` to interact with content scripts.

Permissions required: `tabs`, `activeTab` (present in `manifest.json`)

Notes:
- Code often handles `chrome.runtime.lastError` inside the sendMessage callback (to silently ignore tabs without a listener).
- `chrome.tabs.query({}, ...)` is used to iterate all open tabs when broadcasting a change (e.g., enable/disable floating UI from popup/options).

Example:
- Broadcast message to all tabs (background):
  chrome.tabs.query({}, (tabs) => { tabs.forEach(t => chrome.tabs.sendMessage(t.id, message, () => { if (chrome.runtime.lastError) return; })); });

---

## chrome.windows

Files: `background.js`

APIs used:
- `chrome.windows.onFocusChanged.addListener(callback)` — used to detect when browser window focus changes to stop counting when the user switches away from the browser.
- `chrome.windows.WINDOW_ID_NONE` — constant used to detect when Chrome loses focus.

Why used: track high-level focus changes to pause counting and treat as leaving the active domain.

---

## chrome.runtime

Files: `background.js`, `popup.js`, `content.js`, `options.js`

APIs used:
- `chrome.runtime.onInstalled.addListener(callback)` — initialize stored defaults on install
- `chrome.runtime.onStartup.addListener(callback)` — restore state on extension startup
- `chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {...})` — message handler in `background.js` and also in `content.js` (content script listens for background messages)
- `chrome.runtime.sendMessage(msg, callback)` — used by popup/content to ask the background to perform actions
- `chrome.runtime.getURL(path)` — build an extension-internal URL (used to open `options.html` from content script)
- `chrome.runtime.lastError` — checked in callbacks to detect and ignore sendMessage errors when the target listener isn't present

Why used:
- Central messaging hub between popup, background, and content scripts.
- Lifecycle hooks to initialize and restore extension state.

Messaging patterns:
- Popup → Background: `chrome.runtime.sendMessage({ action: 'startBreakFromPopup', durationMs })`
- Content → Background: `chrome.runtime.sendMessage({ action: 'addDomainTime', domain, deltaMs })`
- Background → Content: `chrome.tabs.sendMessage(tabId, { action: 'startBreak' })` or via broadcast helper

Edge cases:
- Many `.sendMessage` calls check `chrome.runtime.lastError` to avoid noisy console errors when the listener is not present.
- Background handlers return `true` when they will respond asynchronously.

---

## chrome.idle

Files: `background.js`, `content.js`

APIs used:
- `chrome.idle.onStateChanged.addListener(callback)` — background listens to system idle and broadcasts an `idleState` message to content scripts, which pause counting

Permissions required: `idle` is listed in `manifest.json`.

Notes:
- Content script listens for messages `{ action: 'idleState', state }` and will stop counting for `state === 'idle' || state === 'locked'`.

---

## chrome.notifications (permission present)

Files: `manifest.json` includes `notifications` permission, but no direct `chrome.notifications.*` calls are currently present in the codebase.

Note: permission exists possibly for future notifications; since there are no active calls, no runtime behavior depends on notifications currently.

---

## chrome.scripting (permission present)

Files: `manifest.json` includes `scripting` permission. There are no direct `chrome.scripting.executeScript` calls in the current codebase, but `scripting` permission is available for future programmatic injection.

---

## Other browser / Web APIs used

### DOM, Shadow DOM, and UI
Files: `content.js`, `popup.html`, `popup.js`, `options.js`

- Shadow DOM: `element.attachShadow({ mode: 'open' })` used to isolate injected UI styles from host pages (floating UI lives in the shadow root).
- `document.createElement`, `appendChild`, `querySelector`, `innerHTML` used to construct and manipulate the floating UI and break overlay.
- `document.body.innerText` used to extract page text (content script `getPageText` handler)
- `window.getSelection()` used to prefer selected text for `getPageText`.

Notes:
- The extension carefully limits page text size (max ~20k characters) before sending it in a message.

### Events and activity tracking
Files: `content.js`

- `window.addEventListener('mousemove'|'keydown'|'click'|'scroll'|'touchstart')` used to detect user activity.
- `document.addEventListener('visibilitychange')` to pause/resume counting when tab is hidden/visible.
- `MutationObserver` watches timer DOM changes to update the mini-timer.
- Pointer events: `pointerdown`, `pointermove`, `pointerup`, `pointercancel` used to implement draggable UI.

### Timers
- `setInterval` / `clearInterval` used extensively for per-second counting, pre-countdowns, and periodic checks.

### Misc
- `Date.now()` for timestamps
- `URL` constructor for parsing hostnames
- `window.open(url, '_blank')` fallback to open `options.html` if messaging fails

---

## Messaging flows (high-level)

- Content script → Background
  - `addDomainTime` — content collects time and periodically sends accumulated domain time to background for persistence in `chrome.storage.local`.
  - `getPageText` — popup asks the content script for visible page text. Content responds immediately with trimmed text.
  - `openOptionsTab` — content builds `options.html` URL via `chrome.runtime.getURL` and asks background to open a tab.

- Popup → Background
  - `resetBreakShown`, `startBreakFromPopup`, `getSummary` (local domain summary; not an external summarizer), etc.

- Background → Content
  - `showBreak`, `getBackToWork`, `startBreak`, `endBreakGlobal`, `activeCategory` — background broadcasts these to content scripts via `chrome.tabs.sendMessage`.

Notes:
- Messages are plain JSON objects with an `action` field that determines behavior. Many handlers return `true` when responding asynchronously.
- Many senders use helper wrappers that swallow `chrome.runtime.lastError` to keep the console clean when a tab has no listener.

---

## Manifest and Permissions
File: `manifest.json`

Used permissions (from manifest):
- `storage` — for chrome.storage APIs
- `tabs`, `activeTab` — for enumerating and interacting with tabs
- `scripting` — reserved for programmatic script injection (listed but not actively used)
- `idle` — to observe system idle state
- `notifications` — listed but not actively used in code

Host permissions:
- `http://*/*`, `https://*/*` — content scripts run on all pages (`content_scripts` with `matches: ["<all_urls>"]`)

Background service worker: `background.js` (manifest v3 service worker).

Web accessible resources: `options.html`, `styles.css`, `options.js` (allowed to be opened as a tab or loaded by pages if needed).

---

## Quick reference: Where to look in the codebase

- `vsls:/background.js` — main orchestration, tab/window events, storage of domainStats, periodic checks, message routing
- `vsls:/content.js` — floating UI injection, activity tracking, DOM messaging handlers, draggable UI
- `vsls:/popup.js` and `vsls:/popup.html` — popup UI, simple controls (enable toggle, start break buttons), and quick domain-summary display
- `vsls:/options.js` & `vsls:/options.html` — settings UI (theme, category map, etc.)
- `vsls:/manifest.json` — permissions and background/service worker configuration

---

