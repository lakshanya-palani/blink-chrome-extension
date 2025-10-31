// popup.js - small controller for enabling/disabling and manual break start

document.addEventListener("DOMContentLoaded", () => {
  const enableToggle = document.getElementById("enableToggle");
  const start10 = document.getElementById("startBreak10");
  const start20 = document.getElementById("startBreak20");
  const resetShown = document.getElementById("resetShown");
  const summary = document.getElementById("summary");

  // load settings (we only store whether floating is enabled)
  chrome.storage.sync.get({ floatingEnabled: true }, (res) => {
    enableToggle.checked = !!res.floatingEnabled;
  });

  enableToggle.addEventListener("change", (e) => {
    chrome.storage.sync.set({ floatingEnabled: enableToggle.checked });
    // If turned off, ask content scripts to remove UI
    chrome.tabs.query({}, (tabs) => {
      for (const t of tabs) {
        chrome.tabs.sendMessage(t.id, { action: enableToggle.checked ? "enableFloating" : "disableFloating" }, (resp) => {
          // swallow errors when a tab doesn't have a receiver (reduces console noise)
          if (chrome.runtime.lastError) return;
        });
      }
    });
  });

  start10.addEventListener("click", () => startBreak(10));
  start20.addEventListener("click", () => startBreak(20));

  // helper to call chrome.runtime.sendMessage while ignoring lastError
  function sendRuntimeSafe(msg, cb) {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          if (cb) cb(null);
          return;
        }
        if (cb) cb(resp);
      });
    } catch (err) {
      if (cb) cb(null);
    }
  }

  resetShown.addEventListener("click", () => {
    sendRuntimeSafe({ action: "resetBreakShown" }, (resp) => {
      if (resp && resp.ok) alert("Break notifications reset.");
    });
  });

  async function startBreak(minutes) {
    const ms = minutes * 60 * 1000;
    sendRuntimeSafe({ action: "startBreakFromPopup", durationMs: ms }, (resp) => {
      if (resp && resp.ok) window.close();
    });
  }

  // Summarizer removed: the extension no longer provides an external summarization feature.
  // The UI button (if present) is intentionally left non-functional or removed from HTML.

  // load quick summary
  sendRuntimeSafe({ action: "getSummary" }, (resp) => {
    if (!resp) return;
    const ds = resp.domainStats || {};
    // compute totals per category
    const catTotals = {};
    for (const [domain, entry] of Object.entries(ds)) {
      const c = entry.category || "other";
      catTotals[c] = (catTotals[c] || 0) + (entry.time || 0);
    }
    let html = "<ul>";
    for (const [cat, ms] of Object.entries(catTotals)) {
      html += `<li>${cat}: ${Math.round(ms/60000)} min</li>`;
    }
    html += "</ul>";
    summary.innerHTML = html || "No data yet.";
  });

});
