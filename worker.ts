import { getAssetFromKV } from '@cloudflare/kv-asset-handler'

type Ctx = {
  waitUntil(promise: Promise<unknown>): void
}

export default {
  async fetch(request: Request, _env: unknown, ctx: Ctx) {
    const event = {
      request,
      waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p),
    } as unknown as Parameters<typeof getAssetFromKV>[0]

    try {
      return await getAssetFromKV(event)
    } catch {
      try {
        const origin = new URL(request.url).origin
        const notFoundResponse = await getAssetFromKV(event, {
          mapRequestToAsset: () => new Request(`${origin}/index.html`, request),
        })
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
