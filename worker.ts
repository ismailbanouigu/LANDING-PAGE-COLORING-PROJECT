import { getAssetFromKV } from '@cloudflare/kv-asset-handler'
import manifestJSON from '__STATIC_CONTENT_MANIFEST'

const assetManifest = JSON.parse(manifestJSON) as Record<string, string>

type GetAssetOptions = NonNullable<Parameters<typeof getAssetFromKV>[1]>
type AssetNamespace = GetAssetOptions extends { ASSET_NAMESPACE: infer N } ? N : unknown

export default {
  async fetch(
    request: Request,
    env: {
      __STATIC_CONTENT: AssetNamespace
      POLLINATIONS_API_KEY?: string
    },
    ctx: { waitUntil(promise: Promise<unknown>): void }
  ) {
    const url = new URL(request.url)

    if (url.pathname === '/api/status') {
      return new Response(JSON.stringify({ pollinationsConfigured: Boolean(env.POLLINATIONS_API_KEY) }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        },
      })
    }

    if (url.pathname === '/api/text-to-coloring') {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'POST,OPTIONS',
            'access-control-allow-headers': 'content-type',
            'access-control-max-age': '86400',
          },
        })
      }
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST,OPTIONS' },
        })
      }

      const key = env.POLLINATIONS_API_KEY
      if (!key) {
        return new Response(JSON.stringify({ error: 'Text generator is not configured on the server.' }), {
          status: 503,
          headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        })
      }

      let body: Record<string, unknown> | null = null
      try {
        const parsed = (await request.json()) as unknown
        body = parsed && typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
      } catch {
        body = null
      }

      const prompt = body && typeof body.prompt === 'string'
          ? String(body.prompt)
          : ''
      const style = body && typeof body.style === 'string'
          ? String(body.style)
          : 'Detailed'

      const trimmed = prompt.trim()
      if (!trimmed) {
        return new Response(JSON.stringify({ error: 'Missing prompt' }), {
          status: 400,
          headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        })
      }

      const styleHintMap: Record<string, string> = {
        Simple: 'simple shapes, minimal detail',
        Detailed: 'high detail, intricate outlines',
        Realistic: 'realistic proportions, natural details',
        Cartoon: 'cute cartoon style, clean outlines',
        Mandala: 'mandala patterns, symmetric ornamental details',
      }
      const styleHint = styleHintMap[style] || styleHintMap.Detailed
      const coloringPrompt = `${trimmed}, ${styleHint}, black and white coloring page, clean bold outlines, no shading, no colors, white background, printable, suitable for kids coloring book, line art`

      const target = `https://gen.pollinations.ai/image/${encodeURIComponent(
        coloringPrompt
      )}?model=flux&width=1024&height=1024&nologo=true&private=true&safe=true`
      const resp = await fetch(target, {
        cf: { cacheEverything: true, cacheTtl: 3600 },
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'image/*',
        },
      })
      if (!resp.ok) {
        let details: string | undefined
        try {
          const txt = await resp.text()
          details = txt && txt.length < 500 ? txt : undefined
        } catch {
          details = undefined
        }
        return new Response(JSON.stringify({ error: 'Upstream error', status: resp.status, details }), {
          status: resp.status,
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
            'cache-control': 'no-store',
          },
        })
      }
      const ct = resp.headers.get('content-type') || 'image/jpeg'
      return new Response(resp.body, {
        status: resp.status,
        headers: {
          'content-type': ct,
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=3600',
        },
      })
    }

    if (url.pathname === '/models/lineart.onnx') {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET,HEAD,OPTIONS',
            'access-control-allow-headers': 'content-type',
            'access-control-max-age': '86400',
          },
        })
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET,HEAD,OPTIONS',
          },
        })
      }

      const upstreamUrl =
        'https://huggingface.co/rocca/informative-drawings-line-art-onnx/resolve/main/model.onnx?download=true'

      const upstream = await fetch(upstreamUrl, {
        cf: { cacheEverything: true, cacheTtl: 31536000 },
      })

      const contentType = upstream.headers.get('content-type') || 'application/octet-stream'
      const contentLength = upstream.headers.get('content-length')
      const etag = upstream.headers.get('etag')

      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'content-type': contentType,
          ...(contentLength ? { 'content-length': contentLength } : {}),
          ...(etag ? { etag } : {}),
          'cache-control': 'public, max-age=31536000, immutable',
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,HEAD,OPTIONS',
        },
      })
    }

    const baseOptions = {
      ASSET_NAMESPACE: env.__STATIC_CONTENT,
      ASSET_MANIFEST: assetManifest,
    } satisfies GetAssetOptions

    try {
      return await getAssetFromKV(
        { request, waitUntil: ctx.waitUntil.bind(ctx) },
        baseOptions
      )
    } catch {
      try {
        const origin = new URL(request.url).origin
        const notFoundResponse = await getAssetFromKV(
          { request, waitUntil: ctx.waitUntil.bind(ctx) },
          {
            ...baseOptions,
            mapRequestToAsset: () => new Request(`${origin}/index.html`, request),
          } as GetAssetOptions
        )
        return new Response(notFoundResponse.body, {
          status: 200,
          headers: notFoundResponse.headers,
        })
      } catch {
        return new Response('Not Found', { status: 404 })
      }
    }
  },
}
