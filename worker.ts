import { getAssetFromKV } from '@cloudflare/kv-asset-handler'
import manifestJSON from '__STATIC_CONTENT_MANIFEST'

const assetManifest = JSON.parse(manifestJSON) as Record<string, string>

type GetAssetOptions = NonNullable<Parameters<typeof getAssetFromKV>[1]>
type AssetNamespace = GetAssetOptions extends { ASSET_NAMESPACE: infer N } ? N : unknown

export default {
  async fetch(
    request: Request,
    env: { __STATIC_CONTENT: AssetNamespace },
    ctx: { waitUntil(promise: Promise<unknown>): void }
  ) {
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
