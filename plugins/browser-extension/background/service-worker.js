/**
 * Capture buffer.
 *
 * The DevTools page is torn down whenever DevTools closes, so captures cannot
 * live there. The service worker holds them per tab, bounded, and hands them to
 * the panel on request.
 *
 * Bounded on two axes: MAX_CAPTURED per tab and MAX_TABS overall. Without the
 * second, a long session across many tabs leaks memory that nothing ever frees.
 */
importScripts("../lib/constants.js")

/** tabId -> capture[] (newest last) */
const buffers = new Map()

function push(tabId, entry) {
  let list = buffers.get(tabId)
  if (!list) {
    if (buffers.size >= BR_LIMITS.MAX_TABS) {
      // Drop the least recently touched tab.
      const oldest = buffers.keys().next().value
      buffers.delete(oldest)
    }
    list = []
    buffers.set(tabId, list)
  }
  list.push(entry)
  if (list.length > BR_LIMITS.MAX_CAPTURED) list.splice(0, list.length - BR_LIMITS.MAX_CAPTURED)
  // Re-insert so Map iteration order tracks recency for the eviction above.
  buffers.delete(tabId)
  buffers.set(tabId, list)
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (!msg || !msg.type) return

  if (msg.type === "capture-entry" && typeof msg.tabId === "number") {
    push(msg.tabId, msg.entry)
    return
  }

  if (msg.type === "get-captures" && typeof msg.tabId === "number") {
    respond({ captures: buffers.get(msg.tabId) || [] })
    return true
  }

  if (msg.type === "clear-captures" && typeof msg.tabId === "number") {
    buffers.delete(msg.tabId)
    respond({ ok: true })
    return true
  }
})

chrome.tabs.onRemoved.addListener((tabId) => buffers.delete(tabId))
