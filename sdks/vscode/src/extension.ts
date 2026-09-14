// This method is called when your extension is deactivated
export function deactivate() {}

import { spawn, type ChildProcess } from "child_process"
import { randomUUID } from "node:crypto"
import * as vscode from "vscode"

const TERMINAL_NAME = "bountyreaper"

let extensionRoot: vscode.Uri

let sidebarChild: ChildProcess | undefined
let sidebarPort: number | undefined
let sidebarPty: string | undefined

class SidebarProvider implements vscode.WebviewViewProvider {
  async resolveWebviewView(view: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: vscode.CancellationToken) {
    void context
    void token
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionRoot, "dist")],
    }
    view.webview.html = `<html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:gray">Starting bountyreaper...</body></html>`

    const port = await startSidebarServer()
    if (!port) {
      view.webview.html = `<html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:gray">Failed to start bountyreaper. Is it installed and on your PATH?</body></html>`
      return
    }

    const pty = sidebarPty ?? (await createTuiPty(port))
    if (!pty) {
      view.webview.html = `<html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:gray">Failed to start the bountyreaper TUI.</body></html>`
      return
    }
    sidebarPty = pty

    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(extensionRoot, "dist", "webview", "main.js"))
    const wasm = view.webview.asWebviewUri(vscode.Uri.joinPath(extensionRoot, "dist", "ghostty-vt.wasm"))
    const csp = view.webview.cspSource
    view.webview.html = `<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'wasm-unsafe-eval' ${csp}; style-src ${csp} 'unsafe-inline'; connect-src ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:* http://localhost:*; font-src ${csp} data:; img-src ${csp} data:;">
<style>html,body{margin:0;padding:0;height:100%;background:#191515;overflow:hidden}#terminal{width:100vw;height:100vh}</style>
</head>
<body>
<div id="terminal"></div>
<script>window.BOUNTYREAPER = { port: ${port}, ptyID: "${pty}", wasm: "${wasm}" };</script>
<script src="${script}"></script>
</body>
</html>`
  }
}

async function startSidebarServer(): Promise<number | undefined> {
  if (sidebarPort && sidebarChild && sidebarChild.exitCode === null) {
    return sidebarPort
  }

  // Newer CLIs accept --no-open; older ones reject unknown flags and exit
  // immediately, so retry without it (the browser may open once as a side effect)
  return (await spawnSidebarServer(true)) ?? (await spawnSidebarServer(false))
}

async function spawnSidebarServer(noOpen: boolean): Promise<number | undefined> {
  const port = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384
  // Login shell so `bountyreaper` resolves via the user's interactive PATH,
  // matching the terminal-based flow. detached on POSIX so the whole process
  // group (shell + server) can be killed on dispose.
  const command = `bountyreaper web --port ${port} --hostname 127.0.0.1${noOpen ? " --no-open" : ""}`
  sidebarChild =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/c", command], {
          env: { ...process.env, BOUNTYREAPER_SERVER_PASSWORD: randomUUID(), BOUNTYREAPER_CALLER: "vscode" },
          stdio: "ignore",
        })
      : spawn(process.env.SHELL || "/bin/zsh", ["-lc", command], {
          env: { ...process.env, BOUNTYREAPER_SERVER_PASSWORD: randomUUID(), BOUNTYREAPER_CALLER: "vscode" },
          stdio: "ignore",
          detached: true,
        })

  // A rejected flag exits the process within a second
  await new Promise((resolve) => setTimeout(resolve, 1000))
  if (sidebarChild.exitCode !== null) {
    return
  }

  // Generous timeout — the server does a cold start (providers, db, migrations)
  const connected = await waitForServer(port, 50)
  if (!connected) {
    stopSidebarServer()
    return
  }

  sidebarPort = port
  return port
}

function stopSidebarServer() {
  const child = sidebarChild
  sidebarChild = undefined
  sidebarPort = undefined
  sidebarPty = undefined
  if (!child?.pid) {
    return
  }

  if (process.platform === "win32") {
    child.kill()
    return
  }

  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {}
}

async function waitForServer(port: number, tries = 10) {
  do {
    await new Promise((resolve) => setTimeout(resolve, 200))
    try {
      await fetch(`http://localhost:${port}/app`)
      return true
    } catch {}
    tries--
  } while (tries > 0)
  return false
}

// Runs the real bountyreaper TUI (attach) inside a PTY owned by the headless
// server, so the webview terminal can stream it over the /pty websocket
async function createTuiPty(port: number): Promise<string | undefined> {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

  // Clean up any stale sessions from a previous webview/extension state
  try {
    const existing = (await (await fetch(`http://127.0.0.1:${port}/pty`)).json()) as { id: string }[]
    for (const pty of existing) {
      await fetch(`http://127.0.0.1:${port}/pty/${pty.id}`, { method: "DELETE" })
    }
  } catch {}

  const response = await fetch(`http://127.0.0.1:${port}/pty`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      command: "bountyreaper",
      args: ["attach", `http://127.0.0.1:${port}`],
      cwd: workspace ?? process.env.HOME,
      title: TERMINAL_NAME,
    }),
  })
  if (!response.ok) {
    return
  }

  const info = (await response.json()) as { id?: string }
  return info.id
}

export function activate(context: vscode.ExtensionContext) {
  extensionRoot = context.extensionUri

  let openNewTerminalDisposable = vscode.commands.registerCommand("bountyreaper.openNewTerminal", async () => {
    await openTerminal(true)
  })

  let openTerminalDisposable = vscode.commands.registerCommand("bountyreaper.openTerminal", async () => {
    // An bountyreaper terminal already exists => focus it
    const existingTerminal = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME)
    if (existingTerminal) {
      existingTerminal.show()
      return
    }

    await openTerminal()
  })

  let addFilepathDisposable = vscode.commands.registerCommand("bountyreaper.addFilepathToTerminal", async () => {
    const fileRef = getActiveFile()
    if (!fileRef) {
      return
    }

    const terminal = vscode.window.activeTerminal
    if (terminal?.name === TERMINAL_NAME) {
      // @ts-ignore
      const port = terminal.creationOptions.env?.["_EXTENSION_BOUNTYREAPER_PORT"]
      port ? await appendPrompt(parseInt(port), fileRef) : terminal.sendText(fileRef, false)
      terminal.show()
      return
    }

    // The sidebar TUI subscribes to the same prompt-append event
    if (sidebarPort && sidebarChild?.exitCode === null) {
      await appendPrompt(sidebarPort, fileRef)
      await vscode.commands.executeCommand("bountyreaper.chat.focus")
    }
  })

  let openSidebarDisposable = vscode.commands.registerCommand("bountyreaper.openSidebar", async () => {
    await vscode.commands.executeCommand("bountyreaper.chat.focus")
  })

  const sidebarProvider = vscode.window.registerWebviewViewProvider("bountyreaper.chat", new SidebarProvider(), {
    webviewOptions: { retainContextWhenHidden: true },
  })

  context.subscriptions.push(
    openTerminalDisposable,
    openNewTerminalDisposable,
    addFilepathDisposable,
    openSidebarDisposable,
    sidebarProvider,
    { dispose: stopSidebarServer },
  )

  async function openTerminal(beside?: boolean) {
    // Create a new terminal in split screen
    const port = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384
    const terminal = vscode.window.createTerminal({
      name: TERMINAL_NAME,
      iconPath: {
        light: vscode.Uri.file(context.asAbsolutePath("images/button-dark.svg")),
        dark: vscode.Uri.file(context.asAbsolutePath("images/button-light.svg")),
      },
      location: beside
        ? {
            viewColumn: vscode.ViewColumn.Beside,
            preserveFocus: false,
          }
        : vscode.TerminalLocation.Panel,
      env: {
        _EXTENSION_BOUNTYREAPER_PORT: port.toString(),
        BOUNTYREAPER_CALLER: "vscode",
      },
    })

    terminal.show()
    terminal.sendText(`bountyreaper --port ${port}`)

    const fileRef = getActiveFile()
    if (!fileRef) {
      return
    }

    // Wait for the terminal to be ready
    const connected = await waitForServer(port)

    // If connected, append the prompt to the terminal
    if (connected) {
      await appendPrompt(port, `In ${fileRef}`)
      terminal.show()
    }
  }

  async function appendPrompt(port: number, text: string) {
    await fetch(`http://localhost:${port}/tui/append-prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    })
  }

  function getActiveFile() {
    const activeEditor = vscode.window.activeTextEditor
    if (!activeEditor) {
      return
    }

    const document = activeEditor.document
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
    if (!workspaceFolder) {
      return
    }

    // Get the relative path from workspace root
    const relativePath = vscode.workspace.asRelativePath(document.uri)
    let filepathWithAt = `@${relativePath}`

    // Check if there's a selection and add line numbers
    const selection = activeEditor.selection
    if (!selection.isEmpty) {
      // Convert to 1-based line numbers
      const startLine = selection.start.line + 1
      const endLine = selection.end.line + 1

      if (startLine === endLine) {
        // Single line selection
        filepathWithAt += `#L${startLine}`
      } else {
        // Multi-line selection
        filepathWithAt += `#L${startLine}-${endLine}`
      }
    }

    return filepathWithAt
  }
}
