import { test, expect } from "bun:test"
import path from "path"
import { createServer, type Server } from "node:http"
import { streamText } from "ai"

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRetry } from "../../src/session/retry"
import { ResponseStreamError } from "../../src/provider/error"

// Adapted from opencode's test/provider/header-timeout.test.ts (Effect style → bun:test style).

function sseBody(text: string) {
  const chunk = {
    id: "1",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  }
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`
}

function bodyServer(text: string, delay: number) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.flushHeaders()
    setTimeout(() => {
      res.write(sseBody(text))
      res.end()
    }, delay)
  })
  return new Promise<Server>((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)))
}

function headerServer(text: string, delay: number) {
  const server = createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(sseBody(text))
      res.end()
    }, delay)
  })
  return new Promise<Server>((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)))
}

function url(server: Server) {
  const address = server.address()
  if (typeof address === "string" || !address) throw new Error("no address")
  return `http://127.0.0.1:${address.port}/v1`
}

function config(url: string, options: Record<string, unknown>) {
  return {
    $schema: "https://bountyreper.io/config.json",
    provider: {
      test: {
        name: "test",
        npm: "@ai-sdk/openai-compatible",
        api: url,
        models: {
          "test-model": {
            name: "test-model",
            tool_call: true,
            limit: { context: 128000, output: 4096 },
          },
        },
        options: { apiKey: "test", ...options },
      },
    },
  }
}

async function session(server: Server, options: Record<string, unknown>, fn: () => Promise<void>) {
  const tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "bountyreper.json"), JSON.stringify(config(url(server), options)))
    },
  })
  try {
    await Instance.provide({ directory: tmp.path, fn })
  } finally {
    server.close()
    await tmp[Symbol.asyncDispose]()
  }
}

test("headerTimeout does not abort delayed SSE body after headers arrive", async () => {
  const server = await bodyServer("late", 1_000)
  await session(
    server,
    { headerTimeout: 500 },
    async () => {
      const model = await Provider.getModel("test", "test-model")
      const result = streamText({
        model: await Provider.getLanguage(model),
        messages: [{ role: "user", content: "hello" }],
      })
      expect(await result.text).toBe("late")
    },
  )
})

test("configured chunkTimeout raises a retryable response stream error when SSE body stalls", async () => {
  const server = await bodyServer("late", 250)
  await session(
    server,
    { chunkTimeout: 50 },
    async () => {
      const model = await Provider.getModel("test", "test-model")
      const result = streamText({
        model: await Provider.getLanguage(model),
        onError() {},
        messages: [{ role: "user", content: "hello" }],
      })

      const error = await (async () => {
        try {
          for await (const part of result.fullStream) {
            if (part.type === "error") return part.error
          }
        } catch (error) {
          return error
        }
      })()
      expect(error).toBeInstanceOf(ResponseStreamError)

      const info = MessageV2.fromError(error, { providerID: model.providerID })
      expect(SessionRetry.retryable(info)).toEqual("SSE read timed out")
    },
  )
})

test("heartbeat keepalive comments do not count as chunk progress", async () => {
  const server = await new Promise<Server>((resolve) => {
    const s = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.flushHeaders()
      const tick = setInterval(() => res.write(": ping\n\n"), 25)
      res.on("close", () => clearInterval(tick))
    })
    s.listen(0, "127.0.0.1", () => resolve(s))
  })
  await session(
    server,
    { chunkTimeout: 200 },
    async () => {
      const model = await Provider.getModel("test", "test-model")
      const result = streamText({
        model: await Provider.getLanguage(model),
        onError() {},
        messages: [{ role: "user", content: "hello" }],
      })

      const error = await (async () => {
        try {
          for await (const part of result.fullStream) {
            if (part.type === "error") return part.error
          }
        } catch (error) {
          return error
        }
      })()
      expect(error).toBeInstanceOf(ResponseStreamError)
    },
  )
})

test("heartbeat drip before first data still succeeds when data arrives in time", async () => {
  const server = await new Promise<Server>((resolve) => {
    const s = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.flushHeaders()
      const tick = setInterval(() => res.write(": ping\n\n"), 25)
      res.on("close", () => clearInterval(tick))
      setTimeout(() => {
        clearInterval(tick)
        res.write(sseBody("late"))
        res.end()
      }, 350)
    })
    s.listen(0, "127.0.0.1", () => resolve(s))
  })
  await session(
    server,
    { chunkTimeout: 500 },
    async () => {
      const model = await Provider.getModel("test", "test-model")
      const result = streamText({
        model: await Provider.getLanguage(model),
        messages: [{ role: "user", content: "hello" }],
      })
      expect(await result.text).toBe("late")
    },
  )
})

test("chunkTimeout can be disabled with false", async () => {
  const server = await bodyServer("late", 250)
  await session(
    server,
    { chunkTimeout: false },
    async () => {
      const configured = await Provider.getProvider("test")
      expect(configured?.options?.chunkTimeout).toBe(false)
      const model = await Provider.getModel("test", "test-model")
      const result = streamText({
        model: await Provider.getLanguage(model),
        messages: [{ role: "user", content: "hello" }],
      })
      expect(await result.text).toBe("late")
    },
  )
})

test("headerTimeout aborts when response headers do not arrive", async () => {
  const server = await headerServer("ok", 250)
  await session(
    server,
    { headerTimeout: 50 },
    async () => {
      const model = await Provider.getModel("test", "test-model")
      const result = streamText({
        model: await Provider.getLanguage(model),
        onError() {},
        messages: [{ role: "user", content: "hello" }],
      })

      const errors: string[] = []
      for await (const part of result.fullStream) {
        if (part.type === "error") errors.push(String(part.error))
      }
      expect(errors.join("\n")).toContain("response headers timed out")
    },
  )
})

test("headerTimeout can be disabled with false", async () => {
  const server = await headerServer("ok", 100)
  await session(
    server,
    { headerTimeout: false },
    async () => {
      const model = await Provider.getModel("test", "test-model")
      const result = streamText({
        model: await Provider.getLanguage(model),
        messages: [{ role: "user", content: "hello" }],
      })
      expect(await result.text).toBe("ok")
    },
  )
})

test("default timeouts are applied at fetch without changing provider options", async () => {
  const server = await bodyServer("ok", 250)
  await session(server, {}, async () => {
    const configured = await Provider.getProvider("test")
    const signals: (AbortSignal | null | undefined)[] = []
    configured!.options = configured!.options ?? {}
    configured!.options["fetch"] = (input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal)
      return fetch(input, init)
    }
    const model = await Provider.getModel("test", "test-model")
    const language = await Provider.getLanguage(model)
    const result = await language.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    })
    await result.stream.cancel()

    expect(signals).toHaveLength(1)
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    expect(configured!.options?.chunkTimeout).toBeUndefined()
    expect(configured!.options?.headerTimeout).toBeUndefined()
  })
})
