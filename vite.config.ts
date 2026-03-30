import path from "path"
import react from "@vitejs/plugin-react"
import type { Connect, Plugin } from "vite"
import { defineConfig, loadEnv } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'
import type { ServerResponse } from "node:http"
import Busboy from "busboy"

import { cloudflare } from "@cloudflare/vite-plugin";

function pollinationsProxy(): Plugin {
  const readRequestBodyText = async (req: Connect.IncomingMessage) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks).toString("utf8")
  }

  const sendJson = (res: ServerResponse, statusCode: number, body: unknown) => {
    res.statusCode = statusCode
    res.setHeader("content-type", "application/json; charset=utf-8")
    res.end(JSON.stringify(body))
  }

  const attach = (middlewares: Connect.Server) => {
    middlewares.use(async (req, res, next) => {
      if (typeof req.url !== "string") return next()

      if (req.url.startsWith("/api/pollinations/status")) {
        sendJson(res, 200, { keyPresent: Boolean(process.env.POLLINATIONS_API_KEY) })
        return
      }

      const apiKey = process.env.POLLINATIONS_API_KEY

      if (req.url.startsWith("/api/convert-coloring")) {
        sendJson(res, 404, {
          success: false,
          error: { message: "Photo conversion API is not available in dev. Deploy Firebase Functions (see FIREBASE_DEPLOY.md)." },
          status: 404,
        })
        return
      }

      if (!apiKey && (req.url.startsWith("/api/pollinations/chat") || req.url.startsWith("/api/pollinations/image/models") || req.url.startsWith("/api/pollinations/text/models"))) {
        sendJson(res, 500, { error: "Missing POLLINATIONS_API_KEY on the server." })
        return
      }

      if (req.url.startsWith("/api/pollinations/image/models")) {
        try {
          const upstreamResponse = await fetch("https://gen.pollinations.ai/image/models", {
            headers: { Authorization: `Bearer ${apiKey}` },
          })
          res.statusCode = upstreamResponse.status
          res.setHeader("content-type", "application/json; charset=utf-8")
          res.end(await upstreamResponse.text())
          return
        } catch (err) {
          sendJson(res, 502, { error: "Upstream request failed.", detail: err instanceof Error ? err.message : String(err) })
          return
        }
      }

      if (req.url.startsWith("/api/pollinations/text/models")) {
        try {
          const upstreamResponse = await fetch("https://gen.pollinations.ai/text/models", {
            headers: { Authorization: `Bearer ${apiKey}` },
          })
          res.statusCode = upstreamResponse.status
          res.setHeader("content-type", "application/json; charset=utf-8")
          res.end(await upstreamResponse.text())
          return
        } catch (err) {
          sendJson(res, 502, { error: "Upstream request failed.", detail: err instanceof Error ? err.message : String(err) })
          return
        }
      }

      if (req.url.startsWith("/api/pollinations/upload")) {
        if (req.method !== "POST") {
          sendJson(res, 405, { success: false, error: { message: "Method not allowed." } })
          return
        }

        const contentType = req.headers["content-type"]
        if (typeof contentType !== "string" || !contentType.includes("multipart/form-data")) {
          sendJson(res, 400, { success: false, error: { message: "Expected multipart/form-data." } })
          return
        }

        const maxBytes = 10 * 1024 * 1024

        try {
          const parsed = await new Promise<{
            imageBuffer: Buffer
            imageMime: string
            imageFilename: string
          }>((resolve, reject) => {
            const busboy = Busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: 1 } })
            let imageBuffer: Buffer | null = null
            let imageMime = ""
            let imageFilename = "image"
            let fileTooLarge = false

            busboy.on("file", (name: string, file: NodeJS.ReadableStream, info: { filename?: string; mimeType?: string }) => {
              if (name !== "file" && name !== "image") {
                file.resume()
                return
              }

              const filename = typeof info?.filename === "string" ? info.filename : "image"
              const mimeType = typeof info?.mimeType === "string" ? info.mimeType : ""

              imageFilename = filename
              imageMime = mimeType

              if (!imageMime.startsWith("image/")) {
                file.resume()
                reject(new Error("Only image uploads are allowed."))
                return
              }

              const chunks: Buffer[] = []
              let total = 0

              file.on("data", (chunk: Buffer) => {
                total += chunk.length
                if (total > maxBytes) {
                  fileTooLarge = true
                  file.resume()
                  return
                }
                chunks.push(chunk)
              })

              file.on("limit", () => {
                fileTooLarge = true
              })

              file.on("end", () => {
                if (fileTooLarge) return
                imageBuffer = Buffer.concat(chunks)
              })
            })

            busboy.on("error", reject)
            busboy.on("finish", () => {
              if (fileTooLarge) {
                reject(new Error("File too large. Max 10MB."))
                return
              }
              if (!imageBuffer || !imageMime) {
                reject(new Error("Missing image file."))
                return
              }
              resolve({ imageBuffer, imageMime, imageFilename })
            })

            req.pipe(busboy)
          })

          const form = new FormData()
          form.append("file", new Blob([parsed.imageBuffer], { type: parsed.imageMime }), parsed.imageFilename)

          const upstreamResponse = await fetch("https://media.pollinations.ai/upload", {
            method: "POST",
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
            body: form,
          })

          const text = await upstreamResponse.text()
          if (!upstreamResponse.ok) {
            sendJson(res, upstreamResponse.status, { success: false, error: { message: text || "Upload failed" } })
            return
          }

          let json: unknown
          try {
            json = JSON.parse(text)
          } catch {
            sendJson(res, 502, { success: false, error: { message: "Upload returned invalid JSON" } })
            return
          }

          const record = json && typeof json === "object" ? (json as Record<string, unknown>) : null
          const url =
            record && typeof record.url === "string"
              ? record.url
              : record && typeof record.hash_url === "string"
                ? record.hash_url
                : null

          if (!url) {
            sendJson(res, 502, { success: false, error: { message: "Upload response missing url" } })
            return
          }

          sendJson(res, 200, { success: true, url })
          return
        } catch (err) {
          sendJson(res, 400, { success: false, error: { message: err instanceof Error ? err.message : String(err) } })
          return
        }
      }

      if (req.url.startsWith("/api/pollinations/fetch")) {
        const url = new URL(req.url, "http://localhost")
        const upstreamUrlString = url.searchParams.get("url")?.trim()
        if (!upstreamUrlString) {
          sendJson(res, 400, { error: "Missing url." })
          return
        }

        let upstreamUrl: URL
        try {
          upstreamUrl = new URL(upstreamUrlString)
        } catch {
          sendJson(res, 400, { error: "Invalid url." })
          return
        }

        if (upstreamUrl.protocol !== "https:" || !upstreamUrl.hostname.endsWith("pollinations.ai")) {
          sendJson(res, 400, { error: "Only https pollinations.ai urls are allowed." })
          return
        }

        try {
          const upstreamResponse = await fetch(upstreamUrl.toString(), apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined)
          res.statusCode = upstreamResponse.status
          const contentType = upstreamResponse.headers.get("content-type")
          if (contentType) res.setHeader("content-type", contentType)
          const buffer = Buffer.from(await upstreamResponse.arrayBuffer())
          res.end(buffer)
          return
        } catch (err) {
          sendJson(res, 502, { error: "Upstream request failed.", detail: err instanceof Error ? err.message : String(err) })
          return
        }
      }

      if (req.url.startsWith("/api/pollinations/image")) {
        const url = new URL(req.url, "http://localhost")
        const prompt = url.searchParams.get("prompt")?.trim()
        const keyFromQuery = url.searchParams.get("key")?.trim()

        if (!apiKey && !keyFromQuery?.startsWith("pk_")) {
          sendJson(res, 500, { error: "Missing POLLINATIONS_API_KEY on the server." })
          return
        }

        if (!prompt) {
          sendJson(res, 400, { error: "Missing prompt." })
          return
        }

        const upstreamUrl = new URL(
          `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}`
        )
        for (const [k, v] of url.searchParams.entries()) {
          if (k === "prompt" || k === "key") continue
          upstreamUrl.searchParams.set(k, v)
        }
        if (!upstreamUrl.searchParams.get("model")) upstreamUrl.searchParams.set("model", "flux")

        if (keyFromQuery?.startsWith("sk_")) {
          sendJson(res, 400, { error: "Do not pass secret keys in URLs. Use server env POLLINATIONS_API_KEY or a pk_ key." })
          return
        }

        let upstreamResponse: Response
        try {
          if (keyFromQuery?.startsWith("pk_")) {
            upstreamResponse = await fetch(upstreamUrl.toString() + `&key=${encodeURIComponent(keyFromQuery)}`)
          } else if (apiKey) {
            upstreamResponse = await fetch(upstreamUrl.toString(), { headers: { Authorization: `Bearer ${apiKey}` } })
          } else {
            sendJson(res, 500, { error: "Missing POLLINATIONS_API_KEY on the server." })
            return
          }
        } catch (err) {
          sendJson(res, 502, { error: "Upstream request failed.", detail: err instanceof Error ? err.message : String(err) })
          return
        }

        res.statusCode = upstreamResponse.status
        const contentType = upstreamResponse.headers.get("content-type")
        if (contentType) res.setHeader("content-type", contentType)
        const buffer = Buffer.from(await upstreamResponse.arrayBuffer())
        res.end(buffer)
        return
      }

      if (req.url.startsWith("/api/pollinations/text")) {
        const url = new URL(req.url, "http://localhost")
        const prompt = url.searchParams.get("prompt")?.trim()
        const keyFromQuery = url.searchParams.get("key")?.trim()

        if (!apiKey && !keyFromQuery?.startsWith("pk_")) {
          sendJson(res, 500, { error: "Missing POLLINATIONS_API_KEY on the server." })
          return
        }

        if (!prompt) {
          sendJson(res, 400, { error: "Missing prompt." })
          return
        }

        const upstreamUrl = new URL(
          `https://gen.pollinations.ai/text/${encodeURIComponent(prompt)}`
        )
        for (const [k, v] of url.searchParams.entries()) {
          if (k === "prompt" || k === "key") continue
          upstreamUrl.searchParams.set(k, v)
        }

        if (keyFromQuery?.startsWith("sk_")) {
          sendJson(res, 400, { error: "Do not pass secret keys in URLs. Use server env POLLINATIONS_API_KEY or a pk_ key." })
          return
        }

        if (keyFromQuery?.startsWith("pk_")) upstreamUrl.searchParams.set("key", keyFromQuery)

        let upstreamResponse: Response
        try {
          if (keyFromQuery?.startsWith("pk_")) {
            upstreamResponse = await fetch(upstreamUrl.toString())
          } else if (apiKey) {
            upstreamResponse = await fetch(upstreamUrl.toString(), { headers: { Authorization: `Bearer ${apiKey}` } })
          } else {
            sendJson(res, 500, { error: "Missing POLLINATIONS_API_KEY on the server." })
            return
          }
        } catch (err) {
          sendJson(res, 502, { error: "Upstream request failed.", detail: err instanceof Error ? err.message : String(err) })
          return
        }

        res.statusCode = upstreamResponse.status
        const contentType = upstreamResponse.headers.get("content-type")
        if (contentType) res.setHeader("content-type", contentType)
        const text = await upstreamResponse.text()
        res.end(text)
        return
      }

      if (req.url.startsWith("/api/pollinations/chat")) {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "Method not allowed." })
          return
        }

        const rawBody = await readRequestBodyText(req)
        let payload: unknown
        try {
          payload = rawBody ? JSON.parse(rawBody) : {}
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body." })
          return
        }

        let upstreamResponse: Response
        try {
          upstreamResponse = await fetch("https://gen.pollinations.ai/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          })
        } catch (err) {
          sendJson(res, 502, { error: "Upstream request failed.", detail: err instanceof Error ? err.message : String(err) })
          return
        }

        res.statusCode = upstreamResponse.status
        res.setHeader("content-type", "application/json; charset=utf-8")
        const json = await upstreamResponse.text()
        res.end(json)
        return
      }

      next()
    })
  }

  return {
    name: "pollinations-proxy",
    configureServer(server) {
      attach(server.middlewares)
    },
    configurePreviewServer(server) {
      attach(server.middlewares)
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  if (!process.env.POLLINATIONS_API_KEY && env.POLLINATIONS_API_KEY) {
    process.env.POLLINATIONS_API_KEY = env.POLLINATIONS_API_KEY
  }

  return {
    base: "./",
    plugins: [inspectAttr(), pollinationsProxy(), react(), cloudflare()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
})