import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Route, Routes, useNavigate } from 'react-router-dom'
import { Download, Loader2, Palette, Type, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import inkbloomLogo from '@/assets/inkbloom-logo.svg'
import { convertFileToLineArtDataUrl, getLineArtSession, resetLineArtSession } from '@/lib/lineArt'

type ManualColoringDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  imageUrl: string | null
}

function ManualColoringDialog({ open, onOpenChange, imageUrl }: ManualColoringDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [brushSize, setBrushSize] = useState(12)
  const [brushColor, setBrushColor] = useState('#ff3b30')
  const [tool, setTool] = useState<'brush' | 'fill'>('brush')
  const [tolerance, setTolerance] = useState(22)

  const isDrawingRef = useRef(false)
  const lastPointRef = useRef<{ x: number; y: number } | null>(null)
  const historyRef = useRef<ImageData[]>([])
  const historyIndexRef = useRef(-1)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const resizeCanvasToImage = useCallback(() => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img) return
    const w = img.naturalWidth || 0
    const h = img.naturalHeight || 0
    if (!w || !h) return
    canvas.width = w
    canvas.height = h
    canvas.style.width = '100%'
    canvas.style.height = 'auto'
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)
    historyRef.current = []
    historyIndexRef.current = -1
    setCanUndo(false)
    setCanRedo(false)
  }, [])

  const pushSnapshot = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const next = historyRef.current.slice(0, historyIndexRef.current + 1)
    next.push(snapshot)
    historyRef.current = next.slice(-25)
    historyIndexRef.current = historyRef.current.length - 1
    setCanUndo(historyIndexRef.current >= 0)
    setCanRedo(false)
  }, [])

  const applySnapshot = useCallback((index: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const snapshot = historyRef.current[index]
    if (!snapshot) return
    ctx.putImageData(snapshot, 0, 0)
    historyIndexRef.current = index
    setCanUndo(index >= 0)
    setCanRedo(index < historyRef.current.length - 1)
  }, [])

  const handleUndo = useCallback(() => {
    const idx = historyIndexRef.current - 1
    if (idx < 0) {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      historyIndexRef.current = -1
      setCanUndo(false)
      setCanRedo(historyRef.current.length > 0)
      return
    }
    applySnapshot(idx)
  }, [applySnapshot])

  const handleRedo = useCallback(() => {
    const idx = historyIndexRef.current + 1
    if (idx >= historyRef.current.length) return
    applySnapshot(idx)
  }, [applySnapshot])

  const handleClear = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    historyRef.current = []
    historyIndexRef.current = -1
    setCanUndo(false)
    setCanRedo(false)
  }, [])

  const getCanvasPoint = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height
    return { x, y }
  }, [])

  const hexToRgba = useCallback((hex: string) => {
    const s = hex.replace('#', '')
    const n = s.length === 3 ? s.split('').map((c) => c + c).join('') : s
    const r = parseInt(n.slice(0, 2), 16)
    const g = parseInt(n.slice(2, 4), 16)
    const b = parseInt(n.slice(4, 6), 16)
    return [r, g, b, 255] as const
  }, [])

  const getCompositeImageData = useCallback(() => {
    const baseImg = imgRef.current
    const strokes = canvasRef.current
    if (!baseImg || !strokes) return null
    const w = baseImg.naturalWidth
    const h = baseImg.naturalHeight
    const off = document.createElement('canvas')
    off.width = w
    off.height = h
    const ctx = off.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(baseImg, 0, 0, w, h)
    ctx.drawImage(strokes, 0, 0, w, h)
    return ctx.getImageData(0, 0, w, h)
  }, [])

  const floodFill = useCallback(
    (startX: number, startY: number) => {
      const strokes = canvasRef.current
      if (!strokes) return
      const w = strokes.width
      const h = strokes.height
      const sctx = strokes.getContext('2d')
      if (!sctx) return
      const comp = getCompositeImageData()
      if (!comp) return
      const compData = comp.data
      const sData = sctx.getImageData(0, 0, w, h)
      const d = sData.data
      const idx = (x: number, y: number) => (y * w + x) * 4
      const clamp = (n: number, min: number, max: number) => (n < min ? min : n > max ? max : n)

      const at = idx(Math.floor(startX), Math.floor(startY))
      const r0 = compData[at]
      const g0 = compData[at + 1]
      const b0 = compData[at + 2]
      const a0 = compData[at + 3]
      const baseLum = (0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0) * (a0 / 255)
      const wallThreshold = 80
      if (baseLum < wallThreshold) return

      const [fr, fg, fb, fa] = hexToRgba(brushColor)

      const visited = new Uint8Array(w * h)
      const stack: number[] = []
      stack.push(Math.floor(startX), Math.floor(startY))
      const tol = clamp(tolerance, 0, 128)

      const lum = (r: number, g: number, b: number, a: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) * (a / 255)

      while (stack.length) {
        const y = stack.pop() as number
        const x = stack.pop() as number
        if (x < 0 || x >= w || y < 0 || y >= h) continue
        const i = y * w + x
        if (visited[i]) continue
        visited[i] = 1
        const p = idx(x, y)
        const cr = compData[p]
        const cg = compData[p + 1]
        const cb = compData[p + 2]
        const ca = compData[p + 3]
        const L = lum(cr, cg, cb, ca)
        if (L < wallThreshold) continue
        if (Math.abs(L - baseLum) > tol) continue
        d[p] = fr
        d[p + 1] = fg
        d[p + 2] = fb
        d[p + 3] = fa
        stack.push(x + 1, y)
        stack.push(x - 1, y)
        stack.push(x, y + 1)
        stack.push(x, y - 1)
      }

      sctx.putImageData(sData, 0, 0)
      pushSnapshot()
    },
    [brushColor, tolerance, getCompositeImageData, pushSnapshot, hexToRgba]
  )

  const drawLine = useCallback(
    (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = brushColor
      ctx.lineWidth = brushSize
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      ctx.lineTo(to.x, to.y)
      ctx.stroke()
    },
    [brushColor, brushSize]
  )

  const exportMergedPng = useCallback(async () => {
    if (!imageUrl) return
    const baseImg = imgRef.current
    const strokesCanvas = canvasRef.current
    if (!baseImg || !strokesCanvas) return
    const out = document.createElement('canvas')
    out.width = baseImg.naturalWidth
    out.height = baseImg.naturalHeight
    const ctx = out.getContext('2d')
    if (!ctx) return
    ctx.drawImage(baseImg, 0, 0)
    ctx.drawImage(strokesCanvas, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'))
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'inkbloom-colored.png'
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }, [imageUrl])

  const printMerged = useCallback(() => {
    if (!imageUrl) return
    const baseImg = imgRef.current
    const strokesCanvas = canvasRef.current
    if (!baseImg || !strokesCanvas) return
    const out = document.createElement('canvas')
    out.width = baseImg.naturalWidth
    out.height = baseImg.naturalHeight
    const ctx = out.getContext('2d')
    if (!ctx) return
    ctx.drawImage(baseImg, 0, 0)
    ctx.drawImage(strokesCanvas, 0, 0)
    const dataUrl = out.toDataURL('image/png')
    const w = window.open('', '_blank', 'noopener,noreferrer')
    if (!w) return
    w.document.write(
      `<html><head><title>Print</title><style>body{margin:0}img{width:100%;height:auto;display:block}</style></head><body><img src="${dataUrl}"/></body></html>`
    )
    w.document.close()
    w.focus()
    w.print()
  }, [imageUrl])

  useEffect(() => {
    if (!open) return
    window.setTimeout(() => resizeCanvasToImage(), 0)
  }, [open, resizeCanvasToImage])

  if (!imageUrl) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Color Online</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="color"
              value={brushColor}
              onChange={(e) => setBrushColor(e.target.value)}
              className="h-10 w-14 p-1 rounded-md border border-gray-200 bg-white"
            />
            <div className="inline-flex rounded-lg overflow-hidden border border-gray-200">
              <button
                onClick={() => setTool('brush')}
                className={`px-3 py-2 text-sm ${tool === 'brush' ? 'bg-gray-900 text-white' : 'bg-white text-gray-700'}`}
              >
                Brush
              </button>
              <button
                onClick={() => setTool('fill')}
                className={`px-3 py-2 text-sm ${tool === 'fill' ? 'bg-gray-900 text-white' : 'bg-white text-gray-700'}`}
              >
                Fill
              </button>
            </div>
            {tool === 'brush' ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600">Brush</span>
                <input
                  type="range"
                  min={2}
                  max={40}
                  value={brushSize}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                />
                <span className="text-sm text-gray-600 w-10 text-right">{brushSize}px</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600">Tolerance</span>
                <input
                  type="range"
                  min={0}
                  max={80}
                  value={tolerance}
                  onChange={(e) => setTolerance(Number(e.target.value))}
                />
                <span className="text-sm text-gray-600 w-8 text-right">{tolerance}</span>
              </div>
            )}
            <Button variant="outline" onClick={handleUndo} disabled={!canUndo}>
              Undo
            </Button>
            <Button variant="outline" onClick={handleRedo} disabled={!canRedo}>
              Redo
            </Button>
            <Button variant="outline" onClick={handleClear}>
              Clear
            </Button>
            <div className="flex-1" />
            <Button className="bg-gray-900 text-white hover:bg-gray-800" onClick={() => void exportMergedPng()}>
              <Download className="w-4 h-4 mr-2" />
              Download PNG
            </Button>
            <Button variant="outline" onClick={printMerged}>
              Print
            </Button>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-3 overflow-hidden">
            <div className="relative">
              <img
                ref={imgRef}
                src={imageUrl}
                alt="Coloring page"
                className="w-full h-auto block"
                onLoad={() => resizeCanvasToImage()}
              />
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full touch-none"
                onPointerDown={(e) => {
                  const p = getCanvasPoint(e)
                  if (!p) return
                  if (tool === 'fill') {
                    floodFill(p.x, p.y)
                    return
                  }
                  isDrawingRef.current = true
                  lastPointRef.current = p
                  e.currentTarget.setPointerCapture(e.pointerId)
                }}
                onPointerMove={(e) => {
                  if (!isDrawingRef.current) return
                  const from = lastPointRef.current
                  const to = getCanvasPoint(e)
                  if (!from || !to) return
                  drawLine(from, to)
                  lastPointRef.current = to
                }}
                onPointerUp={() => {
                  if (!isDrawingRef.current) return
                  isDrawingRef.current = false
                  lastPointRef.current = null
                  pushSnapshot()
                }}
                onPointerCancel={() => {
                  isDrawingRef.current = false
                  lastPointRef.current = null
                }}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Header() {
  return (
    <header className="sticky top-0 z-50 bg-white/90 backdrop-blur border-b border-gray-100">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 via-fuchsia-500 to-emerald-400 flex items-center justify-center">
            <img src={inkbloomLogo} alt="InkBloom" className="w-6 h-6" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-lg font-bold">
              <span className="text-indigo-600">Ink</span>
              <span className="text-emerald-500">Bloom</span>
            </span>
            <span className="text-xs text-gray-400 hidden sm:block">Coloring Page Generator</span>
          </div>
        </Link>
        <nav className="hidden sm:flex items-center gap-4 text-sm font-medium">
          <Link to="/generators/photo-to-coloring" className="text-gray-700 hover:text-indigo-600">
            Photo to Coloring
          </Link>
          <Link to="/generators/text-to-coloring" className="text-gray-700 hover:text-indigo-600">
            Text to Coloring
          </Link>
        </nav>
      </div>
    </header>
  )
}

function Hero() {
  const navigate = useNavigate()
  return (
    <section className="py-16 bg-gradient-to-br from-slate-50 via-indigo-50 to-emerald-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid lg:grid-cols-2 gap-10 items-center">
        <div className="space-y-5">
          <Badge className="bg-indigo-100 text-indigo-700">Coloring Pages</Badge>
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold text-gray-900 leading-tight">
            Turn Any Picture Into a <span className="text-indigo-600">Coloring Page</span>
          </h1>
          <p className="text-lg text-gray-600">
            Create printable coloring pages from photos or prompts. Perfect for kids, parents, teachers, classrooms, and gifts.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              className="bg-gradient-to-r from-indigo-600 to-emerald-500 hover:from-indigo-700 hover:to-emerald-600 text-white px-6 py-6 text-lg rounded-xl"
              onClick={() => navigate('/generators/photo-to-coloring')}
            >
              <Upload className="w-5 h-5 mr-2" />
              Upload a Photo
            </Button>
            <Button variant="outline" className="px-6 py-6 text-lg rounded-xl" onClick={() => navigate('/generators/text-to-coloring')}>
              <Type className="w-5 h-5 mr-2" />
              Generate from Text
            </Button>
          </div>
        </div>
        <div className="rounded-3xl overflow-hidden shadow-2xl border border-gray-100 bg-white">
          <img src="/hero-cat.jpg" alt="Example coloring page" className="w-full h-auto" />
        </div>
      </div>
    </section>
  )
}

function PhotoToColoringPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [modelStatus, setModelStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [compare, setCompare] = useState(50)
  const [isColoringOpen, setIsColoringOpen] = useState(false)

  useEffect(() => {
    if (!file) {
      setPreviewUrl((prev) => {
        if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
        return null
      })
      return
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl((prev) => {
      if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
      return url
    })
    return () => URL.revokeObjectURL(url)
  }, [file])

  useEffect(() => {
    return () => {
      if (resultUrl?.startsWith('blob:')) URL.revokeObjectURL(resultUrl)
    }
  }, [resultUrl])

  const handleSelect = (f: File) => {
    const allowed = new Set(['image/png', 'image/jpeg', 'image/webp'])
    if (!allowed.has(f.type)) {
      setError('Please upload a PNG, JPG, or WEBP image.')
      return
    }
    if (f.size > 10 * 1024 * 1024) {
      setError('Please upload an image under 10MB.')
      return
    }
    setError(null)
    setFile(f)
    setResultUrl((prev) => {
      if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
      return null
    })
    setCompare(50)
  }

  const handleConvert = async () => {
    if (!file) return
    setError(null)
    setProgress('Loading AI model… (first load ~17MB)')
    try {
      if (modelStatus !== 'ready') {
        setModelStatus('loading')
        await getLineArtSession()
        setModelStatus('ready')
      }
      setProgress('Converting your photo…')
      const out = await convertFileToLineArtDataUrl(file, { invert: 'auto', binarize: true, thicken: true })
      setResultUrl((prev) => {
        if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
        return out
      })
    } catch (e) {
      setModelStatus((s) => (s === 'loading' ? 'error' : s))
      setError(e instanceof Error ? e.message : 'Conversion failed')
    } finally {
      setProgress(null)
    }
  }

  const download = () => {
    if (!resultUrl) return
    const a = document.createElement('a')
    a.href = resultUrl
    a.download = 'inkbloom-coloring-page.png'
    a.click()
  }

  const print = () => {
    if (!resultUrl) return
    const w = window.open('', '_blank', 'noopener,noreferrer')
    if (!w) return
    w.document.write(
      `<html><head><title>Print</title><style>body{margin:0}img{width:100%;height:auto;display:block}</style></head><body><img src="${resultUrl}"/></body></html>`
    )
    w.document.close()
    w.focus()
    w.print()
  }

  return (
    <div className="pt-24">
      <section className="py-14 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-12 items-start">
            <div className="space-y-4">
              <Badge className="bg-indigo-100 text-indigo-700">Photo to Coloring Page</Badge>
              <h1 className="text-3xl lg:text-5xl font-bold text-gray-900">Upload a photo, get a printable coloring page</h1>
              <p className="text-gray-600 text-lg">Clean black outlines, white background, ready to download and print.</p>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) handleSelect(f)
                }}
              />
              <div className="rounded-xl border-2 border-dashed p-6 bg-gray-50">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-gray-900 truncate">{file ? file.name : 'Choose a photo to upload'}</div>
                    <div className="text-sm text-gray-500">PNG, JPG, WEBP up to 10MB</div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
                      <Upload className="w-4 h-4 mr-2" />
                      Upload
                    </Button>
                    {file && (
                      <Button
                        variant="outline"
                        onClick={() => {
                          setFile(null)
                          setError(null)
                          setResultUrl((prev) => {
                            if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
                            return null
                          })
                          if (fileInputRef.current) fileInputRef.current.value = ''
                        }}
                      >
                        Reset
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              <Button
                className="w-full bg-gradient-to-r from-indigo-600 to-emerald-500 hover:from-indigo-700 hover:to-emerald-600 text-white py-6 text-lg rounded-xl"
                onClick={() => void handleConvert()}
                disabled={!file || Boolean(progress)}
              >
                {progress ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    {progress}
                  </>
                ) : (
                  'Convert to Coloring Page'
                )}
              </Button>

              {modelStatus === 'error' && (
                <Button
                  variant="outline"
                  onClick={() => {
                    resetLineArtSession()
                    setModelStatus('idle')
                    setError(null)
                  }}
                >
                  Retry loading AI model
                </Button>
              )}

              {error && <div className="text-sm text-red-600">{error}</div>}

              {resultUrl && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <Button className="bg-gray-900 text-white hover:bg-gray-800" onClick={download}>
                    <Download className="w-4 h-4 mr-2" />
                    Download PNG
                  </Button>
                  <Button variant="outline" onClick={print}>
                    Print
                  </Button>
                  <Button variant="outline" onClick={() => setIsColoringOpen(true)}>
                    <Palette className="w-4 h-4 mr-2" />
                    Color Online
                  </Button>
                </div>
              )}
            </div>

            <div className="bg-white rounded-3xl shadow-2xl p-6 border border-gray-100">
              {previewUrl && resultUrl ? (
                <div>
                  <div className="relative rounded-2xl overflow-hidden bg-gray-50">
                    <div className="relative w-full h-[420px]">
                      <img src={resultUrl} alt="Coloring page" className="absolute inset-0 w-full h-full object-contain" />
                      <img
                        src={previewUrl}
                        alt="Original"
                        className="absolute inset-0 w-full h-full object-contain"
                        style={{ clipPath: `inset(0 ${100 - compare}% 0 0)` }}
                      />
                      <div className="absolute inset-y-0" style={{ left: `${compare}%` }}>
                        <div className="w-0.5 h-full bg-gray-900/60" />
                      </div>
                    </div>
                  </div>
                  <div className="mt-4">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={compare}
                      onChange={(e) => setCompare(Number(e.target.value))}
                      className="w-full"
                    />
                    <div className="flex justify-between text-xs text-gray-500 mt-2">
                      <span>Original</span>
                      <span>Coloring Page</span>
                    </div>
                  </div>
                </div>
              ) : previewUrl ? (
                <div className="rounded-2xl overflow-hidden bg-gray-50 border border-gray-100">
                  <img src={previewUrl} alt="Preview" className="w-full h-auto block" />
                </div>
              ) : (
                <div className="rounded-2xl bg-gray-50 p-10 text-center text-gray-500">
                  Upload an image to see the preview.
                </div>
              )}
            </div>
          </div>
          <ManualColoringDialog open={isColoringOpen} onOpenChange={setIsColoringOpen} imageUrl={resultUrl} />
        </div>
      </section>
    </div>
  )
}

function TextToColoringPage() {
  const [prompt, setPrompt] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [slowNotice, setSlowNotice] = useState(false)

  useEffect(() => {
    return () => {
      if (resultUrl?.startsWith('blob:')) URL.revokeObjectURL(resultUrl)
    }
  }, [resultUrl])

  const generate = async () => {
    const trimmed = prompt.trim()
    if (!trimmed) return
    setError(null)
    setIsGenerating(true)
    setSlowNotice(false)

    const slowTimer = window.setTimeout(() => setSlowNotice(true), 30_000)
    try {
      const resp = await fetch('/api/text-to-coloring', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: trimmed, style: 'Detailed' }),
      })
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '')
        const asJson = (() => {
          try {
            return JSON.parse(txt) as unknown
          } catch {
            return null
          }
        })()
        const msg =
          asJson && typeof asJson === 'object' && asJson !== null && typeof (asJson as Record<string, unknown>).error === 'string'
            ? String((asJson as Record<string, unknown>).error)
            : txt?.trim()
              ? txt.trim()
              : 'Generation failed'
        throw new Error(msg)
      }
      const blob = await resp.blob()
      const file = new File([blob], 'gen.png', { type: blob.type || 'image/png' })
      await getLineArtSession()
      const refined = await convertFileToLineArtDataUrl(file, { invert: 'auto', binarize: true, thicken: true })
      setResultUrl((prev) => {
        if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
        return refined
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      window.clearTimeout(slowTimer)
      setIsGenerating(false)
    }
  }

  const download = () => {
    if (!resultUrl) return
    const a = document.createElement('a')
    a.href = resultUrl
    a.download = 'inkbloom-coloring-page.png'
    a.click()
  }

  const print = () => {
    if (!resultUrl) return
    const w = window.open('', '_blank', 'noopener,noreferrer')
    if (!w) return
    w.document.write(
      `<html><head><title>Print</title><style>body{margin:0}img{width:100%;height:auto;display:block}</style></head><body><img src="${resultUrl}"/></body></html>`
    )
    w.document.close()
    w.focus()
    w.print()
  }

  return (
    <div className="pt-24">
      <section className="py-14 bg-gradient-to-br from-slate-50 via-indigo-50 to-emerald-50">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-10">
            <Badge className="bg-indigo-100 text-indigo-700 mb-3">Text to Coloring Page</Badge>
            <h1 className="text-3xl lg:text-5xl font-bold text-gray-900">Generate a coloring page from text</h1>
            <p className="text-gray-600 mt-3">Describe what you want, then download and print a black-and-white coloring page.</p>
          </div>
          <div className="bg-white rounded-2xl shadow-xl p-4">
            <div className="flex gap-2">
              <Input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. a cute cat in a garden" />
              <Button
                className="bg-gradient-to-r from-indigo-600 to-emerald-500 text-white"
                onClick={() => void generate()}
                disabled={!prompt.trim() || isGenerating}
              >
                {isGenerating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Type className="w-4 h-4 mr-2" />}
                Generate
              </Button>
            </div>
            {slowNotice && <div className="text-sm text-gray-500 mt-3">This is taking longer than usual…</div>}
            {error && <div className="text-sm text-red-600 mt-3">{error}</div>}
          </div>

          {resultUrl && (
            <div className="mt-6 bg-white rounded-2xl shadow-xl p-3">
              <img src={resultUrl} alt="Generated coloring page" className="rounded-xl w-full max-h-[520px] object-contain bg-gray-50" />
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Button className="w-full bg-gray-900 text-white hover:bg-gray-800" onClick={download}>
                  <Download className="w-4 h-4 mr-2" />
                  Download PNG
                </Button>
                <Button variant="outline" className="w-full" onClick={print}>
                  Print
                </Button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function HomePage() {
  return (
    <main>
      <Hero />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14">
        <div className="grid md:grid-cols-2 gap-6">
          <Link to="/generators/photo-to-coloring" className="block rounded-2xl border border-gray-100 bg-white p-6 shadow-sm hover:shadow-md transition-shadow">
            <div className="flex items-center gap-2 mb-2">
              <Upload className="w-5 h-5 text-indigo-600" />
              <div className="font-semibold text-gray-900">Photo to Coloring Page</div>
            </div>
            <div className="text-gray-600">Upload any picture and get a print‑ready coloring page.</div>
          </Link>
          <Link to="/generators/text-to-coloring" className="block rounded-2xl border border-gray-100 bg-white p-6 shadow-sm hover:shadow-md transition-shadow">
            <div className="flex items-center gap-2 mb-2">
              <Type className="w-5 h-5 text-indigo-600" />
              <div className="font-semibold text-gray-900">Text to Coloring Page</div>
            </div>
            <div className="text-gray-600">Describe a scene and generate a printable coloring page.</div>
          </Link>
        </div>
      </div>
    </main>
  )
}

function PrivacyPage() {
  return (
    <div className="pt-24">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-14">
        <h1 className="text-3xl font-bold text-gray-900">Privacy</h1>
        <p className="text-gray-600 mt-4">InkBloom processes images in your browser for photo-to-coloring. Text generation is handled by a server route. No secrets are exposed in the browser.</p>
      </div>
    </div>
  )
}

function TermsPage() {
  return (
    <div className="pt-24">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-14">
        <h1 className="text-3xl font-bold text-gray-900">Terms</h1>
        <p className="text-gray-600 mt-4">Use InkBloom responsibly. Generated content should respect copyrights and local laws.</p>
      </div>
    </div>
  )
}

function Footer() {
  return (
    <footer className="border-t border-gray-100 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="text-sm text-gray-500">© {new Date().getFullYear()} InkBloom</div>
        <div className="flex gap-4 text-sm">
          <Link to="/privacy" className="text-gray-600 hover:text-indigo-600">
            Privacy
          </Link>
          <Link to="/terms" className="text-gray-600 hover:text-indigo-600">
            Terms
          </Link>
        </div>
      </div>
    </footer>
  )
}

export default function App() {
  return (
    <div className="min-h-screen bg-white">
      <Header />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/generators/photo-to-coloring" element={<PhotoToColoringPage />} />
        <Route path="/generators/text-to-coloring" element={<TextToColoringPage />} />
        <Route path="*" element={<HomePage />} />
      </Routes>
      <Footer />
    </div>
  )
}

