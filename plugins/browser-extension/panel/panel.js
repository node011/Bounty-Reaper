/**
 * DevTools panel — the operator's whole workflow.
 *
 *   configure + validate  ->  browse (captures accumulate)
 *   pick a request        ->  Send   ->  watch the agent work  ->  Stop
 *
 * State is deliberately in-memory: captures belong to the service worker, and a
 * panel that persisted request/response bodies to chrome.storage would be
 * writing captured traffic — possibly containing session cookies — to disk
 * outside the engagement's control.
 */

const tabId = chrome.devtools.inspectedWindow.tabId

const el = (id) => document.getElementById(id)
const ui = {
  server: el("server"),
  password: el("password"),
  validate: el("validate"),
  status: el("status"),
  captureToggle: el("capture-toggle"),
  filterApi: el("filter-api"),
  refresh: el("refresh"),
  clear: el("clear"),
  list: el("list"),
  count: el("count"),
  instruction: el("instruction"),
  send: el("send"),
  stop: el("stop"),
  output: el("output"),
  detail: el("detail"),
}

let captures = []
let selectedId = null
let stopStream = null
let sessionID = null
let captureEnabled = BR_DEFAULTS.captureEnabled

// ---------------------------------------------------------------- config

async function loadConfig() {
  const cfg = await chrome.storage.local.get([
    "serverUrl",
    "serverPassword",
    "filterApiOnly",
    "captureEnabled",
    "instruction",
  ])
  ui.server.value = cfg.serverUrl || BR_DEFAULTS.serverUrl
  ui.password.value = cfg.serverPassword || ""
  ui.filterApi.checked = cfg.filterApiOnly !== false
  captureEnabled = cfg.captureEnabled !== false
  ui.instruction.value = cfg.instruction || BR_DEFAULT_INSTRUCTION
  renderCaptureToggle()
}

const save = (patch) => chrome.storage.local.set(patch)

/** Credentials for the current server, if any. Empty for a local one. */
const creds = () => ({ password: ui.password.value })

// ---------------------------------------------------------------- status

function setStatus(text, kind) {
  ui.status.textContent = text
  ui.status.className = `status ${kind || ""}`
}

async function validate() {
  const url = ui.server.value.trim() || BR_DEFAULTS.serverUrl
  save({ serverUrl: url, serverPassword: ui.password.value })
  setStatus("checking…", "")
  const res = await brProbe(url, creds())
  if (res.ok) setStatus(`connected — BountyReaper ${res.version}`, "ok")
  else setStatus(`not reachable: ${res.error}`, "err")
}

// ---------------------------------------------------------------- captures

function renderCaptureToggle() {
  ui.captureToggle.textContent = captureEnabled ? "● Capturing" : "○ Paused"
  ui.captureToggle.className = captureEnabled ? "toggle on" : "toggle off"
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: "get-captures", tabId })
  captures = (res && res.captures) || []
  renderList()
}

function renderList() {
  ui.count.textContent = `${captures.length} captured${captures.length >= BR_LIMITS.MAX_CAPTURED ? " (at cap)" : ""}`
  ui.list.textContent = ""

  // Newest first: the request you just triggered is the one you want.
  for (const c of [...captures].reverse()) {
    const row = document.createElement("div")
    row.className = "row" + (c.id === selectedId ? " selected" : "")
    row.tabIndex = 0

    const method = document.createElement("span")
    method.className = "method"
    method.textContent = c.method

    const status = document.createElement("span")
    status.className = "code s" + Math.floor((c.status || 0) / 100)
    status.textContent = c.status || "—"

    const path = document.createElement("span")
    path.className = "path"
    path.textContent = c.path
    path.title = c.url

    row.append(method, status, path)
    const select = () => {
      selectedId = c.id
      renderList()
      renderDetail(c)
    }
    row.addEventListener("click", select)
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        select()
      }
    })
    ui.list.append(row)
  }
}

function renderDetail(c) {
  const notes = []
  if (c.requestTruncated) notes.push("request body truncated")
  if (c.responseTruncated) notes.push("response body truncated")
  ui.detail.textContent =
    `${c.method} ${c.url}\n` +
    `status ${c.status} · ${c.mimeType || "unknown type"} · ${c.resourceType}` +
    (notes.length ? `\n[${notes.join("; ")}]` : "") +
    `\n\n${c.raw}`
  ui.send.disabled = false
}

const selected = () => captures.find((c) => c.id === selectedId)

// ---------------------------------------------------------------- send

function appendOutput(text) {
  const atBottom = ui.output.scrollTop + ui.output.clientHeight >= ui.output.scrollHeight - 24
  ui.output.textContent += text
  if (ui.output.textContent.length > BR_LIMITS.MAX_PROGRESS_CHARS) {
    ui.output.textContent = ui.output.textContent.slice(-BR_LIMITS.MAX_PROGRESS_CHARS)
  }
  // Only auto-scroll if the operator was already at the bottom — otherwise
  // reading earlier output while the stream runs is impossible.
  if (atBottom) ui.output.scrollTop = ui.output.scrollHeight
}

function streamEnded(note) {
  stopStream = null
  ui.send.disabled = !selected()
  ui.stop.disabled = true
  if (note) appendOutput(`\n\n[${note}]\n`)
}

async function send() {
  const c = selected()
  if (!c) return
  const url = ui.server.value.trim() || BR_DEFAULTS.serverUrl
  const instruction = ui.instruction.value.trim() || BR_DEFAULT_INSTRUCTION
  save({ serverUrl: url, instruction, serverPassword: ui.password.value })

  ui.output.textContent = ""
  ui.send.disabled = true
  ui.stop.disabled = false
  appendOutput(`> ${c.method} ${c.url}\n\n`)

  const res = await brSendCapture(url, c, { instruction, sessionID, ...creds() })
  if (!res.ok) {
    streamEnded(`send failed: ${res.error}`)
    return
  }
  // Reuse the session for subsequent sends so the agent keeps context across
  // several endpoints on the same target.
  sessionID = res.sessionID
  setStatus(`session ${sessionID.slice(0, 12)}…`, "ok")

  stopStream = brStreamSession(url, sessionID, {
    onText: (t) => {
      ui.output.textContent = ""
      appendOutput(`> ${c.method} ${c.url}\n\n${t}`)
    },
    onDone: () => streamEnded("done"),
    onError: (e) => streamEnded(`stream error: ${e}`),
    ...creds(),
  })
}

function stop() {
  if (stopStream) stopStream()
  streamEnded("stopped")
}

// ---------------------------------------------------------------- wiring

ui.validate.addEventListener("click", validate)
ui.refresh.addEventListener("click", refresh)
ui.send.addEventListener("click", send)
ui.stop.addEventListener("click", stop)

ui.captureToggle.addEventListener("click", () => {
  captureEnabled = !captureEnabled
  save({ captureEnabled })
  chrome.runtime.sendMessage({ type: "set-capture-enabled", enabled: captureEnabled })
  renderCaptureToggle()
})

ui.filterApi.addEventListener("change", () => {
  save({ filterApiOnly: ui.filterApi.checked })
  chrome.runtime.sendMessage({ type: "set-filter-api", filterApiOnly: ui.filterApi.checked })
})

ui.clear.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clear-captures", tabId })
  selectedId = null
  ui.detail.textContent = ""
  ui.send.disabled = true
  refresh()
})

// A closed panel must not leave a stream open against the operator's server.
window.addEventListener("unload", () => stopStream && stopStream())

loadConfig().then(() => {
  validate()
  refresh()
  setInterval(refresh, 2000)
})
