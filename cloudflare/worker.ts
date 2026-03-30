type Env = {
  POLLINATIONS_API_KEY?: string
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  headers.set('access-control-allow-origin', '*')
  headers.set('access-control-allow-methods', 'GET,POST,OPTIONS')
  headers.set('access-control-allow-headers', 'content-type, authorization')
  return new Response(JSON.stringify(body), { ...init, headers })
}

function withCorsHeaders(response: Response) {
  const headers = new Headers(response.headers)
  headers.set('access-control-allow-origin', '*')
  headers.set('access-control-allow-methods', 'GET,POST,OPTIONS')
  headers.set('access-control-allow-headers', 'content-type, authorization')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function getStringParam(url: URL, key: string) {
  const value = url.searchParams.get(key)
  return value ? value.trim() : null
}

function authHeaders(env: Env) {
  const apiKey = env.POLLINATIONS_API_KEY?.trim()
  if (!apiKey) return undefined
  return { Authorization: `Bearer ${apiKey}` }
}

function rejectSecretKeyInQuery(keyFromQuery: string | null) {
  if (!keyFromQuery) return null
  if (keyFromQuery.startsWith('sk_')) {
    return jsonResponse(
      { success: false, error: { message: 'Do not pass secret keys in URLs. Use server secret POLLINATIONS_API_KEY or a pk_ key.' } },
      { status: 400 }
    )
  }
  return null
}

async function proxyBinary(upstreamUrl: string, init: RequestInit, cacheSeconds: number) {
  const upstream = await fetch(upstreamUrl, init)
  const headers = new Headers()
  const contentType = upstream.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)
  headers.set('cache-control', `public, max-age=${cacheSeconds}`)
  headers.set('cross-origin-resource-policy', 'cross-origin')
  headers.set('access-control-allow-origin', '*')
  headers.set('access-control-allow-methods', 'GET,POST,OPTIONS')
  headers.set('access-control-allow-headers', 'content-type, authorization')
  return new Response(upstream.body, { status: upstream.status, headers })
}

export default {
  async fetch(request: Request, env: Env) {
    if (request.method === 'OPTIONS') return withCorsHeaders(new Response(null, { status: 204 }))

    const url = new URL(request.url)
    const path = url.pathname

    if (!path.startsWith('/api/pollinations/')) {
      return jsonResponse({ success: false, error: { message: 'Not found.' } }, { status: 404 })
    }

    const subPath = path.slice('/api/pollinations/'.length)
    const apiKey = env.POLLINATIONS_API_KEY?.trim() || ''

    if (subPath === 'status') {
      return jsonResponse({ keyPresent: Boolean(apiKey) }, { status: 200 })
    }

    if (subPath === 'fetch') {
      const urlString = getStringParam(url, 'url')
      if (!urlString) return jsonResponse({ success: false, error: { message: 'Missing url.' } }, { status: 400 })
      let upstreamUrl: URL
      try {
        upstreamUrl = new URL(urlString)
      } catch {
        return jsonResponse({ success: false, error: { message: 'Invalid url.' } }, { status: 400 })
      }
      if (upstreamUrl.protocol !== 'https:') return jsonResponse({ success: false, error: { message: 'Only https urls are allowed.' } }, { status: 400 })
      if (!upstreamUrl.hostname.endsWith('pollinations.ai')) return jsonResponse({ success: false, error: { message: 'Only pollinations.ai urls are allowed.' } }, { status: 400 })

      const headers = authHeaders(env)
      return proxyBinary(upstreamUrl.toString(), headers ? { headers } : {}, 3600)
    }

    if (subPath === 'upload') {
      if (request.method !== 'POST') return jsonResponse({ success: false, error: { message: 'Method not allowed.' } }, { status: 405 })
      const contentType = request.headers.get('content-type') || ''
      if (!contentType.includes('multipart/form-data')) {
        return jsonResponse({ success: false, error: { message: 'Expected multipart/form-data.' } }, { status: 400 })
      }

      let form: FormData
      try {
        form = await request.formData()
      } catch {
        return jsonResponse({ success: false, error: { message: 'Invalid form data.' } }, { status: 400 })
      }

      const fileField = (form.get('file') ?? form.get('image')) as unknown
      if (!(fileField instanceof File)) {
        return jsonResponse({ success: false, error: { message: 'Missing image file.' } }, { status: 400 })
      }
      if (!fileField.type.startsWith('image/')) {
        return jsonResponse({ success: false, error: { message: 'Only image uploads are allowed.' } }, { status: 400 })
      }
      if (fileField.size > 10 * 1024 * 1024) {
        return jsonResponse({ success: false, error: { message: 'File too large. Max 10MB.' } }, { status: 400 })
      }

      const upstreamForm = new FormData()
      upstreamForm.append('file', fileField, fileField.name || 'image')
      const headers = authHeaders(env)
      const upstream = await fetch('https://media.pollinations.ai/upload', { method: 'POST', headers, body: upstreamForm })
      const text = await upstream.text()
      if (!upstream.ok) {
        return jsonResponse({ success: false, error: { message: text || 'Upload failed' } }, { status: upstream.status })
      }
      try {
        const data = JSON.parse(text) as unknown
        return jsonResponse(data, { status: 200 })
      } catch {
        return jsonResponse({ success: false, error: { message: 'Upload returned invalid JSON.' } }, { status: 502 })
      }
    }

    if (subPath === 'chat') {
      if (!apiKey) return jsonResponse({ success: false, error: { message: 'Missing POLLINATIONS_API_KEY on the server.' } }, { status: 500 })
      if (request.method !== 'POST') return jsonResponse({ success: false, error: { message: 'Method not allowed.' } }, { status: 405 })
      const upstream = await fetch('https://gen.pollinations.ai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: await request.text(),
      })
      return withCorsHeaders(new Response(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json; charset=utf-8' } }))
    }

    if (subPath === 'image' || subPath === 'text') {
      const prompt = getStringParam(url, 'prompt')
      if (!prompt) return jsonResponse({ success: false, error: { message: 'Missing prompt.' } }, { status: 400 })
      const keyFromQuery = getStringParam(url, 'key')
      const reject = rejectSecretKeyInQuery(keyFromQuery)
      if (reject) return reject

      const upstreamBase =
        subPath === 'image'
          ? `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}`
          : `https://gen.pollinations.ai/text/${encodeURIComponent(prompt)}`

      const upstreamUrl = new URL(upstreamBase)
      for (const [k, v] of url.searchParams.entries()) {
        if (k === 'prompt' || k === 'key') continue
        upstreamUrl.searchParams.set(k, v)
      }

      if (subPath === 'image' && !upstreamUrl.searchParams.get('model')) upstreamUrl.searchParams.set('model', 'flux')
      if (keyFromQuery && keyFromQuery.startsWith('pk_')) upstreamUrl.searchParams.set('key', keyFromQuery)

      const headers = authHeaders(env)
      if (!headers && !(keyFromQuery && keyFromQuery.startsWith('pk_'))) {
        return jsonResponse({ success: false, error: { message: 'Authentication required. Configure POLLINATIONS_API_KEY on the server, or provide a pk_ key.' } }, { status: 401 })
      }

      if (subPath === 'image') {
        return proxyBinary(upstreamUrl.toString(), headers ? { headers } : {}, 3600)
      }

      const upstream = await fetch(upstreamUrl.toString(), headers ? { headers } : undefined)
      return withCorsHeaders(new Response(await upstream.text(), { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') || 'text/plain; charset=utf-8' } }))
    }

    return jsonResponse({ success: false, error: { message: 'Not found.' } }, { status: 404 })
  },
}
