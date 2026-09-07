/**
 * DevTools entry point.
 *
 * This is the only place that can see the inspected tab's network traffic —
 * `chrome.devtools.network` exists nowhere else in the extension. It stays thin:
 * filter, summarise, forward to the service worker. The panel does the rest.
 *
 * Capture flags are mirrored in memory rather than read from chrome.storage on
 * each request, because this listener runs on every finished request in the tab
 * and a storage round-trip per request is visible in page performance.
 */

let filterApiOnly = BR_DEFAULTS.filterApiOnly
let captureEnabled = BR_DEFAULTS.captureEnabled

chrome.storage.local.get(["filterApiOnly", "captureEnabled"]).then((cfg) => {
  if (typeof cfg.filterApiOnly === "boolean") filterApiOnly = cfg.filterApiOnly
  if (typeof cfg.captureEnabled === "boolean") captureEnabled = cfg.captureEnabled
})

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return
  if (msg.type === "set-filter-api" && typeof msg.filterApiOnly === "boolean") filterApiOnly = msg.filterApiOnly
  if (msg.type === "set-capture-enabled" && typeof msg.enabled === "boolean") captureEnabled = msg.enabled
})

chrome.devtools.network.onRequestFinished.addListener((entry) => {
  if (!captureEnabled) return

  const req = entry.request || {}
  const res = entry.response || {}
  const url = req.url || ""
  const resourceType = String(
    entry._resourceType || entry.resourceType || brInferResourceType(url, res.headers) || "other",
  ).toLowerCase()

  // Decide before fetching the body: getContent() is the expensive call.
  if (!brShouldCapture(url, resourceType, filterApiOnly)) return

  entry.getContent((body) => {
    chrome.runtime.sendMessage({
      type: "capture-entry",
      tabId: chrome.devtools.inspectedWindow.tabId,
      entry: brSummarize(entry, body, resourceType),
    })
  })
})

chrome.devtools.panels.create("BountyReper", "icons/icon48.png", "panel/panel.html")
