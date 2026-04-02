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
      DEEPAI_API_KEY?: string
    },
    ctx: { waitUntil(promise: Promise<unknown>): void }
  ) {
    const url = new URL(request.url)

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

    if (url.pathname === '/api/edit-image') {
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
      const prompt = url.searchParams.get('prompt') || ''
      const model = url.searchParams.get('model') || 'kontext'
      const image = url.searchParams.get('image') || ''
      const key = env.POLLINATIONS_API_KEY
      if (!key) {
        return new Response(JSON.stringify({ error: 'Missing POLLINATIONS_API_KEY' }), {
          status: 500,
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET,HEAD,OPTIONS',
          },
        })
      }
      const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(
        prompt
      )}?model=${encodeURIComponent(model)}&nologo=true&image=${encodeURIComponent(image)}&key=${encodeURIComponent(
        key
      )}`
      const resp = await fetch(pollinationsUrl)
      const contentType = resp.headers.get('content-type') || 'image/jpeg'
      return new Response(resp.body, {
        status: resp.status,
        headers: {
          'content-type': contentType,
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,HEAD,OPTIONS',
          'cache-control': 'no-store',
        },
      })
    }

    if (url.pathname === '/api/deepai-colorize') {
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

      const key = env.DEEPAI_API_KEY || 'quickstart-QUdJIGlzIGNvbWluZy4uLi4K'

      const upstream = await fetch('https://api.deepai.org/api/colorizer', {
        method: 'POST',
        headers: {
          'Api-Key': key,
          'api-key': key,
          'content-type': request.headers.get('content-type') || 'application/octet-stream',
        },
        body: request.body,
      })

      const contentType = upstream.headers.get('content-type') || 'application/json'
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'content-type': contentType,
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
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
