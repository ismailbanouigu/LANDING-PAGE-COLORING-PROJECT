const { onRequest } = require('firebase-functions/v2/https')
const { defineSecret } = require('firebase-functions/params')
const Busboy = require('busboy')

const POLLINATIONS_API_KEY = defineSecret('POLLINATIONS_API_KEY')

exports.pollinations = onRequest(
  { secrets: [POLLINATIONS_API_KEY] },
  async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }

    const path = typeof req.path === 'string' ? req.path : ''
    const apiKey = POLLINATIONS_API_KEY.value()

    if (path.endsWith('/status')) {
      res.status(200).json({ keyPresent: Boolean(apiKey) })
      return
    }

    const sendJson = (status, body) => {
      res.status(status).setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(body))
    }

    const safeGet = (key) => {
      const v = req.query[key]
      return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined
    }

    const buildQuery = (excludeKeys) => {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(req.query || {})) {
        if (excludeKeys.includes(k)) continue
        if (typeof v === 'string') params.set(k, v)
        else if (Array.isArray(v) && typeof v[0] === 'string') params.set(k, v[0])
      }
      return params
    }

    try {
      if (path.endsWith('/image/models')) {
        if (!apiKey) return sendJson(500, { error: 'Missing POLLINATIONS_API_KEY on the server.' })
        const upstream = await fetch('https://gen.pollinations.ai/image/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
        })
        res.status(upstream.status).setHeader('content-type', 'application/json; charset=utf-8')
        res.end(await upstream.text())
        return
      }

      if (path.endsWith('/text/models')) {
        if (!apiKey) return sendJson(500, { error: 'Missing POLLINATIONS_API_KEY on the server.' })
        const upstream = await fetch('https://gen.pollinations.ai/text/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
        })
        res.status(upstream.status).setHeader('content-type', 'application/json; charset=utf-8')
        res.end(await upstream.text())
        return
      }

      if (path.endsWith('/upload')) {
        if (req.method !== 'POST') return sendJson(405, { success: false, error: { message: 'Method not allowed.' } })

        const contentType = req.headers['content-type']
        if (typeof contentType !== 'string' || !contentType.includes('multipart/form-data')) {
          return sendJson(400, { success: false, error: { message: 'Expected multipart/form-data.' } })
        }

        const maxBytes = 10 * 1024 * 1024
        const busboy = Busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: 1 } })

        let imageBuffer = null
        let imageMime = null
        let imageFilename = null
        let fileTooLarge = false
        let parseError = null

        busboy.on('file', (name, file, info) => {
          if (name !== 'file' && name !== 'image') {
            file.resume()
            return
          }

          const { filename, mimeType } = info || {}
          imageFilename = typeof filename === 'string' ? filename : 'image'
          imageMime = typeof mimeType === 'string' ? mimeType : ''

          if (!imageMime || !imageMime.startsWith('image/')) {
            parseError = new Error('Only image uploads are allowed.')
            file.resume()
            return
          }

          const chunks = []
          let total = 0
          file.on('data', (chunk) => {
            total += chunk.length
            if (total > maxBytes) {
              fileTooLarge = true
              file.resume()
              return
            }
            chunks.push(chunk)
          })
          file.on('limit', () => {
            fileTooLarge = true
          })
          file.on('end', () => {
            if (fileTooLarge) return
            imageBuffer = Buffer.concat(chunks)
          })
        })

        busboy.on('error', (err) => {
          parseError = err
        })

        busboy.on('finish', async () => {
          if (parseError) {
            sendJson(400, { success: false, error: { message: parseError.message || 'Invalid upload.' } })
            return
          }
          if (fileTooLarge) {
            sendJson(400, { success: false, error: { message: 'File too large. Max 10MB.' } })
            return
          }
          if (!imageBuffer || !imageMime) {
            sendJson(400, { success: false, error: { message: 'Missing image file.' } })
            return
          }

          try {
            const form = new FormData()
            const blob = new Blob([imageBuffer], { type: imageMime })
            form.append('file', blob, imageFilename || 'image')
            const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined
            const upstream = await fetch('https://media.pollinations.ai/upload', { method: 'POST', headers, body: form })
            const text = await upstream.text()
            if (!upstream.ok) {
              sendJson(upstream.status, { success: false, error: { message: text || 'Upload failed' } })
              return
            }
            let json
            try {
              json = JSON.parse(text)
            } catch {
              sendJson(502, { success: false, error: { message: 'Upload returned invalid JSON' } })
              return
            }
            const url = typeof json?.url === 'string' ? json.url : typeof json?.hash_url === 'string' ? json.hash_url : null
            if (!url) {
              sendJson(502, { success: false, error: { message: 'Upload response missing url' } })
              return
            }
            sendJson(200, { success: true, url })
          } catch (err) {
            sendJson(502, { success: false, error: { message: err instanceof Error ? err.message : String(err) } })
          }
        })

        req.pipe(busboy)
        return
      }

      if (path.endsWith('/fetch')) {
        const urlString = safeGet('url')
        if (!urlString) return sendJson(400, { error: 'Missing url.' })
        let upstreamUrl
        try {
          upstreamUrl = new URL(urlString)
        } catch {
          return sendJson(400, { error: 'Invalid url.' })
        }
        if (upstreamUrl.protocol !== 'https:') return sendJson(400, { error: 'Only https urls are allowed.' })
        if (!upstreamUrl.hostname.endsWith('pollinations.ai')) return sendJson(400, { error: 'Only pollinations.ai urls are allowed.' })

        const upstream = await fetch(upstreamUrl.toString(), apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined)
        res.status(upstream.status)
        const contentType = upstream.headers.get('content-type')
        if (contentType) res.setHeader('content-type', contentType)
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
        res.setHeader('Cache-Control', 'public, max-age=3600')
        res.end(Buffer.from(await upstream.arrayBuffer()))
        return
      }

      if (path.endsWith('/image')) {
        if (!apiKey) return sendJson(500, { error: 'Missing POLLINATIONS_API_KEY on the server.' })
        const prompt = safeGet('prompt')
        if (!prompt) return sendJson(400, { error: 'Missing prompt.' })

        const query = buildQuery(['prompt'])
        if (!query.get('model')) query.set('model', 'flux')

        const upstreamUrl = new URL(`https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}`)
        upstreamUrl.search = query.toString()

        const upstream = await fetch(upstreamUrl.toString(), { headers: { Authorization: `Bearer ${apiKey}` } })
        res.status(upstream.status)
        const contentType = upstream.headers.get('content-type')
        if (contentType) res.setHeader('content-type', contentType)
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
        res.setHeader('Cache-Control', 'public, max-age=3600')
        res.end(Buffer.from(await upstream.arrayBuffer()))
        return
      }

      if (path.endsWith('/text')) {
        if (!apiKey) return sendJson(500, { error: 'Missing POLLINATIONS_API_KEY on the server.' })
        const prompt = safeGet('prompt')
        if (!prompt) return sendJson(400, { error: 'Missing prompt.' })

        const query = buildQuery(['prompt'])
        const upstreamUrl = new URL(`https://gen.pollinations.ai/text/${encodeURIComponent(prompt)}`)
        upstreamUrl.search = query.toString()

        const upstream = await fetch(upstreamUrl.toString(), { headers: { Authorization: `Bearer ${apiKey}` } })
        res.status(upstream.status)
        const contentType = upstream.headers.get('content-type')
        if (contentType) res.setHeader('content-type', contentType)
        res.end(await upstream.text())
        return
      }

      if (path.endsWith('/chat')) {
        if (!apiKey) return sendJson(500, { error: 'Missing POLLINATIONS_API_KEY on the server.' })
        if (req.method !== 'POST') return sendJson(405, { error: 'Method not allowed.' })

        const upstream = await fetch('https://gen.pollinations.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(req.body || {}),
        })
        res.status(upstream.status).setHeader('content-type', 'application/json; charset=utf-8')
        res.end(await upstream.text())
        return
      }

      sendJson(404, { error: 'Not found.' })
    } catch (err) {
      sendJson(502, { error: 'Upstream request failed.', detail: err instanceof Error ? err.message : String(err) })
    }
  }
)

exports.convertToColoring = onRequest(
  { secrets: [POLLINATIONS_API_KEY] },
  async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }

    const sendJson = (status, body) => {
      res.status(status).setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(body))
    }

    if (req.method !== 'POST') {
      sendJson(405, { success: false, error: { message: 'Method not allowed.' } })
      return
    }

    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.includes('multipart/form-data')) {
      sendJson(400, { success: false, error: { message: 'Expected multipart/form-data.' } })
      return
    }

    const maxBytes = 10 * 1024 * 1024
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: 1 } })

    let imageBuffer = null
    let imageMime = null
    let imageFilename = null
    let prompt = ''
    let fileTooLarge = false
    let parseError = null

    busboy.on('field', (name, value) => {
      if (name === 'prompt' && typeof value === 'string') prompt = value
    })

    busboy.on('file', (name, file, info) => {
      if (name !== 'image') {
        file.resume()
        return
      }
      const { filename, mimeType } = info || {}
      imageFilename = typeof filename === 'string' ? filename : 'image'
      imageMime = typeof mimeType === 'string' ? mimeType : ''

      if (!imageMime || !imageMime.startsWith('image/')) {
        parseError = new Error('Only image uploads are allowed.')
        file.resume()
        return
      }

      const chunks = []
      let total = 0
      file.on('data', (chunk) => {
        total += chunk.length
        if (total > maxBytes) {
          fileTooLarge = true
          file.resume()
          return
        }
        chunks.push(chunk)
      })
      file.on('limit', () => {
        fileTooLarge = true
      })
      file.on('end', () => {
        if (fileTooLarge) return
        imageBuffer = Buffer.concat(chunks)
      })
    })

    busboy.on('error', (err) => {
      parseError = err
    })

    busboy.on('finish', async () => {
      if (parseError) {
        sendJson(400, { success: false, error: { message: parseError.message || 'Invalid upload.' } })
        return
      }
      if (fileTooLarge) {
        sendJson(400, { success: false, error: { message: 'File too large. Max 10MB.' } })
        return
      }
      if (!imageBuffer || !imageMime) {
        sendJson(400, { success: false, error: { message: 'Missing image file.' } })
        return
      }

      const defaultPrompt =
        'Transform this exact photo into a clean black and white coloring page. Keep the same composition and subject from the original image. Use only clean line art outlines with no colors, no shading, no gradients. Thick clear black lines on pure white background. Make it look like a professional coloring book page suitable for kids to color in.'

      const userPrompt = typeof prompt === 'string' ? prompt.trim() : ''
      const finalPrompt = userPrompt
        ? `${userPrompt}. Transform the uploaded image into a coloring page with clean black and white line art outlines only, no colors or shading.`
        : defaultPrompt
      const autoColorPrompt = userPrompt
        ? `${userPrompt}. Colorize the uploaded image with vibrant natural colors. Preserve the original composition and subject. No text. No watermark.`
        : 'Colorize this exact photo with vibrant natural colors. Preserve the original composition and subject. No text. No watermark.'

      const apiKey = POLLINATIONS_API_KEY.value()

      const tryUpload = async () => {
        const form = new FormData()
        const blob = new Blob([imageBuffer], { type: imageMime })
        form.append('file', blob, imageFilename || 'image')
        const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined
        const resp = await fetch('https://gen.pollinations.ai/upload', { method: 'POST', headers, body: form })
        const text = await resp.text()
        if (!resp.ok) {
          const message = text || 'Upload failed'
          const err = new Error(message)
          err.statusCode = resp.status
          throw err
        }
        let json
        try {
          json = JSON.parse(text)
        } catch {
          throw new Error('Upload returned invalid JSON')
        }
        const url = typeof json?.url === 'string' ? json.url : typeof json?.hash_url === 'string' ? json.hash_url : null
        if (!url) throw new Error('Upload response missing url')
        return url
      }

      const tryEdits = async (imageUrl, promptText) => {
        const payload = {
          prompt: promptText,
          model: 'gptimage',
          image: imageUrl,
          size: '1024x1024',
          quality: 'standard',
        }
        const headers = apiKey
          ? { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
          : { 'Content-Type': 'application/json' }

        const resp = await fetch('https://gen.pollinations.ai/v1/images/edits', {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        })
        const text = await resp.text()
        if (!resp.ok) {
          const message = text || 'Edits failed'
          const err = new Error(message)
          err.statusCode = resp.status
          throw err
        }
        let json
        try {
          json = JSON.parse(text)
        } catch {
          throw new Error('Edits returned invalid JSON')
        }
        const url = typeof json?.data?.[0]?.url === 'string' ? json.data[0].url : null
        if (!url) throw new Error('Edits response missing image url')
        return url
      }

      const fallbackGet = (promptText, imageUrl) => {
        const encodedPrompt = encodeURIComponent(promptText)
        const encodedImage = encodeURIComponent(imageUrl)
        return `https://gen.pollinations.ai/image/${encodedPrompt}?model=gptimage&width=1024&height=1024&image=${encodedImage}&nologo=true`
      }

      try {
        const uploadedUrl = await tryUpload()
        try {
          const editedUrl = await tryEdits(uploadedUrl, finalPrompt)
          let autoColorUrl = null
          try {
            autoColorUrl = await tryEdits(uploadedUrl, autoColorPrompt)
          } catch {
            autoColorUrl = fallbackGet(autoColorPrompt, uploadedUrl)
          }
          sendJson(200, { success: true, imageUrl: editedUrl, autoColorUrl, model: 'gptimage', method: 'edits' })
          return
        } catch {
          sendJson(200, { success: true, imageUrl: fallbackGet(finalPrompt, uploadedUrl), autoColorUrl: fallbackGet(autoColorPrompt, uploadedUrl), model: 'gptimage', method: 'get' })
          return
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        sendJson(502, { success: false, error: { message } })
      }
    })

    req.pipe(busboy)
  }
)
