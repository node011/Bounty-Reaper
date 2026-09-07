/** Read-only status. All controls live in the DevTools panel. */
chrome.storage.local.get(["serverUrl", "serverPassword"]).then(async (cfg) => {
  const url = cfg.serverUrl || BR_DEFAULTS.serverUrl
  const res = await brProbe(url, { password: cfg.serverPassword })
  document.getElementById("status").textContent = res.ok
    ? `connected to ${url} (v${res.version})`
    : `not reachable at ${url} — ${res.error}`
})
