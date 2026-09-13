import { FitAddon, Ghostty, Terminal } from "ghostty-web"

interface Config {
  port: number
  ptyID: string
  wasm: string
}

declare global {
  interface Window {
    BOUNTYREPER: Config
  }
}

const config = window.BOUNTYREPER

const container = document.getElementById("terminal")!

let cursor = 0
let ws: WebSocket | undefined
let retry: ReturnType<typeof setTimeout> | undefined

const theme = {
  background: "#191515",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  cursorAccent: "#191515",
  selectionBackground: "#d4d4d440",
}

const pushSize = (cols: number, rows: number) => {
  return fetch(`http://127.0.0.1:${config.port}/pty/${config.ptyID}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ size: { cols, rows } }),
  })
}

async function boot() {
  const ghostty = await Ghostty.load(config.wasm)
  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: "bar",
    fontSize: 14,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
    theme,
    scrollback: 10_000,
    ghostty,
  })

  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(container)
  fit.observeResize()

  term.onData((data) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(data)
  })

  term.onResize((size) => {
    void pushSize(size.cols, size.rows)
  })

  document.fonts.ready.then(() => fit.fit())

  const connect = () => {
    const socket = new WebSocket(`ws://127.0.0.1:${config.port}/pty/${config.ptyID}/connect?cursor=${cursor}`)
    socket.binaryType = "arraybuffer"
    ws = socket

    socket.onopen = () => {
      fit.fit()
      void pushSize(term.cols, term.rows)
    }

    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        // control frame: 0x00 + UTF-8 JSON (currently { cursor })
        const bytes = new Uint8Array(event.data)
        if (bytes[0] !== 0) return
        try {
          const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as { cursor?: unknown }
          if (typeof meta.cursor === "number" && Number.isSafeInteger(meta.cursor) && meta.cursor >= 0) {
            cursor = meta.cursor
          }
        } catch {}
        return
      }

      const data = typeof event.data === "string" ? event.data : ""
      if (!data) return
      cursor += data.length
      term.write(data)
    }

    socket.onclose = (event) => {
      if (event.code === 1000) {
        container.dataset.status = "exited"
        return
      }
      if (retry) return
      retry = setTimeout(() => {
        retry = undefined
        connect()
      }, 1000)
    }
  }

  connect()
}

boot()
