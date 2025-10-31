// content.js
// Floating UI + responding to background messages (showBreak, getBackToWork, startBreak)

(() => {
  // Defer full initialization until the document body exists. Some pages
  // (or browsers) may execute content scripts very early and document.body
  // can be null which makes appendChild throw and abort the script. We
  // wrap the original IIFE body in `start()` and call it once the DOM is
  // ready. This makes the injection more robust across browsers.
  function start() {
  const TIMER_ID = "break-buddy-floating";
  const OVERLAY_ID = "break-buddy-overlay";

  // try to avoid duplicate injection
  if (document.getElementById(TIMER_ID)) {
    // ensure it responds to messages
    initializeMessageListener();
    return;
  }

  // create floating timer container and attach a Shadow DOM so our styles
  // and markup cannot leak into the host page. The host element remains
  // in the page, but all UI lives inside the shadow root.
  const floatEl = document.createElement("div");
  floatEl.id = TIMER_ID;
  console.log('Blink: content script initializing - creating float host');
  // attach shadow root
  const shadow = floatEl.attachShadow({ mode: 'open' });
  // keep a reference to shadow root for inner functions
  const SHADOW_ROOT = shadow;

  // Fallback inline styles on the host element to ensure visibility even if
  // the shadow styles fail to apply for some reason (CSP / page resets).
  try {
    floatEl.style.position = 'fixed';
    floatEl.style.top = '12px';
    floatEl.style.right = '12px';
    floatEl.style.width = '190px';
    floatEl.style.background = 'rgba(30,30,30,0.92)';
    floatEl.style.color = '#fff';
    floatEl.style.padding = '10px 12px';
    floatEl.style.borderRadius = '12px';
    floatEl.style.zIndex = '2147483647';
  } catch (e) {
    // ignore styling failures
  }

  // Inject style and markup into shadow root (styles are scoped)
  applyFloatingStyles(shadow);
  shadow.innerHTML += `
    <div class="full-ui">
      <button class="minimize-btn" title="Minimize">−</button>
      <div id="bb-title">⏱ Blink</div>
      <div id="bb-timer-wrapper">
        <div class="bb-timer-label">Time on Tab/Website</div>
        <div id="bb-timer">0m</div>
      </div>
      <div id="bb-cat" title="Site Category">📊 Category: <span class="category-text">—</span></div>
      <div id="bb-controls">
        <button id="bb-open">⚙️ Settings</button>
        <button id="bb-break">Break</button>
      </div>
    </div>
    <div class="mini-ui">
      <div id="bb-mini-timer" title="Time on Tab/Website">0m</div>
      <button class="maximize-btn" title="Maximize">▢</button>
    </div>
  `;
  // add host into document (shadow contains our UI). Use try/catch and a
  // documentElement fallback for pages where document.body may be unavailable
  // or appendChild throws (some pages sandbox or re-write DOM very early).
  try {
    if (document.body) document.body.appendChild(floatEl);
    else if (document.documentElement) document.documentElement.appendChild(floatEl);
    else throw new Error('No document body or documentElement available');
    console.log('Blink: floating UI injected into page');
  } catch (err) {
    console.error('Blink: failed to append floating UI to document - attempting fallback', err);
    try {
      document.documentElement.insertBefore(floatEl, document.documentElement.firstChild);
      console.log('Blink: injected floating UI via documentElement fallback');
    } catch (err2) {
      console.error('Blink: all injection attempts failed', err2);
    }
  }

  // click handlers (query inside shadow)
  const rootQuery = (sel) => (floatEl.shadowRoot ? floatEl.shadowRoot.querySelector(sel) : null);

  // Safe sendMessage wrapper that swallows runtime.lastError to avoid
  // spurious console errors when the background/service-worker isn't
  // listening (or has been unloaded). Call `cb` only when a response is
  // available and there is no runtime.lastError.
  function sendMessageSafe(msg, cb) {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          // silently ignore - background may be inactive
          // console.debug && console.debug('Blink: sendMessage ignored', chrome.runtime.lastError && chrome.runtime.lastError.message);
          return;
        }
        if (typeof cb === 'function') cb(resp);
      });
    } catch (e) {
      // swallow exceptions
    }
  }

  const openBtn = rootQuery('#bb-open');
  if (openBtn) openBtn.addEventListener("click", () => {
    // Use chrome.runtime.getURL to get the options page URL
    const optionsUrl = chrome.runtime.getURL("options.html");
    // Send message to background script to open options
    // Keep direct sendMessage here so we can detect lastError and fallback
    // to opening the options page directly when needed.
    chrome.runtime.sendMessage({ action: "openOptionsTab", url: optionsUrl }, () => {
      if (chrome.runtime.lastError) {
        // Fallback: open directly if messaging fails
        window.open(optionsUrl, "_blank");
      }
    });
  });
  const breakBtn = rootQuery('#bb-break');
  if (breakBtn) breakBtn.addEventListener("click", () => {
    showBreakOptions();
  });

  // minimize/maximize handlers
  const container = floatEl; // host element
  const minimizeBtn = rootQuery('.minimize-btn');
  const maximizeBtn = rootQuery('.maximize-btn');
  const miniTimer = rootQuery('#bb-mini-timer');
  const mainTimer = rootQuery('#bb-timer');

  // Update mini timer whenever main timer changes (observer uses the
  // later-declared updateTimerDisplay function which is hoisted).
  if (mainTimer) {
    const observer = new MutationObserver(() => {
      if (miniTimer && mainTimer) {
        miniTimer.textContent = mainTimer.textContent;
      }
    });
    observer.observe(mainTimer, { childList: true, characterData: true, subtree: true });
  }

  if (minimizeBtn) minimizeBtn.addEventListener('click', () => {
    container.classList.add('minimized');
    updateTimerDisplay();
    // save state
    chrome.storage.sync.set({ timerMinimized: true });
  });

  if (maximizeBtn) maximizeBtn.addEventListener('click', () => {
    container.classList.remove('minimized');
    // save state
    chrome.storage.sync.set({ timerMinimized: false });
  });

  // restore minimized state from storage
  chrome.storage.sync.get({ timerMinimized: false }, (res) => {
    if (res.timerMinimized) {
      container.classList.add('minimized');
    }
  });

  // ------------------ Activity + Persistence + Draggable UI ------------------
  // We'll track real user activity (mouse/keyboard/scroll/click/touch), stop
  // counting after inactivity, and persist per-domain time via background.
  let activeSince = Date.now();
  let currentCategory = "—";
  let currentDomain = null;

  // Activity tracking state
  const INACTIVITY_MS = 60 * 1000; // consider idle after 60s of no activity
  const RESET_GAP_MS = 30 * 60 * 1000; // reset stored domain time if gap > 30min
  let lastActivity = Date.now();
  let isCounting = false;
  let activityInterval = null; // runs every second while counting
  let unsentAccumMs = 0; // accumulated local active ms not yet sent to background
  let baseDomainTimeMs = 0; // previously saved time fetched from background

  // read saved domain summary/time and category from background/storage on load
  (function loadDomainInfo() {
    try {
      currentDomain = window.location.hostname;
    } catch (e) {
      currentDomain = null;
    }
    if (!currentDomain) return;
    sendMessageSafe({ action: "getDomainTime", domain: currentDomain }, (resp) => {
      if (!resp) return;
      const last = resp.lastActive || 0;
      // if last active was long ago, reset stored time to 0 per requirement
      if (Date.now() - last > RESET_GAP_MS) baseDomainTimeMs = 0;
      else baseDomainTimeMs = resp.time || 0;
      // use category if provided
      if (resp.category) currentCategory = resp.category;
      updateCategoryDisplay(currentCategory);
      updateTimerDisplay();
    });
  })();

  // send accumulated time to background and reset unsentAccumMs
  function flushAccumulatedTime() {
    if (!currentDomain || unsentAccumMs <= 0) return;
    sendMessageSafe({ action: "addDomainTime", domain: currentDomain, deltaMs: unsentAccumMs }, (resp) => {
      // background will persist and update lastActive
    });
    baseDomainTimeMs += unsentAccumMs;
    unsentAccumMs = 0;
  }

  // start counting active time (called when activity detected)
  function startCounting() {
    if (isCounting) return;
    isCounting = true;
    lastActivity = Date.now();
    // tick every 1s to keep UI responsive and accurate
    activityInterval = setInterval(() => {
      // stop if tab hidden
      if (document.hidden) return;
      unsentAccumMs += 1000;
      updateTimerDisplay();
      // every 15s flush to background so storage stays reasonably up-to-date
      if (unsentAccumMs >= 15 * 1000) flushAccumulatedTime();
    }, 1000);
  }

  // stop counting and flush unsent time
  function stopCounting() {
    if (!isCounting) return;
    isCounting = false;
    if (activityInterval) clearInterval(activityInterval);
    activityInterval = null;
    flushAccumulatedTime();
  }

  // Update both the full and mini timer displays
  function updateTimerDisplay() {
    const totalMs = baseDomainTimeMs + unsentAccumMs;
    const mins = Math.floor(totalMs / 60000);
    const timeText = `${mins}m`;
    const t = rootQuery('#bb-timer');
    const mt = rootQuery('#bb-mini-timer');
    if (t) t.innerText = timeText;
    if (mt) mt.innerText = timeText;
  }

  // handle user interaction events
  function onUserActivity() {
    lastActivity = Date.now();
    // if tab visible, start counting
    if (!document.hidden) startCounting();
  }

  // register activity listeners (lightweight)
  ["mousemove", "keydown", "click", "scroll", "touchstart"].forEach(evt => {
    window.addEventListener(evt, onUserActivity, { passive: true });
  });

  // periodic check for inactivity -> stop counting if no activity for INACTIVITY_MS
  setInterval(() => {
    if (!isCounting) return;
    if (Date.now() - lastActivity > INACTIVITY_MS) {
      stopCounting();
    }
  }, 1000);

  // visibility changes (tab hidden/visible)
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopCounting();
    } else {
      // resume counting if there was recent activity
      if (Date.now() - lastActivity <= INACTIVITY_MS) startCounting();
    }
  });

  // listen for idle broadcasts from background (chrome.idle)
  chrome.runtime.onMessage.addListener((m) => {
    if (!m || !m.action) return;
    if (m.action === 'idleState') {
      if (m.state === 'idle' || m.state === 'locked') stopCounting();
      else {
        // on active, resume if there was recent activity
        if (Date.now() - lastActivity <= INACTIVITY_MS) startCounting();
      }
    }
  });

  // Reusable drag attachment: makes an element draggable by a handle (or element itself)
  // and persists position under the provided storageKey (in chrome.storage.sync).
  function attachDragToElement(el, storageKey = 'floatPos', handleSelector = null) {
    if (!el) return;
    // Prevent attaching multiple times to the same element
    try {
      if (el.dataset && el.dataset.dragAttached) return;
      if (el.dataset) el.dataset.dragAttached = '1';
    } catch (e) {}
    let dragging = false;
    let startX = 0, startY = 0, origX = 0, origY = 0;
    let currentPointerId = null;

    // restore saved position
    const getObj = {};
    getObj[storageKey] = null;
    chrome.storage.sync.get(getObj, (res) => {
      const p = res && res[storageKey];
      if (p && typeof p.x === 'number' && typeof p.y === 'number') {
        el.style.top = (p.y || 12) + 'px';
        el.style.left = (p.x || '') + (p.x ? 'px' : '');
        el.style.right = p.x ? 'auto' : '12px';
      }
    });

    const handle = handleSelector ? ((el.shadowRoot ? el.shadowRoot.querySelector(handleSelector) : el.querySelector(handleSelector)) || el) : el;
    if (!handle) return;
    try { handle.style.cursor = 'grab'; } catch (e) {}
    try { handle.style.touchAction = 'none'; } catch (e) {}

    handle.addEventListener('pointerdown', (ev) => {
      // Only handle primary button (usually left click)
      if (ev.button !== 0) return;
      // don't start drag when interacting with controls (ensure target is Element)
      try {
        if (ev.target && ev.target.nodeType === 1) {
          if (ev.target.closest && (ev.target.closest('button') || ev.target.closest('a') || ev.target.closest('textarea'))) return;
        }
      } catch (e) {
        // if any DOM oddity, bail safely
        return;
      }
      
      dragging = true;
      startX = ev.clientX;
      startY = ev.clientY;
      const rect = el.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      
      // Set initial transform if not already set
      if (!el.style.transform) {
        el.style.transform = `translate(0px, 0px)`;
      }
      
      // Capture pointer and update cursor immediately
      try { el.setPointerCapture?.(ev.pointerId); } catch (e) {}
      currentPointerId = ev.pointerId;
      handle.style.cursor = 'grabbing';
      
      // Force GPU acceleration
      el.style.willChange = 'transform';
    });
    // pointermove: update transform while dragging
    window.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      try {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        // Use transform for smooth movement
        el.style.transform = `translate(${dx}px, ${dy}px)`;
      } catch (e) {
        // swallow any errors during move
      }
    });

    // pointerup: finalize position
    window.addEventListener('pointerup', (ev) => {
      if (!dragging) return;
      dragging = false;
      
      // Release pointer and reset cursor
      try { if (currentPointerId != null) el.releasePointerCapture?.(currentPointerId); } catch (e) {}
      currentPointerId = null;
      try { handle.style.cursor = 'grab'; } catch (e) {}
      
      // Get final position and update left/top
      try {
        const rect = el.getBoundingClientRect();
        const finalX = Math.max(6, rect.left);
        const finalY = Math.max(6, rect.top);
        
        // Reset transform and set final position
        el.style.transform = 'none';
        el.style.willChange = 'auto';
        el.style.left = finalX + 'px';
        el.style.top = finalY + 'px';
        el.style.right = 'auto';
        
        // Save position
        const obj = {};
        obj[storageKey] = { x: Math.round(finalX), y: Math.round(finalY) };
        chrome.storage.sync.set(obj);
      } catch (e) {
        // swallow finalize errors
      }
    });

    // pointercancel: ensure state reset if OS or browser cancels the pointer
    window.addEventListener('pointercancel', (ev) => {
      if (!dragging) return;
      dragging = false;
      try { if (currentPointerId != null) el.releasePointerCapture?.(currentPointerId); } catch (e) {}
      currentPointerId = null;
      try { handle.style.cursor = 'grab'; } catch (e) {}
      try { el.style.transform = 'none'; el.style.willChange = 'auto'; } catch (e) {}
    });
  }

  // attach to main floating timer
  (function attachMainDrag() {
    // attach drag to the host element; use shadow handle '#bb-title'
    attachDragToElement(floatEl, 'floatPos', '#bb-title');
  })();

  // update display if base time changed externally
  setInterval(updateTimerDisplay, 5000);
  // -------------------------------------------------------------------------

  // show break options panel (top right small)
  function showBreakOptions() {
    removeOverlay();
    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.innerHTML = `
      <div id="bb-overlay-card">
        <div class="bb-row"><strong>Choose break</strong></div>
        <div class="bb-row">
          <button class="bb-break-btn" data-min="10">10m</button>
          <button class="bb-break-btn" data-min="20">20m</button>
          <button class="bb-break-btn" data-min="30">30m</button>
          <button class="bb-break-btn" data-min="manual">Manual</button>
        </div>
        <div class="bb-row"><small>Manual max: 45m</small></div>
        <div class="bb-row"><button id="bb-cancel">Cancel</button></div>
      </div>
    `;
    // append overlay inside shadow so it is style-isolated
    floatEl.shadowRoot.appendChild(overlay);

    overlay.querySelectorAll(".bb-break-btn").forEach(b => {
      b.addEventListener("click", (e) => {
        const val = e.currentTarget.dataset.min;
        if (val === "manual") {
          const mins = prompt("Enter break minutes (max 45):", "15");
          const parsed = parseInt(mins);
          if (isNaN(parsed) || parsed <= 0) { alert("Invalid"); removeOverlay(); return; }
          const chosen = Math.min(parsed, 45);
          startBreak(chosen * 60 * 1000);
        } else {
          startBreak(parseInt(val) * 60 * 1000);
        }
      });
    });
    const cancelBtn = overlay.querySelector("#bb-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", removeOverlay);
  }

  function removeOverlay() {
    const ex = floatEl.shadowRoot.getElementById ? floatEl.shadowRoot.getElementById(OVERLAY_ID) : floatEl.shadowRoot.querySelector('#' + OVERLAY_ID);
    if (ex) ex.remove();
  }

  // start break UI countdown on this page
  function startBreak(durationMs) {
    removeOverlay();

    // Reuse a single banner element for the whole flow so styling stays
    // consistent: pre-start countdown -> active break countdown -> end state.
    removeExistingBanner();
    const banner = document.createElement('div');
    banner.id = 'bb-break-banner';
    banner.innerHTML = `
      <div class="pre-break-content">
        <div class="pre-break-title">🎯 Break Starting...</div>
        <div class="pre-break-countdown">3</div>
      </div>
    `;
  floatEl.shadowRoot.appendChild(banner);
  // allow dragging by the title only (prevents accidental drags when
  // clicking the countdown). Use the title as the handle so the rest of
  // the block is safe to click without moving.
  attachDragToElement(banner, 'bannerPos', '.pre-break-title');

    // Pre-start countdown (3..1)
    let preCount = 3;
    const preCountdownEl = banner.querySelector('.pre-break-countdown');
    const preInterval = setInterval(() => {
      preCount--;
      if (preCountdownEl) preCountdownEl.textContent = preCount;
      if (preCount <= 0) {
        clearInterval(preInterval);

        // Transition banner into the active break countdown view (reuse same banner)
        banner.innerHTML = `
          <div class="break-content" style="position:relative;padding:12px;">
            <button class="minimize-btn" title="Minimize" style="position:absolute;top:8px;right:40px;background:transparent;border:none;color:inherit;font-size:18px;cursor:pointer">−</button>
            <button class="bb-close" title="Close break" style="position:absolute;top:8px;right:8px;background:transparent;border:none;color:inherit;font-size:18px;cursor:pointer">×</button>
            <div class="break-title">🎯 Break Time!</div>
            <div id="bb-break-text">Time remaining: <span id="bb-break-remaining"></span></div>
            
          </div>
          <div class="mini-ui" style="display:none;align-items:center;gap:8px;">
            <div id="bb-break-mini" style="font-weight:800;padding:6px 10px;background:transparent;border-radius:6px;">0m</div>
            <button class="maximize-btn" title="Maximize" style="background:transparent;border:none;color:inherit;font-size:14px;cursor:pointer">▢</button>
          </div>
        `;
  // re-attach drag for the new content using the title as handle so
  // clicking the timer itself won't start a drag.
  attachDragToElement(banner, 'bannerPos', '.break-title');
        sendMessageSafe({ action: "startBreakGlobal", durationMs }, () => {});

        // Start the active break countdown
  const remEl = banner.querySelector('#bb-break-remaining');
  const closeBtn = banner.querySelector('.bb-close');
  const minBtn = banner.querySelector('.minimize-btn');
  const maxBtn = banner.querySelector('.maximize-btn');
  const miniEl = banner.querySelector('#bb-break-mini');
        let remaining = Math.max(0, Math.ceil(durationMs / 1000));
        if (remEl) remEl.innerText = formatSeconds(remaining);

        const interval = setInterval(() => {
          remaining--;
          if (remEl) remEl.innerText = formatSeconds(remaining);
          if (miniEl) miniEl.innerText = formatSeconds(Math.floor(remaining/1));
          if (remaining <= 0) {
            clearInterval(interval);

            // Show pre-end 3..1 countdown in the same banner before finalizing
            let endCount = 3;
            banner.innerHTML = `
              <div class="pre-end-content" style="text-align:center;padding:12px;">
                <div class="pre-end-title">⏳ Break Ending...</div>
                <div class="pre-end-count">3</div>
              </div>
            `;
            const preEndEl = banner.querySelector('.pre-end-count');
            const endTimer = setInterval(() => {
              endCount--;
              if (preEndEl) preEndEl.textContent = endCount;
              if (endCount <= 0) {
                clearInterval(endTimer);
                // Final end state
                banner.innerHTML = `
                  <div class="end-break-content">
                    <div class="end-break-title">⏰ Break Complete!</div>
                    <div class="end-break-message">Time to get back to work</div>
                  </div>
                `;
                setTimeout(() => {
                  if (banner) {
                    banner.style.opacity = '0';
                    setTimeout(() => banner.remove(), 300);
                  }
                }, 3000);
                sendMessageSafe({ action: "endBreakGlobal" }, () => {});
              }
            }, 1000);
          }
        }, 1000);

        // Close button (top-right) ends the break
        function handleEndEarly() {
          clearInterval(interval);
          setTimeout(() => {
            banner.innerHTML = `
              <div class="end-break-content">
                <div class="end-break-title">⏰ Break Ended</div>
                <div class="end-break-message">Back to work</div>
              </div>
            `;
            setTimeout(() => banner.remove(), 2000);
            sendMessageSafe({ action: 'endBreakGlobal' }, () => {});
          }, 1000);
        }
        if (closeBtn) closeBtn.addEventListener('click', handleEndEarly);

        // Minimize / Maximize behavior for this break block (persisted)
        function setBannerMinimized(state) {
          try { banner.classList.toggle('minimized', !!state); } catch (e) {}
          if (miniEl) miniEl.style.display = state ? 'block' : 'none';
          const content = banner.querySelector('.break-content');
          if (content) content.style.display = state ? 'none' : 'block';
          if (minBtn) minBtn.style.display = state ? 'none' : 'inline-block';
          if (maxBtn) maxBtn.style.display = state ? 'inline-block' : 'none';
          chrome.storage.sync.set({ breakBannerMinimized: !!state });
        }
        // restore state
        chrome.storage.sync.get({ breakBannerMinimized: false }, (res) => { setBannerMinimized(!!res.breakBannerMinimized); });
        if (minBtn) minBtn.addEventListener('click', () => setBannerMinimized(true));
        if (maxBtn) maxBtn.addEventListener('click', () => setBannerMinimized(false));
      }
    }, 1000);
  }

  // showBreakBanner removed — startBreak now handles the full lifecycle

  function removeExistingBanner() {
    const old = floatEl.shadowRoot.querySelector('#bb-break-banner');
    if (old) old.remove();
  }

  function formatSeconds(s) {
    // format seconds as HH:MM:SS or MM:SS or Xm Ys fallback for large minutes
    if (typeof s !== 'number' || isNaN(s) || s < 0) return '0s';
    const hours = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = Math.floor(s % 60);
    const two = (n) => (n < 10 ? '0' + n : '' + n);
    if (hours > 0) return `${hours}:${two(mins)}:${two(secs)}`;
    return `${mins}:${two(secs)}`;
  }

  function updateCategoryDisplay(cat) {
  const el = rootQuery('#bb-cat');
  const categoryText = el ? el.querySelector('.category-text') : null;
    
    // Map categories to friendly names with icons
    const categoryMap = {
      'social': '📱 Social',
      'games': '🎮 Gaming',
      'school': '📚 School',
      'productive': '💼 Productive',
      'other': '🔍 Other'
    };

    if (categoryText) categoryText.innerText = categoryMap[cat] || '🔍 Uncategorized';
  }

  // listen to background messages
  function initializeMessageListener() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.action) return;
      if (msg.action === "showBreak") {
        // show break suggestion overlay
        showBreakOptions();
        return;
      } else if (msg.action === 'getPageText') {
        // return page visible text (trimmed) — use selection if present
        try {
          const selection = window.getSelection && window.getSelection().toString();
          let text = selection && selection.trim() ? selection.trim() : document.body ? document.body.innerText : '';
          // limit size to avoid huge payloads
          if (text && text.length > 20000) text = text.substring(0, 20000) + '\n\n[truncated]';
          sendResponse({ text });
        } catch (e) {
          sendResponse({ text: '' });
        }
        return true;
      } else if (msg.action === "getBackToWork") {
        // show short alert style
        showQuickToast("⚠️ Get back to work — looks like distraction.");
      } else if (msg.action === "startBreak") {
        startBreak(msg.durationMs || (10*60*1000));
      } else if (msg.action === "endBreakGlobal") {
        // another part of the extension ended the break — provide cues
        showQuickToast("⏰ Break ended — back to work!");
      } else if (msg.action === "activeCategory") {
        updateCategoryDisplay(msg.category);
      } else if (msg.action === "themeChanged") {
        applyTheme(msg.theme);
      }
    });
  }
  initializeMessageListener();

  function showQuickToast(text) {
    const id = "bb-quick-toast";
    removeToast();
    const t = document.createElement("div");
    t.id = id;
    t.innerText = text;
    // append toast into shadow so it is isolated
    floatEl.shadowRoot.appendChild(t);
    setTimeout(removeToast, 6000);
    function removeToast() { const ex = floatEl.shadowRoot.querySelector('#' + id); if (ex) ex.remove(); }
  }

  }

  // NOTE: material icons removed to avoid affecting host pages.

  // Apply theme settings to floating UI (targeting host element and shadow children)
  function applyTheme(theme) {
    const container = floatEl;
    if (!container) return;

    // Set data-theme attribute on host
    container.dataset.theme = theme.mode;

    // Update host background/text where applicable
    if (theme.mode === 'custom') {
      container.style.background = adjustAlpha(theme.custom.bgColor, 0.92);
      container.style.color = theme.custom.textColor;
      // Update buttons inside shadow
      const buttons = container.shadowRoot.querySelectorAll('button:not(.minimize-btn):not(.maximize-btn)');
      buttons.forEach(btn => {
        btn.style.background = theme.custom.accentColor;
        btn.style.color = theme.custom.textColor;
      });
    } else {
      container.style.background = '';
      container.style.color = '';
      const buttons = container.shadowRoot.querySelectorAll('button');
      buttons.forEach(btn => {
        btn.style.background = '';
        btn.style.color = '';
      });
    }

    // Apply font to shadow root host
    try { container.style.fontFamily = theme.fontStyle; } catch (e) {}
  }

  // Helper to adjust color alpha
  function adjustAlpha(color, alpha) {
    // Convert hex to rgb
    const hex = color.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // Load and apply initial theme
  chrome.storage.sync.get(['theme'], (res) => {
    if (res.theme) {
      applyTheme(res.theme);
    }
  });

  // styles appended into the shadow root to isolate all rules
  function applyFloatingStyles(root) {
    const css = `
      :host {
        position: fixed;
        top: 12px;
        right: 12px;
        width: 190px;
        background: rgba(30,30,30,0.92);
        color: #fff;
        padding: 10px 12px;
        border-radius: 12px;
        z-index: 2147483647;
        font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        box-shadow: 0 6px 18px rgba(0,0,0,0.35);
        transition: transform 0.1s ease;
        user-select: none;
        display: block;
        transform: translate3d(0,0,0);
        -webkit-transform: translate3d(0,0,0);
        backface-visibility: hidden;
        -webkit-backface-visibility: hidden;
        perspective: 1000;
        -webkit-perspective: 1000;
      }

      :host(.minimized) {
        width: auto !important;
        padding: 8px 10px;
      }

      .full-ui {
        display: flex;
        flex-direction: column;
        gap: 8px;
        align-items: flex-start;
        width: 100%;
        position: relative;
      }

      :host(.minimized) .full-ui {
        display: none;
      }

      .mini-ui {
        display: none;
        align-items: center;
        gap: 10px;
      }

      :host(.minimized) .mini-ui {
        display: flex;
      }
      
      #bb-break-banner {
        /* Position the break banner immediately below the floating host */
        position: absolute;
        top: calc(100% + 8px);
        right: 0;
        background: rgba(30,30,30,0.95);
        padding: 12px 14px;
        border-radius: 12px;
        color: white;
        text-align: center;
        z-index: 2147483647;
        box-shadow: 0 8px 24px rgba(0,0,0,0.2);
      }

      #bb-break-banner .break-content {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 15px;
      }

      #bb-break-banner .break-title {
        font-size: 18px;
        font-weight: 700;
        color: #fff;
        margin-bottom: 6px;
      }

      #bb-break-banner #bb-break-text {
        font-size: 13px;
        opacity: 0.9;
      }

      /* prominent remaining time for active break */
      #bb-break-banner #bb-break-remaining {
        display: block;
        font-size: 22px;
        font-weight: 900;
        color: #fff;
        margin-top: 6px;
        letter-spacing: 0.4px;
      }

      /* End break button removed per user request */
      
      #bb-pre-break-banner {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(30,30,30,0.95);
        padding: 20px 30px;
        border-radius: 12px;
        color: white;
        text-align: center;
        z-index: 2147483647;
        box-shadow: 0 8px 24px rgba(0,0,0,0.2);
        animation: fadeIn 0.3s ease-out;
      }

      #bb-pre-break-banner .pre-break-title {
        font-size: 20px;
        margin-bottom: 15px;
      }

      #bb-pre-break-banner .pre-break-countdown {
        font-size: 48px;
        font-weight: bold;
        color: #4CAF50;
      }

      #bb-end-break-banner {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(30,30,30,0.95);
        padding: 20px 30px;
        border-radius: 12px;
        color: white;
        text-align: center;
        z-index: 2147483647;
        box-shadow: 0 8px 24px rgba(0,0,0,0.2);
        animation: fadeIn 0.3s ease-out;
        transition: opacity 0.3s ease-out;
      }

      #bb-end-break-banner .end-break-title {
        font-size: 24px;
        margin-bottom: 10px;
        color: #4CAF50;
      }

      #bb-end-break-banner .end-break-message {
        font-size: 16px;
        opacity: 0.9;
      }

      /* Floating break block styling to match the floating Blink UI */
      #bb-break-banner {
        position: absolute;
        top: calc(100% + 8px);
        right: 0;
        width: 220px;
        background: rgba(30,30,30,0.92);
        color: #fff;
        padding: 10px 12px;
        border-radius: 12px;
        z-index: 2147483647;
        box-shadow: 0 6px 18px rgba(0,0,0,0.35);
        font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      }

      #bb-break-banner .break-content { display: block; }
      #bb-break-banner .mini-ui { display: none; }
      #bb-break-banner.minimized { width: auto; padding: 8px; }
      #bb-break-banner.minimized .break-content { display: none; }
      #bb-break-banner.minimized .mini-ui { display: flex; align-items: center; gap: 8px; }

      @keyframes fadeIn {
        from { opacity: 0; transform: translate(-50%, -60%); }
        to { opacity: 1; transform: translate(-50%, -50%); }
      }

      #bb-mini-timer {
        font-size: 16px;
        font-weight: 800;
      }

      #bb-title { font-weight:800; font-size:15px; line-height:1; }
      #bb-timer { font-size:18px; font-weight:900; letter-spacing:0.4px; }
      #bb-cat { font-size:13px; opacity:0.95; }
      #bb-controls { display:flex; gap:8px; align-self: stretch; }
      button { background:#2b6cb0; color:white; border:none; padding:8px 10px; border-radius:8px; cursor:pointer; display:flex; align-items:center; gap:6px; font-size:13px; }
      button:active { transform: translateY(1px); }
      .bb-timer-label { font-size:12px; opacity:0.92; }

      .minimize-btn, .maximize-btn {
        position: absolute;
        top: 8px;
        right: 8px;
        padding: 6px !important;
        background: transparent !important;
        opacity: 0.8;
        transition: opacity 0.18s ease;
      }

      .minimize-btn:hover, .maximize-btn:hover {
        opacity: 1;
      }

      .maximize-btn { position: static !important; }

      /* overlay + controls */
  #break-buddy-overlay { position: fixed; top: 60px; right: 12px; z-index:2147483647; }
  #break-buddy-overlay #bb-overlay-card { background:#fff; color:#111; padding:12px; border-radius:10px; box-shadow: 0 8px 24px rgba(0,0,0,0.2); width:240px; font-family: Inter, Arial, sans-serif;}
  #break-buddy-overlay .bb-row { margin:8px 0; display:flex; justify-content:center; gap:8px; }
  #break-buddy-overlay .bb-break-btn { padding:8px 10px; border-radius:8px; border:none; background:#38a169; color:#fff; cursor:pointer; font-weight:700; }

  /* removed older fixed fallback for break banner to keep it positioned under the host */
      #bb-quick-toast { position: fixed; top: 12px; right: 12px; background:#f56565; color:#fff; padding:10px 12px; border-radius:10px; z-index:2147483647; font-family:Inter, Arial, sans-serif; }
    `;
    const style = document.createElement("style");
    style.textContent = css;
    if (root && root.appendChild) root.appendChild(style);
    return css;
  }

  // Run start() when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => start(), { once: true });
  } else {
    // document already parsed
    start();
  }
})();
