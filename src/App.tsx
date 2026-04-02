import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import JSZip from 'jszip';
import { jsPDF } from 'jspdf';
import { 
  ChevronDown, Sparkles, Check, Search, Star, Menu, X,
  Palette, Zap, CreditCard, Users, Image as ImageIcon,
  Type, BookOpen, Download, ArrowRight, Play, Heart,
  Upload, MessageSquare, Layers, Grid3X3, List, Filter,
  Clock, Shield, Mail,
  Facebook, Twitter, Instagram, Youtube, Linkedin,
  Eye, Wand2, PenTool, ScanLine, Paintbrush,
  Share2, Bookmark, Undo, Redo, Eraser, Loader2
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import inkbloomLogo from '@/assets/inkbloom-logo.svg';
import { convertFileToLineArtDataUrl, getLineArtSession, resetLineArtSession } from '@/lib/lineArt';
import type { User } from 'firebase/auth';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { addDoc, collection, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth, db, googleProvider } from '@/lib/firebase';

const POLLINATIONS_IMAGE_BASE = 'https://image.pollinations.ai/prompt'

function scrollToSection(sectionId: string) {
  const id = sectionId.startsWith('#') ? sectionId.slice(1) : sectionId;
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function openOnlineColoring(imageUrl: string) {
  window.dispatchEvent(
    new CustomEvent('online-coloring:set-image', { detail: { url: imageUrl } })
  )
  scrollToSection('online-coloring')
}

function getOrCreateSessionId() {
  const key = 'INKBLOOM_SESSION_ID'
  try {
    const existing = localStorage.getItem(key)
    if (existing) return existing
    const value =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? (crypto as Crypto).randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`
    localStorage.setItem(key, value)
    return value
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

function buildPollinationsImageUrl(
  prompt: string,
  params: Record<string, string | number | boolean | null | undefined>
) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue
    search.set(key, String(value))
  }
  const qs = search.toString()
  return `${POLLINATIONS_IMAGE_BASE}/${encodeURIComponent(prompt)}${qs ? `?${qs}` : ''}`
}

function preloadImage(url: string, timeoutMs = 120_000) {
  return new Promise<void>((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    const timeout = window.setTimeout(() => {
      reject(new Error('Generation timed out, please try again'))
    }, timeoutMs)
    img.onload = () => {
      window.clearTimeout(timeout)
      resolve()
    }
    img.onerror = () => {
      window.clearTimeout(timeout)
      reject(new Error('Generation failed, please try again'))
    }
    img.src = url
  })
}

async function preloadImageWithRetry(url: string, timeoutMs: number, retries: number) {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await preloadImage(url, timeoutMs)
      return
    } catch (err) {
      lastError = err
      if (attempt < retries) await new Promise<void>((r) => window.setTimeout(r, 1000))
    }
  }
  if (lastError instanceof Error) throw lastError
  throw new Error('Generation failed, please try again')
}

type ManualColoringDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  imageUrl: string | null
  title: string
  onExport?: (pngUrl: string) => void
}

function ManualColoringDialog({ open, onOpenChange, imageUrl, title, onExport }: ManualColoringDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [brushSize, setBrushSize] = useState(12)
  const [brushColor, setBrushColor] = useState('#ff3b30')
  const [tool, setTool] = useState<'brush' | 'fill'>('brush')
  const [tolerance, setTolerance] = useState(22)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isDrawingRef = useRef(false)
  const lastPointRef = useRef<{ x: number; y: number } | null>(null)
  const historyRef = useRef<ImageData[]>([])
  const historyIndexRef = useRef(-1)

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
    const { width, height } = canvas
    const snapshot = ctx.getImageData(0, 0, width, height)
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

  const getCanvasPoint = useCallback((e: PointerEvent | React.PointerEvent<HTMLCanvasElement>) => {
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
    if (!blob) throw new Error('Export failed')
    const url = URL.createObjectURL(blob)
    onExport?.(url)
    const a = document.createElement('a')
    a.href = url
    a.download = 'inkbloom-colored.png'
    a.click()
    if (!onExport) window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }, [imageUrl, onExport])

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
    queueMicrotask(() => setError(null))
    window.setTimeout(() => resizeCanvasToImage(), 0)
  }, [open, resizeCanvasToImage])

  if (!imageUrl) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="color"
              value={brushColor}
              onChange={(e) => setBrushColor(e.target.value)}
              className="h-10 w-14 p-1 rounded-md border border-gray-200 bg-white"
            />
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
            <Button variant="outline" onClick={handleUndo} disabled={!canUndo}>
              <Undo className="w-4 h-4 mr-2" />
              Undo
            </Button>
            <Button variant="outline" onClick={handleRedo} disabled={!canRedo}>
              <Redo className="w-4 h-4 mr-2" />
              Redo
            </Button>
            <Button variant="outline" onClick={handleClear}>
              <Eraser className="w-4 h-4 mr-2" />
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
          {error && <div className="text-sm text-red-600">{error}</div>}
          <div className="rounded-2xl border border-gray-200 bg-white p-3 overflow-hidden">
            <div className="relative">
              <img
                ref={imgRef}
                src={imageUrl}
                alt="Coloring page"
                className="w-full h-auto block"
                onLoad={() => resizeCanvasToImage()}
                onError={() => setError('Failed to load image. Please try again.')}
              />
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full touch-none"
                onPointerDown={(e) => {
                  const p = getCanvasPoint(e)
                  if (!p) return
                  setError(null)
                  if (tool === 'fill') {
                    floodFill(p.x, p.y)
                  } else {
                    isDrawingRef.current = true
                    lastPointRef.current = p
                    ;(e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId)
                  }
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
        <div className="mt-3 flex items-center gap-3">
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
          {tool === 'fill' && (
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
        </div>
      </DialogContent>
    </Dialog>
  )
}

type BackgroundRemovalDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  imageUrl: string | null
  title: string
  onExport?: (pngUrl: string) => void
}

function BackgroundRemovalDialog({ open, onOpenChange, imageUrl, title, onExport }: BackgroundRemovalDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [tool, setTool] = useState<'wand' | 'erase'>('wand')
  const [tolerance, setTolerance] = useState(24)
  const [brushSize, setBrushSize] = useState(28)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isErasingRef = useRef(false)
  const lastPointRef = useRef<{ x: number; y: number } | null>(null)
  const historyRef = useRef<ImageData[]>([])
  const historyIndexRef = useRef(-1)
  const originalRef = useRef<ImageData | null>(null)

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
    ctx.drawImage(img, 0, 0, w, h)
    originalRef.current = ctx.getImageData(0, 0, w, h)
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
      const ctx = canvas?.getContext('2d')
      const original = originalRef.current
      if (!canvas || !ctx || !original) return
      ctx.putImageData(original, 0, 0)
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

  const handleReset = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    const original = originalRef.current
    if (!canvas || !ctx || !original) return
    ctx.putImageData(original, 0, 0)
    historyRef.current = []
    historyIndexRef.current = -1
    setCanUndo(false)
    setCanRedo(false)
  }, [])

  const getCanvasPoint = useCallback((e: PointerEvent | React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height
    return { x, y }
  }, [])

  const floodClear = useCallback(
    (startX: number, startY: number) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const w = canvas.width
      const h = canvas.height
      const img = ctx.getImageData(0, 0, w, h)
      const d = img.data
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(startX)))
      const y0 = Math.max(0, Math.min(h - 1, Math.floor(startY)))
      const idx0 = (y0 * w + x0) * 4
      const r0 = d[idx0]
      const g0 = d[idx0 + 1]
      const b0 = d[idx0 + 2]
      const a0 = d[idx0 + 3]
      if (a0 === 0) return

      const tol = Math.max(0, Math.min(128, tolerance))
      const visited = new Uint8Array(w * h)
      const stack: number[] = []
      stack.push(x0, y0)

      const dist = (r: number, g: number, b: number, a: number) => {
        if (a === 0) return 0
        return Math.max(Math.abs(r - r0), Math.abs(g - g0), Math.abs(b - b0))
      }

      while (stack.length) {
        const y = stack.pop() as number
        const x = stack.pop() as number
        if (x < 0 || x >= w || y < 0 || y >= h) continue
        const pIndex = y * w + x
        if (visited[pIndex]) continue
        visited[pIndex] = 1
        const i = pIndex * 4
        const r = d[i]
        const g = d[i + 1]
        const b = d[i + 2]
        const a = d[i + 3]
        if (dist(r, g, b, a) > tol) continue
        d[i + 3] = 0
        stack.push(x + 1, y)
        stack.push(x - 1, y)
        stack.push(x, y + 1)
        stack.push(x, y - 1)
      }

      ctx.putImageData(img, 0, 0)
      pushSnapshot()
    },
    [tolerance, pushSnapshot]
  )

  const eraseLine = useCallback(
    (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.save()
      ctx.globalCompositeOperation = 'destination-out'
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = 'rgba(0,0,0,1)'
      ctx.lineWidth = brushSize
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      ctx.lineTo(to.x, to.y)
      ctx.stroke()
      ctx.restore()
    },
    [brushSize]
  )

  const exportPng = useCallback(async () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('Export failed')
    const url = URL.createObjectURL(blob)
    onExport?.(url)
    const a = document.createElement('a')
    a.href = url
    a.download = 'inkbloom-no-bg.png'
    a.click()
    if (!onExport) window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }, [onExport])

  const printPng = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dataUrl = canvas.toDataURL('image/png')
    const w = window.open('', '_blank', 'noopener,noreferrer')
    if (!w) return
    w.document.write(
      `<html><head><title>Print</title><style>body{margin:0}img{width:100%;height:auto;display:block}</style></head><body><img src="${dataUrl}"/></body></html>`
    )
    w.document.close()
    w.focus()
    w.print()
  }, [])

  useEffect(() => {
    if (!open) return
    queueMicrotask(() => setError(null))
    window.setTimeout(() => resizeCanvasToImage(), 0)
  }, [open, resizeCanvasToImage])

  if (!imageUrl) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg overflow-hidden border border-gray-200 bg-white">
              <button
                onClick={() => setTool('wand')}
                className={`px-3 py-2 text-sm ${tool === 'wand' ? 'bg-gray-900 text-white' : 'bg-white text-gray-700'}`}
              >
                Wand
              </button>
              <button
                onClick={() => setTool('erase')}
                className={`px-3 py-2 text-sm ${tool === 'erase' ? 'bg-gray-900 text-white' : 'bg-white text-gray-700'}`}
              >
                Erase
              </button>
            </div>
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
            {tool === 'erase' && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600">Brush</span>
                <input
                  type="range"
                  min={6}
                  max={80}
                  value={brushSize}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                />
                <span className="text-sm text-gray-600 w-10 text-right">{brushSize}px</span>
              </div>
            )}
            <Button variant="outline" onClick={handleUndo} disabled={!canUndo}>
              <Undo className="w-4 h-4 mr-2" />
              Undo
            </Button>
            <Button variant="outline" onClick={handleRedo} disabled={!canRedo}>
              <Redo className="w-4 h-4 mr-2" />
              Redo
            </Button>
            <Button variant="outline" onClick={handleReset}>
              <Eraser className="w-4 h-4 mr-2" />
              Reset
            </Button>
            <div className="flex-1" />
            <Button className="bg-gray-900 text-white hover:bg-gray-800" onClick={() => void exportPng()}>
              <Download className="w-4 h-4 mr-2" />
              Download PNG
            </Button>
            <Button variant="outline" onClick={printPng}>
              Print
            </Button>
          </div>
          {error && <div className="text-sm text-red-600">{error}</div>}
          <div className="rounded-2xl border border-gray-200 bg-white p-3 overflow-hidden">
            <div className="relative">
              <img
                ref={imgRef}
                src={imageUrl}
                alt="Original"
                className="w-full h-auto block opacity-0 pointer-events-none"
                onLoad={() => resizeCanvasToImage()}
                onError={() => setError('Failed to load image. Please try again.')}
              />
              <canvas
                ref={canvasRef}
                className="w-full h-auto block touch-none"
                onPointerDown={(e) => {
                  const p = getCanvasPoint(e)
                  if (!p) return
                  setError(null)
                  if (tool === 'wand') {
                    floodClear(p.x, p.y)
                    return
                  }
                  isErasingRef.current = true
                  lastPointRef.current = p
                  ;(e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId)
                }}
                onPointerMove={(e) => {
                  if (!isErasingRef.current) return
                  const from = lastPointRef.current
                  const to = getCanvasPoint(e)
                  if (!from || !to) return
                  eraseLine(from, to)
                  lastPointRef.current = to
                }}
                onPointerUp={() => {
                  if (!isErasingRef.current) return
                  isErasingRef.current = false
                  lastPointRef.current = null
                  pushSnapshot()
                }}
                onPointerCancel={() => {
                  isErasingRef.current = false
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

function makePollinationsSeed() {
  const max = 2147483647
  const value = Date.now() % max
  return String(value <= 0 ? 1 : value)
}

type LibraryCategory = 'animals' | 'cartoons' | 'holidays' | 'fantasy' | 'nature'
type LibraryItem = {
  id: string
  title: string
  category: LibraryCategory
  tags: string[]
  image: string
}

function libraryImage(prompt: string, seed: number) {
  return buildPollinationsImageUrl(prompt, {
    model: 'flux',
    width: 1024,
    height: 1024,
    nologo: true,
    seed,
  })
}

const LIBRARY_ITEMS: LibraryItem[] = [
  { id: 'a-dog', title: 'Cute Dog', category: 'animals', tags: ['dogs'], image: libraryImage('cute puppy, coloring page, black and white, clean bold outlines, no shading', 10101) },
  { id: 'a-cat', title: 'Happy Cat', category: 'animals', tags: ['cats'], image: libraryImage('cute cat sitting, coloring page, black and white, clean bold outlines, no shading', 10102) },
  { id: 'a-eagle', title: 'Majestic Bird', category: 'animals', tags: ['birds', 'wild'], image: libraryImage('eagle flying, coloring page, black and white, clean bold outlines, no shading', 10103) },
  { id: 'a-dolphin', title: 'Sea Creature', category: 'animals', tags: ['sea', 'sea creatures'], image: libraryImage('dolphin jumping in ocean, coloring page, black and white, clean bold outlines, no shading', 10104) },
  { id: 'a-lion', title: 'Wild Lion', category: 'animals', tags: ['wild animals', 'wild'], image: libraryImage('lion portrait, coloring page, black and white, clean bold outlines, no shading', 10105) },
  { id: 'a-deer', title: 'Forest Deer', category: 'animals', tags: ['wild animals', 'wild'], image: libraryImage('deer in forest, coloring page, black and white, clean bold outlines, no shading', 10106) },

  { id: 'c-classic', title: 'Classic Cartoon Cat', category: 'cartoons', tags: ['classic'], image: libraryImage('classic cartoon cat, coloring page, black and white, clean bold outlines, no shading', 20201) },
  { id: 'c-anime', title: 'Anime Hero', category: 'cartoons', tags: ['anime'], image: libraryImage('anime hero character, coloring page, black and white, clean bold outlines, no shading', 20202) },
  { id: 'c-disney', title: 'Disney Style Princess', category: 'cartoons', tags: ['disney style'], image: libraryImage('disney style princess, coloring page, black and white, clean bold outlines, no shading', 20203) },
  { id: 'c-super', title: 'Superhero Mask', category: 'cartoons', tags: ['superheroes'], image: libraryImage('superhero mask and cape, coloring page, black and white, clean bold outlines, no shading', 20204) },
  { id: 'c-cute', title: 'Cute Cartoon Bunny', category: 'cartoons', tags: ['classic'], image: libraryImage('cute cartoon bunny, coloring page, black and white, clean bold outlines, no shading', 20205) },
  { id: 'c-anime2', title: 'Anime Girl', category: 'cartoons', tags: ['anime'], image: libraryImage('anime girl portrait, coloring page, black and white, clean bold outlines, no shading', 20206) },

  { id: 'h-christmas', title: 'Christmas Tree', category: 'holidays', tags: ['christmas'], image: libraryImage('christmas tree with ornaments, coloring page, black and white, clean bold outlines, no shading', 30301) },
  { id: 'h-halloween', title: 'Halloween Pumpkin', category: 'holidays', tags: ['halloween'], image: libraryImage('halloween pumpkin and bats, coloring page, black and white, clean bold outlines, no shading', 30302) },
  { id: 'h-easter', title: 'Easter Eggs', category: 'holidays', tags: ['easter'], image: libraryImage('easter eggs basket, coloring page, black and white, clean bold outlines, no shading', 30303) },
  { id: 'h-valentine', title: "Valentine's Hearts", category: 'holidays', tags: ["valentine's day"], image: libraryImage("valentine's day hearts and roses, coloring page, black and white, clean bold outlines, no shading", 30304) },
  { id: 'h-christmas2', title: 'Santa Sleigh', category: 'holidays', tags: ['christmas'], image: libraryImage('santa sleigh with reindeer, coloring page, black and white, clean bold outlines, no shading', 30305) },
  { id: 'h-halloween2', title: 'Haunted House', category: 'holidays', tags: ['halloween'], image: libraryImage('haunted house, coloring page, black and white, clean bold outlines, no shading', 30306) },

  { id: 'f-dragon', title: 'Dragon', category: 'fantasy', tags: ['dragons'], image: libraryImage('cute dragon, coloring page, black and white, clean bold outlines, no shading', 40401) },
  { id: 'f-unicorn', title: 'Unicorn', category: 'fantasy', tags: ['unicorns'], image: libraryImage('magical unicorn, coloring page, black and white, clean bold outlines, no shading', 40402) },
  { id: 'f-fairy', title: 'Fairy', category: 'fantasy', tags: ['fairies'], image: libraryImage('fairy with wings in forest, coloring page, black and white, clean bold outlines, no shading', 40403) },
  { id: 'f-mermaid', title: 'Mermaid', category: 'fantasy', tags: ['mermaids'], image: libraryImage('mermaid underwater, coloring page, black and white, clean bold outlines, no shading', 40404) },
  { id: 'f-castle', title: 'Castle', category: 'fantasy', tags: ['castles'], image: libraryImage('fantasy castle on hill, coloring page, black and white, clean bold outlines, no shading', 40405) },
  { id: 'f-dragon2', title: 'Dragon Rider', category: 'fantasy', tags: ['dragons'], image: libraryImage('dragon rider, coloring page, black and white, clean bold outlines, no shading', 40406) },

  { id: 'n-flowers', title: 'Flowers', category: 'nature', tags: ['flowers'], image: libraryImage('bouquet of flowers, coloring page, black and white, clean bold outlines, no shading', 50501) },
  { id: 'n-trees', title: 'Trees', category: 'nature', tags: ['trees'], image: libraryImage('forest trees, coloring page, black and white, clean bold outlines, no shading', 50502) },
  { id: 'n-mountains', title: 'Mountains', category: 'nature', tags: ['mountains', 'landscapes'], image: libraryImage('mountain landscape, coloring page, black and white, clean bold outlines, no shading', 50503) },
  { id: 'n-ocean', title: 'Ocean Waves', category: 'nature', tags: ['ocean', 'landscapes'], image: libraryImage('ocean waves, coloring page, black and white, clean bold outlines, no shading', 50504) },
  { id: 'n-landscape', title: 'Landscape', category: 'nature', tags: ['landscapes'], image: libraryImage('river landscape, coloring page, black and white, clean bold outlines, no shading', 50505) },
  { id: 'n-flower2', title: 'Garden', category: 'nature', tags: ['flowers'], image: libraryImage('flower garden, coloring page, black and white, clean bold outlines, no shading', 50506) },
]

const COLORING_PAGES_PAGE_CONFIG: Record<
  'all' | LibraryCategory,
  { title: string; subtitle: string; filters: Array<{ id: string; label: string }> }
> = {
  all: {
    title: 'Free Coloring Pages',
    subtitle: 'Browse and download free printable coloring pages.',
    filters: [
      { id: 'all', label: 'All' },
      { id: 'animals', label: 'Animals' },
      { id: 'cartoons', label: 'Cartoons' },
      { id: 'holidays', label: 'Holidays' },
      { id: 'fantasy', label: 'Fantasy' },
      { id: 'nature', label: 'Nature' },
    ],
  },
  animals: {
    title: 'Free Animal Coloring Pages',
    subtitle: 'Dogs, cats, wild animals, birds, and more.',
    filters: [
      { id: 'all', label: 'All' },
      { id: 'dogs', label: 'Dogs' },
      { id: 'cats', label: 'Cats' },
      { id: 'wild animals', label: 'Wild Animals' },
      { id: 'birds', label: 'Birds' },
      { id: 'sea creatures', label: 'Sea Creatures' },
    ],
  },
  cartoons: {
    title: 'Free Cartoon Coloring Pages',
    subtitle: 'Cartoon styles for kids and fans of animation.',
    filters: [
      { id: 'all', label: 'All' },
      { id: 'disney style', label: 'Disney Style' },
      { id: 'anime', label: 'Anime' },
      { id: 'superheroes', label: 'Superheroes' },
      { id: 'classic', label: 'Classic' },
    ],
  },
  holidays: {
    title: 'Free Holiday Coloring Pages',
    subtitle: 'Seasonal coloring pages for every celebration.',
    filters: [
      { id: 'all', label: 'All' },
      { id: 'christmas', label: 'Christmas' },
      { id: 'halloween', label: 'Halloween' },
      { id: 'easter', label: 'Easter' },
      { id: "valentine's day", label: "Valentine's Day" },
    ],
  },
  fantasy: {
    title: 'Free Fantasy Coloring Pages',
    subtitle: 'Dragons, unicorns, fairies, mermaids, and castles.',
    filters: [
      { id: 'all', label: 'All' },
      { id: 'dragons', label: 'Dragons' },
      { id: 'unicorns', label: 'Unicorns' },
      { id: 'fairies', label: 'Fairies' },
      { id: 'mermaids', label: 'Mermaids' },
      { id: 'castles', label: 'Castles' },
    ],
  },
  nature: {
    title: 'Free Nature Coloring Pages',
    subtitle: 'Flowers, trees, landscapes, mountains, and ocean scenes.',
    filters: [
      { id: 'all', label: 'All' },
      { id: 'flowers', label: 'Flowers' },
      { id: 'trees', label: 'Trees' },
      { id: 'landscapes', label: 'Landscapes' },
      { id: 'mountains', label: 'Mountains' },
      { id: 'ocean', label: 'Ocean' },
    ],
  },
}

// ==================== NAVIGATION ====================
type HeaderProps = {
  user: User | null
  onSignIn: () => void
  onSignOut: () => void
  isSigningIn: boolean
}

function Header({ user, onSignIn, onSignOut, isSigningIn }: HeaderProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const navItems = [
    {
      label: 'Free Coloring Pages',
      href: '/coloring-pages/all',
      dropdown: [
        { label: 'Animals', href: '/coloring-pages/animals', icon: '🐾' },
        { label: 'Cartoons', href: '/coloring-pages/cartoons', icon: '🎨' },
        { label: 'Holidays', href: '/coloring-pages/holidays', icon: '🎄' },
        { label: 'Fantasy', href: '/coloring-pages/fantasy', icon: '🦄' },
        { label: 'Nature', href: '/coloring-pages/nature', icon: '🌸' },
        { label: 'View All', href: '/coloring-pages/all', icon: '→' },
      ]
    },
    {
      label: 'AI Generators',
      href: '/generators',
      dropdown: [
        { label: 'Photo to Coloring Page', href: '/generators/photo-to-coloring', icon: '📸' },
        { label: 'Text to Coloring Page', href: '/generators/text-to-coloring', icon: '✏️' },
        { label: 'Coloring Book Generator', href: '/generators/coloring-book', icon: '📚' },
        { label: 'AI Image Editor', href: '/generators/image-editor', icon: '🪄' },
        { label: 'Colorize Drawing', href: '/generators/colorize', icon: '🎨' },
      ]
    },
    {
      label: 'Coloring Book Generator',
      href: '/generators/coloring-book',
      badge: 'New',
    },
    { label: 'Online Coloring', href: '/online-coloring' },
    { label: 'Gallery', href: '/coloring-pages/all' },
  ];

  return (
    <header className={`sticky top-0 z-50 transition-all duration-300 ${scrolled ? 'bg-white/95 backdrop-blur-md shadow-lg' : 'bg-white'}`}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 lg:h-20">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2 group">
            <div className="w-10 h-10 lg:w-12 lg:h-12 rounded-xl bg-gradient-to-br from-indigo-500 via-fuchsia-500 to-emerald-400 flex items-center justify-center group-hover:scale-110 transition-transform">
              <img src={inkbloomLogo} alt="InkBloom" className="w-6 h-6 lg:w-7 lg:h-7" />
            </div>
            <div className="flex flex-col">
              <span className="text-lg lg:text-xl font-bold leading-tight">
                <span className="text-indigo-600">Ink</span>
                <span className="text-emerald-500">Bloom</span>
              </span>
              <span className="text-xs text-gray-400 hidden sm:block">AI Coloring Studio</span>
            </div>
          </Link>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-1">
            {navItems.map((item, index) => (
              <div 
                key={index}
                className="relative"
                onMouseEnter={() => item.dropdown && setActiveDropdown(item.label)}
                onMouseLeave={() => setActiveDropdown(null)}
              >
                <Link
                  to={item.href}
                  className={`flex items-center gap-1 px-4 py-2 font-medium rounded-lg transition-colors ${
                    location.pathname === item.href ? 'text-indigo-600 bg-indigo-50' : 'text-gray-700 hover:text-indigo-600 hover:bg-indigo-50'
                  }`}
                >
                  {item.label}
                  {item.badge && (
                    <Badge className="ml-1 bg-gradient-to-r from-indigo-600 to-emerald-500 text-white text-xs">{item.badge}</Badge>
                  )}
                  {item.dropdown && <ChevronDown className="w-4 h-4" />}
                </Link>
                
                {/* Dropdown Menu */}
                {item.dropdown && activeDropdown === item.label && (
                  <div className="absolute top-full left-0 mt-1 w-64 bg-white rounded-xl shadow-xl border border-gray-100 overflow-hidden animate-in fade-in slide-in-from-top-2">
                    <div className="p-2">
                      {item.dropdown.map((subItem, subIndex) => (
                        <Link
                          key={subIndex}
                          to={subItem.href}
                          className="flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-indigo-50 text-gray-700 hover:text-indigo-600 transition-colors"
                          onClick={() => setActiveDropdown(null)}
                        >
                          <span className="text-xl">{subItem.icon}</span>
                          <span className="font-medium">{subItem.label}</span>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </nav>

          {/* CTA Buttons */}
          <div className="hidden md:flex items-center gap-3">
            {user ? (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-50">
                  {user.photoURL ? (
                    <img src={user.photoURL} alt="User" className="w-7 h-7 rounded-full" />
                  ) : (
                    <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center">
                      <Users className="w-4 h-4 text-indigo-600" />
                    </div>
                  )}
                  <span className="text-sm text-gray-700 max-w-40 truncate">
                    {user.displayName ?? user.email ?? 'Account'}
                  </span>
                </div>
                <Button variant="ghost" className="text-gray-600 hover:text-indigo-600" onClick={onSignOut}>
                  Sign Out
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                className="text-gray-600 hover:text-indigo-600"
                onClick={onSignIn}
                disabled={isSigningIn}
              >
                {isSigningIn && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Sign In
              </Button>
            )}
            <Button
              onClick={() => navigate('/generators/text-to-coloring')}
              className="bg-gradient-to-r from-indigo-600 to-emerald-500 hover:from-indigo-700 hover:to-emerald-600 text-white px-6"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              Get Started Free
            </Button>
          </div>

          {/* Mobile Menu Button */}
          <button 
            className="md:hidden p-2 hover:bg-gray-100 rounded-lg transition-colors"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>
      </div>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className="md:hidden bg-white border-t border-gray-100">
          <ScrollArea className="h-[calc(100vh-80px)]">
            <div className="p-4 space-y-2">
              {navItems.map((item, index) => (
                <div key={index}>
                  <Link
                    to={item.href}
                    className="flex items-center justify-between p-3 text-gray-700 font-medium rounded-lg hover:bg-indigo-50"
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    <span>{item.label}</span>
                    {item.badge && <Badge className="bg-indigo-600 text-white">{item.badge}</Badge>}
                  </Link>
                  {item.dropdown && (
                    <div className="ml-4 space-y-1">
                      {item.dropdown.map((subItem, subIndex) => (
                        <Link
                          key={subIndex}
                          to={subItem.href}
                          className="flex items-center gap-2 p-3 text-gray-600 rounded-lg hover:bg-gray-50"
                          onClick={() => setMobileMenuOpen(false)}
                        >
                          <span>{subItem.icon}</span>
                          <span>{subItem.label}</span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              <Separator className="my-4" />
              <Button
                onClick={() => {
                  setMobileMenuOpen(false);
                  navigate('/generators/text-to-coloring');
                }}
                className="w-full bg-gradient-to-r from-indigo-600 to-emerald-500 text-white"
              >
                <Sparkles className="w-4 h-4 mr-2" />
                Get Started Free
              </Button>
            </div>
          </ScrollArea>
        </div>
      )}
    </header>
  );
}

// ==================== HERO SECTION ====================
function HeroSection() {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [demoOpen, setDemoOpen] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  
  const slides = [
    {
      image: '/hero-cat.jpg',
      title: 'Turn Photos into Coloring Pages',
      subtitle: 'Upload any photo and watch AI transform it into a beautiful coloring page in seconds'
    },
    {
      image: '/mermaid-yoga.jpg',
      title: 'Create From Text Descriptions',
      subtitle: 'Simply describe what you want, and our AI will generate unique coloring pages'
    },
    {
      image: '/tortoise-hare-cover.jpg',
      title: 'Build Complete Coloring Books',
      subtitle: 'Generate multi-page coloring books with consistent characters and stories'
    }
  ];

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentSlide((prev) => (prev + 1) % slides.length);
    }, 5000);
    return () => clearInterval(timer);
  }, [slides.length]);

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (params.get('demo') === '1') {
      const id = window.setTimeout(() => setDemoOpen(true), 0)
      return () => window.clearTimeout(id)
    }
  }, [location.search])

  return (
    <section className="relative min-h-[90vh] flex items-center overflow-hidden">
      {/* Background Gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-slate-50 via-indigo-50 to-emerald-50" />
      
      {/* Animated Background Shapes */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-16 left-10 w-80 h-80 bg-indigo-300/15 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-16 right-10 w-[28rem] h-[28rem] bg-emerald-300/15 rounded-full blur-3xl animate-pulse delay-1000" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[780px] h-[780px] bg-fuchsia-300/10 rounded-full blur-3xl" />
      </div>

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-20">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          {/* Left Content */}
          <div className="space-y-8 text-center lg:text-left">
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-white rounded-full shadow-sm border border-indigo-100">
              <Badge className="bg-gradient-to-r from-indigo-600 to-emerald-500 text-white">Instant Studio</Badge>
              <span className="text-sm text-gray-600">Print-ready outlines, in seconds</span>
            </div>
            
            <h1 className="text-4xl sm:text-5xl lg:text-6xl xl:text-7xl font-bold leading-tight">
              Turn <span className="text-gradient">ideas</span>{' '}
              into <span className="text-gradient-orange">printable</span>{' '}
              <span className="text-indigo-600">coloring pages</span>
            </h1>
            
            <p className="text-lg lg:text-xl text-gray-600 max-w-2xl mx-auto lg:mx-0 leading-relaxed">
              Transform photos and text into stunning coloring pages with AI. Perfect for Amazon KDP, 
              Etsy sellers, teachers, parents, and creative enthusiasts. Create unlimited designs 
              in seconds!
            </p>
            
            <div className="flex flex-col sm:flex-row gap-4 justify-center lg:justify-start">
              <Button
                onClick={() => {
                  navigate('/generators/text-to-coloring')
                }}
                className="bg-gradient-to-r from-indigo-600 to-emerald-500 hover:from-indigo-700 hover:to-emerald-600 text-white px-8 py-6 text-lg rounded-xl shadow-lg shadow-indigo-600/20 hover:shadow-xl hover:shadow-indigo-600/25 transition-all"
              >
                <Sparkles className="w-5 h-5 mr-2" />
                Start Creating Free
              </Button>
              <Button
                onClick={() => setDemoOpen(true)}
                variant="outline"
                className="px-8 py-6 text-lg rounded-xl border-2 hover:bg-indigo-50"
              >
                <Play className="w-5 h-5 mr-2" />
                Watch Demo
              </Button>
            </div>
            
            <div className="flex flex-wrap gap-4 justify-center lg:justify-start pt-4">
              {[
                { icon: Shield, text: '100% Commercial License' },
                { icon: CreditCard, text: 'No Credit Card Required' },
                { icon: Clock, text: 'Instant Generation' },
              ].map((item, index) => (
                <div key={index} className="flex items-center gap-2 text-gray-600 bg-white/80 px-4 py-2 rounded-full">
                  <item.icon className="w-5 h-5 text-indigo-600" />
                  <span className="text-sm font-medium">{item.text}</span>
                </div>
              ))}
            </div>
          </div>
          
          {/* Right Content - Image Slider */}
          <div className="relative">
            <div className="relative rounded-3xl overflow-hidden shadow-2xl bg-white p-2">
              <div className="relative aspect-[4/5] rounded-2xl overflow-hidden">
                {slides.map((slide, index) => (
                  <div
                    key={index}
                    className={`absolute inset-0 transition-opacity duration-700 ${
                      index === currentSlide ? 'opacity-100' : 'opacity-0'
                    }`}
                  >
                    <img 
                      src={slide.image} 
                      alt={slide.title}
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-6">
                      <h3 className="text-white font-bold text-lg">{slide.title}</h3>
                      <p className="text-white/80 text-sm">{slide.subtitle}</p>
                    </div>
                  </div>
                ))}
              </div>
              
              {/* Slider Controls */}
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2">
                {slides.map((_, index) => (
                  <button
                    key={index}
                    onClick={() => setCurrentSlide(index)}
                    className={`w-2 h-2 rounded-full transition-all ${
                      index === currentSlide ? 'w-8 bg-indigo-600' : 'bg-white/50'
                    }`}
                  />
                ))}
              </div>
            </div>
            
            {/* Floating Stats Cards */}
            <div className="absolute -bottom-6 -left-6 bg-white rounded-xl shadow-xl p-4 border border-gray-100">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-indigo-100 rounded-lg flex items-center justify-center">
                  <Palette className="w-6 h-6 text-indigo-600" />
                </div>
                <div>
                  <div className="text-2xl font-bold text-gray-900">2.4M+</div>
                  <div className="text-sm text-gray-500">Pages Generated</div>
                </div>
              </div>
            </div>
            
            <div className="absolute -top-6 -right-6 bg-white rounded-xl shadow-xl p-4 border border-gray-100">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-emerald-100 rounded-lg flex items-center justify-center">
                  <Users className="w-6 h-6 text-emerald-600" />
                </div>
                <div>
                  <div className="text-2xl font-bold text-gray-900">320K+</div>
                  <div className="text-sm text-gray-500">Happy Users</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <Dialog open={demoOpen} onOpenChange={setDemoOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>How InkBloom Works</DialogTitle>
          </DialogHeader>
          <div className="grid md:grid-cols-3 gap-4">
            <div className="rounded-2xl border border-gray-200 p-5 bg-white">
              <div className="w-12 h-12 rounded-xl bg-indigo-100 flex items-center justify-center mb-4">
                <Upload className="w-6 h-6 text-indigo-600" />
              </div>
              <div className="font-semibold text-gray-900 mb-1">1) Upload</div>
              <div className="text-sm text-gray-600">Choose a photo or write a prompt for your coloring page.</div>
            </div>
            <div className="rounded-2xl border border-gray-200 p-5 bg-white">
              <div className="w-12 h-12 rounded-xl bg-emerald-100 flex items-center justify-center mb-4">
                <Wand2 className="w-6 h-6 text-emerald-600" />
              </div>
              <div className="font-semibold text-gray-900 mb-1">2) AI Converts</div>
              <div className="text-sm text-gray-600">AI turns it into clean black & white outlines.</div>
            </div>
            <div className="rounded-2xl border border-gray-200 p-5 bg-white">
              <div className="w-12 h-12 rounded-xl bg-fuchsia-100 flex items-center justify-center mb-4">
                <Download className="w-6 h-6 text-fuchsia-600" />
              </div>
              <div className="font-semibold text-gray-900 mb-1">3) Download</div>
              <div className="text-sm text-gray-600">Download PNG and print or color online.</div>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDemoOpen(false)}>Close</Button>
            <Button
              className="bg-gradient-to-r from-indigo-600 to-emerald-500 text-white"
              onClick={() => {
                setDemoOpen(false)
                navigate('/generators/photo-to-coloring')
              }}
            >
              Try It Now
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ==================== HOW IT WORKS ====================
function HowItWorksSection() {
  const steps = [
    {
      number: '01',
      title: 'Choose Your Method',
      description: 'Select from Photo-to-Coloring, Text-to-Coloring, or Coloring Book Generator based on your needs.',
      icon: Layers,
      color: 'from-indigo-500 to-indigo-600'
    },
    {
      number: '02',
      title: 'Upload or Describe',
      description: 'Upload your photo or type a detailed description of what you want to create.',
      icon: Upload,
      color: 'from-emerald-400 to-emerald-500'
    },
    {
      number: '03',
      title: 'AI Magic Happens',
      description: 'Our advanced AI processes your input and generates beautiful coloring pages in seconds.',
      icon: Wand2,
      color: 'from-fuchsia-500 to-fuchsia-600'
    },
    {
      number: '04',
      title: 'Download & Print',
      description: 'Get high-resolution PDF/PNG files ready for printing or digital coloring.',
      icon: Download,
      color: 'from-sky-500 to-sky-600'
    }
  ];

  return (
    <section className="py-20 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <Badge className="bg-indigo-100 text-indigo-700 mb-4">Simple Process</Badge>
          <h2 className="text-3xl lg:text-5xl font-bold text-gray-900 mb-4">How It Works</h2>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Create stunning coloring pages in just 4 simple steps. No design skills required!
          </p>
        </div>
        
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
          {steps.map((step, index) => (
            <div key={index} className="relative group">
              <div className="bg-gray-50 rounded-2xl p-8 h-full hover:bg-white hover:shadow-xl transition-all duration-300 border border-transparent hover:border-indigo-100">
                <div className={`w-16 h-16 rounded-2xl bg-gradient-to-br ${step.color} flex items-center justify-center mb-6 group-hover:scale-110 transition-transform`}>
                  <step.icon className="w-8 h-8 text-white" />
                </div>
                <div className="text-5xl font-bold text-gray-200 mb-4">{step.number}</div>
                <h3 className="text-xl font-bold text-gray-900 mb-3">{step.title}</h3>
                <p className="text-gray-600 leading-relaxed">{step.description}</p>
              </div>
              {index < steps.length - 1 && (
                <div className="hidden lg:block absolute top-1/2 -right-4 transform -translate-y-1/2 z-10">
                  <ArrowRight className="w-8 h-8 text-indigo-200" />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ==================== FEATURES GRID ====================
function FeaturesGridSection() {
  const features = [
    {
      icon: ImageIcon,
      title: 'Photo to Coloring Page',
      description: 'Transform any photo into a beautiful coloring page. Perfect for pet portraits, family photos, and favorite memories.',
      color: 'bg-indigo-100 text-indigo-700',
      href: '#photo-feature'
    },
    {
      icon: Type,
      title: 'Text to Coloring Page',
      description: 'Describe anything and watch AI create it. From unicorns to spaceships, if you can imagine it, we can draw it.',
      color: 'bg-emerald-100 text-emerald-700',
      href: '#text-feature'
    },
    {
      icon: BookOpen,
      title: 'Coloring Book Generator',
      description: 'Create complete coloring books with consistent characters and flowing stories. Perfect for Amazon KDP publishing.',
      color: 'bg-purple-100 text-purple-600',
      href: '#book-feature',
      badge: 'New'
    },
    {
      icon: Paintbrush,
      title: 'Colorize Drawings',
      description: 'Add vibrant colors to your black-and-white drawings with AI. Multiple artistic styles available.',
      color: 'bg-sky-100 text-sky-700',
      href: '#colorize-feature'
    },
    {
      icon: ScanLine,
      title: 'Line Art Converter',
      description: 'Convert any image to clean line art perfect for coloring. Adjust thickness and detail levels.',
      color: 'bg-green-100 text-green-600',
      href: '#'
    },
    {
      icon: PenTool,
      title: 'Online Coloring Tool',
      description: 'Color your pages directly in the browser. Save progress, try different palettes, and share your creations.',
      color: 'bg-yellow-100 text-yellow-600',
      href: '#online-coloring'
    }
  ];

  return (
    <section className="py-20 bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <Badge className="bg-indigo-100 text-indigo-700 mb-4">Powerful Tools</Badge>
          <h2 className="text-3xl lg:text-5xl font-bold text-gray-900 mb-4">Everything You Need</h2>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Six powerful AI tools to create, customize, and color your perfect coloring pages
          </p>
        </div>
        
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature, index) => (
            <a 
              key={index} 
              href={feature.href}
              className="group bg-white rounded-2xl p-8 hover:shadow-xl transition-all duration-300 border border-gray-100 hover:border-indigo-200"
            >
              <div className={`w-16 h-16 ${feature.color} rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform`}>
                <feature.icon className="w-8 h-8" />
              </div>
              <div className="flex items-center gap-2 mb-3">
                <h3 className="text-xl font-bold text-gray-900">{feature.title}</h3>
                {feature.badge && (
                  <Badge className="bg-gradient-to-r from-indigo-600 to-emerald-500 text-white text-xs">
                    {feature.badge}
                  </Badge>
                )}
              </div>
              <p className="text-gray-600 leading-relaxed mb-4">{feature.description}</p>
              <div className="flex items-center text-indigo-600 font-medium group-hover:gap-2 transition-all">
                <span>Learn More</span>
                <ArrowRight className="w-4 h-4 ml-1 group-hover:translate-x-1 transition-transform" />
              </div>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

// ==================== PHOTO TO COLORING FEATURE ====================
function PhotoToColoringSection() {
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [isColoringOpen, setIsColoringOpen] = useState(false)
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false)
  const [modelStatus, setModelStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [progressText, setProgressText] = useState<string | null>(null)
  const [compare, setCompare] = useState(50)

  useEffect(() => {
    if (!photoFile) {
      setPhotoPreviewUrl((prev) => {
        if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }

    const url = URL.createObjectURL(photoFile);
    setPhotoPreviewUrl((prev) => {
      if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
      return url;
    });

    return () => URL.revokeObjectURL(url);
  }, [photoFile]);

  useEffect(() => {
    return () => {
      if (resultUrl?.startsWith('blob:')) URL.revokeObjectURL(resultUrl);
    };
  }, [resultUrl]);

  const handleConvert = useCallback(async (fileOverride?: File) => {
    const file = fileOverride ?? photoFile
    if (!file) {
      setError('Please choose a file first.')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('Please choose an image under 10MB.')
      return
    }

    setError(null)
    setIsConverting(true)
    setCompare(50)

    try {
      if (modelStatus !== 'ready') {
        setModelStatus('loading')
        setProgressText('Loading AI model... (first time may take ~17MB)')
        await getLineArtSession()
        setModelStatus('ready')
      }

      setProgressText('Converting your photo...')
      const dataUrl = await convertFileToLineArtDataUrl(file, { invert: 'auto' })
      setResultUrl(dataUrl)
    } catch (err) {
      setModelStatus((prev) => (prev === 'loading' ? 'error' : prev))
      setError(err instanceof Error ? err.message : 'Conversion failed')
    } finally {
      setProgressText(null)
      setIsConverting(false)
    }
  }, [photoFile, modelStatus]);

  return (
    <section id="photo-feature" className="py-20 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          <div className="order-2 lg:order-1 space-y-8">
            <div>
              <Badge className="bg-indigo-100 text-indigo-700 mb-4">Photo Conversion</Badge>
              <h2 className="text-3xl lg:text-5xl font-bold text-gray-900 mb-4">
                Turn Photos into <span className="text-gradient">Coloring Pages</span>
              </h2>
              <p className="text-lg text-gray-600 leading-relaxed">
                Upload any photo and our AI will transform it into a beautiful, print-ready coloring page. 
                Perfect for creating personalized gifts, keepsakes, or products to sell.
              </p>
            </div>
            
            <div className="grid sm:grid-cols-2 gap-4">
              {[
                { icon: ImageIcon, title: 'Pet Portraits', desc: 'Turn pet photos into coloring pages' },
                { icon: Users, title: 'Family Photos', desc: 'Create family coloring memories' },
                { icon: Heart, title: 'Favorite Things', desc: 'Any object or scene you love' },
                { icon: Zap, title: 'Instant Results', desc: 'Get your page in seconds' },
              ].map((item, index) => (
                <div key={index} className="flex items-start gap-3 p-4 bg-gray-50 rounded-xl">
                  <div className="w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center flex-shrink-0">
                    <item.icon className="w-5 h-5 text-indigo-600" />
                  </div>
                  <div>
                    <h4 className="font-semibold text-gray-900">{item.title}</h4>
                    <p className="text-sm text-gray-500">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="space-y-3">
              <div
                className={`rounded-2xl border-2 border-dashed p-6 text-center transition-colors ${
                  isDragging ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white'
                }`}
                onDragEnter={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setIsDragging(true)
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setIsDragging(true)
                }}
                onDragLeave={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setIsDragging(false)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setIsDragging(false)
                  const file = e.dataTransfer.files?.[0] ?? null
                  setPhotoFile(file)
                }}
              >
                <div className="flex flex-col items-center gap-2">
                  <Upload className="w-6 h-6 text-indigo-600" />
                  <div className="text-sm text-gray-700">Drag & drop or click to upload</div>
                  <div className="text-xs text-gray-500">JPG, PNG, WEBP up to 10MB</div>
                </div>
                <Input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="mt-4"
                  onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
                />
              </div>

              <Button
                onClick={() => handleConvert()}
                disabled={isConverting}
                className="bg-gradient-to-r from-indigo-600 to-emerald-500 hover:from-indigo-700 hover:to-emerald-600 text-white px-8 py-6 text-lg rounded-xl"
              >
                <Upload className="w-5 h-5 mr-2" />
                {isConverting ? 'Converting...' : 'Convert to Coloring Page'}
              </Button>

              {isConverting && (
                <div className="rounded-xl border border-gray-200 bg-white p-4">
                  <div className="flex items-center gap-3">
                    <Loader2 className="w-5 h-5 text-indigo-600 animate-spin" />
                    <div className="text-sm text-gray-600">{progressText ?? 'Working...'}</div>
                  </div>
                  <div className="mt-3 h-2 rounded-full bg-gray-100 overflow-hidden">
                    <div className="h-full w-2/3 bg-gradient-to-r from-indigo-600 to-emerald-500 animate-pulse" />
                  </div>
                </div>
              )}

              {resultUrl && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Button
                    className="w-full bg-gradient-to-r from-emerald-500 to-indigo-600 hover:from-emerald-600 hover:to-indigo-700 text-white"
                    onClick={() => setIsColoringOpen(true)}
                  >
                    <Palette className="w-4 h-4 mr-2" />
                    Color Online
                  </Button>
                  <Button variant="outline" className="w-full" onClick={() => openOnlineColoring(resultUrl)}>
                    Open Coloring Studio
                  </Button>
                  <Button
                    className="w-full bg-gray-900 text-white hover:bg-gray-800"
                    onClick={() => {
                      const a = document.createElement('a')
                      a.href = resultUrl
                      a.download = 'inkbloom-coloring-page.png'
                      a.click()
                    }}
                  >
                    <Download className="w-4 h-4 mr-2" />
                    Download PNG
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      const doc = new jsPDF({ unit: 'pt', format: 'a4' })
                      const pageWidth = doc.internal.pageSize.getWidth()
                      const pageHeight = doc.internal.pageSize.getHeight()
                      const margin = 36
                      const maxW = pageWidth - margin * 2
                      const maxH = pageHeight - margin * 2
                      const size = Math.min(maxW, maxH)
                      const x = (pageWidth - size) / 2
                      const y = (pageHeight - size) / 2
                      doc.addImage(resultUrl, 'PNG', x, y, size, size)
                      doc.save('inkbloom-coloring-page.pdf')
                    }}
                  >
                    Download PDF
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      const w = window.open('', '_blank', 'noopener,noreferrer')
                      if (!w) return
                      w.document.write(
                        `<html><head><title>Print</title><style>body{margin:0}img{width:100%;height:auto;display:block}</style></head><body><img src="${resultUrl}"/></body></html>`
                      )
                      w.document.close()
                      w.focus()
                      w.print()
                    }}
                  >
                    Print
                  </Button>
                </div>
              )}

              {error && <div className="text-sm text-red-600">{error}</div>}
              {modelStatus === 'error' && (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    resetLineArtSession()
                    setModelStatus('idle')
                    setError(null)
                  }}
                >
                  Retry loading AI model
                </Button>
              )}
            </div>
          </div>
          
          <div className="order-1 lg:order-2">
            <div className="relative">
              {photoPreviewUrl && resultUrl ? (
                <div className="bg-white rounded-3xl shadow-2xl p-6">
                  <div className="relative rounded-2xl overflow-hidden bg-gray-50">
                    <div className="relative w-full h-[420px]">
                      <img
                        src={resultUrl}
                        alt="After"
                        onError={() => setError('Conversion failed, please try again')}
                        className="absolute inset-0 w-full h-full object-contain"
                      />
                      <img
                        src={photoPreviewUrl}
                        alt="Before"
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
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-4">
                    <div className="bg-white rounded-2xl shadow-lg p-3">
                      <img src="/ice-cream.jpg" alt="Original" className="rounded-xl w-full h-40 object-cover" />
                      <p className="text-center text-sm text-gray-500 mt-2">Original Photo</p>
                    </div>
                    <div className="bg-white rounded-2xl shadow-lg p-3">
                      <img src="/hero-cat.jpg" alt="Result" className="rounded-xl w-full h-48 object-cover" />
                      <p className="text-center text-sm text-gray-500 mt-2">Coloring Page</p>
                    </div>
                  </div>
                  <div className="space-y-4 pt-8">
                    <div className="bg-white rounded-2xl shadow-lg p-3">
                      <img src="/dino.jpg" alt="Result" className="rounded-xl w-full h-48 object-cover" />
                      <p className="text-center text-sm text-gray-500 mt-2">Cute Dinosaur</p>
                    </div>
                    <div className="bg-white rounded-2xl shadow-lg p-3">
                      <img src="/rabbit-lake.jpg" alt="Result" className="rounded-xl w-full h-40 object-cover" />
                      <p className="text-center text-sm text-gray-500 mt-2">Rabbit Scene</p>
                    </div>
                  </div>
                </div>
              )}
              
              {/* Floating Badge */}
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-full p-4 shadow-xl">
                <div className="w-16 h-16 bg-gradient-to-r from-indigo-600 to-emerald-500 rounded-full flex items-center justify-center">
                  <Wand2 className="w-8 h-8 text-white" />
                </div>
              </div>
            </div>
          </div>
        </div>
        <ManualColoringDialog
          open={isColoringOpen}
          onOpenChange={setIsColoringOpen}
          imageUrl={resultUrl}
          title="Color Online"
        />
      </div>
    </section>
  );
}

// ==================== TEXT TO COLORING FEATURE ====================
function TextToColoringSection() {
  const [prompt, setPrompt] = useState('');
  const [style, setStyle] = useState<'Simple' | 'Detailed' | 'Realistic' | 'Cartoon' | 'Mandala'>('Detailed')
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedImageUrl, setGeneratedImageUrl] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [slowNotice, setSlowNotice] = useState(false)
  const [showImage, setShowImage] = useState(false)
  const [lastGeneratedAt, setLastGeneratedAt] = useState<number | null>(null)

  const examples = [
    { prompt: 'A cute astronaut cat on the moon', image: '/hero-cat.jpg' },
    { prompt: 'A friendly dragon in a castle garden', image: '/dragon.jpg' },
    { prompt: 'A magical princess and a castle', image: '/princess.jpg' },
    { prompt: 'A magical unicorn in a rainbow forest', image: '/unicorn.jpg' },
    { prompt: 'A puppy with flowers', image: '/dog.jpg' },
    { prompt: 'A butterfly garden', image: '/butterfly.jpg' },
  ];

  useEffect(() => {
    return () => {
      if (generatedImageUrl?.startsWith('blob:')) URL.revokeObjectURL(generatedImageUrl);
    };
  }, [generatedImageUrl]);

  const handleGenerate = async () => {
    const effectivePrompt = (prompt || 'A cute astronaut cat on the moon').trim();
    if (!effectivePrompt) return;
    if (lastGeneratedAt && Date.now() - lastGeneratedAt < 5000) {
      setGenerateError('Please wait 5 seconds between generations.')
      return
    }

    setGenerateError(null);
    setIsGenerating(true);
    setSlowNotice(false)
    setShowImage(false)

    try {
      const styleHintMap: Record<typeof style, string> = {
        Simple: 'simple shapes, minimal detail',
        Detailed: 'high detail, intricate outlines',
        Realistic: 'realistic proportions, natural details',
        Cartoon: 'cute cartoon style, clean outlines',
        Mandala: 'mandala patterns, symmetric ornamental details',
      }
      const coloringPrompt = `${effectivePrompt}, ${styleHintMap[style]}, black and white coloring page, clean bold outlines, no shading, no colors, suitable for coloring book, high detail line art`
      const seed = makePollinationsSeed()
      const url = buildPollinationsImageUrl(coloringPrompt, {
        model: 'flux',
        seed,
        nologo: true,
        width: 1024,
        height: 1024,
      })
      const slowTimer = window.setTimeout(() => setSlowNotice(true), 30_000)
      try {
        await preloadImageWithRetry(url, 120_000, 1)
      } finally {
        window.clearTimeout(slowTimer)
      }
      setGeneratedImageUrl(url)
      setLastGeneratedAt(Date.now())
      window.requestAnimationFrame(() => setShowImage(true))
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <section id="text-feature" className="py-20 bg-gradient-to-br from-slate-50 via-indigo-50 to-emerald-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <Badge className="bg-indigo-100 text-indigo-700 mb-4">Text-to-Image</Badge>
          <h2 className="text-3xl lg:text-5xl font-bold text-gray-900 mb-4">
            Describe It, <span className="text-gradient">We Draw It</span>
          </h2>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Simply type what you want to see, and our AI will create a unique coloring page. 
            From simple descriptions to complex scenes.
          </p>
        </div>
        
        {/* Demo Input */}
        <div className="max-w-2xl mx-auto mb-16">
          <div className="bg-white rounded-2xl shadow-xl p-2">
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="flex-1 relative">
                <MessageSquare className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <Input 
                  id="text-generator-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Describe your coloring page... (e.g., 'A cute unicorn in a rainbow forest')"
                  className="pl-12 h-14 border-0 text-lg"
                />
              </div>
              <select
                value={style}
                onChange={(e) => setStyle(e.target.value as typeof style)}
                className="h-14 px-4 rounded-xl border border-gray-200 bg-white text-gray-700"
              >
                <option value="Simple">Simple</option>
                <option value="Detailed">Detailed</option>
                <option value="Realistic">Realistic</option>
                <option value="Cartoon">Cartoon</option>
                <option value="Mandala">Mandala</option>
              </select>
              <Button
                onClick={handleGenerate}
                disabled={isGenerating}
                className="bg-gradient-to-r from-indigo-600 to-emerald-500 hover:from-indigo-700 hover:to-emerald-600 text-white px-6 h-14"
              >
                <Sparkles className="w-5 h-5 mr-2" />
                {isGenerating ? 'Generating...' : 'Generate'}
              </Button>
            </div>
          </div>
          <p className="text-center text-sm text-gray-500 mt-4">
            Try: "A cute astronaut cat on the moon" or "A magical fairy garden"
          </p>
          {isGenerating && (
            <div className="mt-3 text-center text-sm text-gray-500">
              Generating your coloring page... (10-30 seconds)
              {slowNotice && <div className="mt-1">This is taking longer than usual...</div>}
            </div>
          )}

          {generateError && (
            <div className="mt-4 text-center text-sm text-red-600">
              {generateError}
              <div className="mt-3 flex justify-center">
                <Button variant="outline" onClick={handleGenerate} disabled={isGenerating}>
                  Retry
                </Button>
              </div>
            </div>
          )}

          {generatedImageUrl && (
            <div className="mt-6 bg-white rounded-2xl shadow-xl p-3">
              <img
                src={generatedImageUrl}
                alt="Generated preview"
                crossOrigin="anonymous"
                onError={() => setGenerateError('Generation failed, please try again')}
                className={`rounded-xl w-full max-h-[520px] object-contain bg-gray-50 transition-opacity duration-500 ${showImage ? 'opacity-100' : 'opacity-0'}`}
              />
              <div className="mt-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => openOnlineColoring(generatedImageUrl)}
                  >
                    Color This Online
                  </Button>
                  <Button
                    className="w-full bg-gray-900 text-white hover:bg-gray-800"
                    onClick={() => {
                      fetch(generatedImageUrl)
                        .then((res) => res.blob())
                        .then((blob) => {
                          const url = URL.createObjectURL(blob)
                          const a = document.createElement('a')
                          a.href = url
                          a.download = 'coloring-page.png'
                          a.click()
                          window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
                        })
                        .catch(() => window.open(generatedImageUrl, '_blank', 'noopener,noreferrer'))
                    }}
                  >
                    <Download className="w-4 h-4 mr-2" />
                    Download
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
        
        {/* Examples */}
        <div className="grid md:grid-cols-3 gap-8">
          {examples.map((example, index) => (
            <div key={index} className="group">
              <div className="bg-white rounded-2xl overflow-hidden shadow-lg hover:shadow-xl transition-shadow">
                <div className="aspect-square overflow-hidden">
                  <img 
                    src={example.image} 
                    alt={example.prompt}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                  />
                </div>
                <div className="p-4">
                  <p className="text-sm text-gray-500 mb-2">Prompt:</p>
                  <p className="text-gray-900 font-medium">"{example.prompt}"</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ==================== COLORING BOOK GENERATOR ====================
function ColoringBookSection() {
  const [theme, setTheme] = useState('')
  const [pageCount, setPageCount] = useState(10)
  const [style, setStyle] = useState<'Kids' | 'Adult' | 'Mandala' | 'Animals'>('Kids')
  const [isGenerating, setIsGenerating] = useState(false)
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null)
  const [pages, setPages] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isDownloadingAll, setIsDownloadingAll] = useState(false)
  const [zipProgress, setZipProgress] = useState<{ current: number; total: number } | null>(null)

  useEffect(() => {
    return () => {
      pages.forEach((u) => {
        if (u.startsWith('blob:')) URL.revokeObjectURL(u)
      })
    }
  }, [pages])

  const clampedCount = Math.max(5, Math.min(20, Number.isFinite(pageCount) ? pageCount : 10))

  const styleHintMap: Record<typeof style, string> = {
    Kids: 'simple, kid-friendly, big shapes, minimal detail',
    Adult: 'high detail, intricate, complex patterns',
    Mandala: 'mandala patterns, symmetric ornamental details',
    Animals: 'cute animals, clean bold outlines, kid-friendly',
  }

  const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

  const downloadUrlAsPng = async (url: string, filename: string) => {
    const res = await fetch(url)
    const blob = await res.blob()
    const blobUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = filename
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000)
  }

  const generateBook = async () => {
    const t = (theme || 'Magical forest animals').trim()
    if (!t) {
      setError('Please enter a book theme.')
      return
    }

    setError(null)
    setIsGenerating(true)
    setPages([])
    setProgress({ current: 0, total: clampedCount })

    try {
      const base =
        'black and white coloring page, clean bold outlines, no shading, no gray, no colors, white background, printable line art'
      const hint = styleHintMap[style]

      const generated: string[] = []
      for (let i = 1; i <= clampedCount; i++) {
        setProgress({ current: i, total: clampedCount })
        const prompt = `${t}, ${hint}, ${base}, page ${i} of ${clampedCount}`
        const seed = makePollinationsSeed()
        const url = buildPollinationsImageUrl(prompt, {
          model: 'flux',
          width: 1024,
          height: 1024,
          nologo: true,
          seed,
        })
        await preloadImageWithRetry(url, 120_000, 1)
        generated.push(url)
        setPages([...generated])
        if (i < clampedCount) await sleep(5000)
      }

      setProgress(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed. Please try again.')
      setProgress(null)
    } finally {
      setIsGenerating(false)
    }
  }

  const downloadAll = async () => {
    if (!pages.length) return
    setIsDownloadingAll(true)
    setZipProgress({ current: 0, total: pages.length })
    try {
      const zip = new JSZip()
      for (let i = 0; i < pages.length; i++) {
        setZipProgress({ current: i + 1, total: pages.length })
        const res = await fetch(pages[i])
        if (!res.ok) throw new Error('Download failed. Please try again.')
        const blob = await res.blob()
        zip.file(`inkbloom-book-page-${i + 1}.png`, blob)
        if (i < pages.length - 1) await sleep(1000)
      }
      const zipBlob = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(zipBlob)
      const safeTheme = (theme || 'inkbloom-book')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
      const a = document.createElement('a')
      a.href = url
      a.download = `${safeTheme || 'inkbloom-book'}.zip`
      a.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed. Please try again.')
    } finally {
      setZipProgress(null)
      setIsDownloadingAll(false)
    }
  }

  return (
    <section id="book-feature" className="py-20 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <Badge className="bg-indigo-100 text-indigo-700 mb-4">Coloring Book Generator</Badge>
          <h2 className="text-3xl lg:text-5xl font-bold text-gray-900 mb-4">Create a Full Coloring Book in Minutes</h2>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Choose a theme, select a style, and generate a complete set of pages. Generation is sequential to respect rate limits.
          </p>
        </div>

        <div className="max-w-3xl mx-auto bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sm:p-6 space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <div className="text-sm text-gray-600 mb-2">Book Theme</div>
              <Input value={theme} onChange={(e) => setTheme(e.target.value)} placeholder="e.g., Space adventure animals" />
            </div>
            <div>
              <div className="text-sm text-gray-600 mb-2">Style</div>
              <select
                className="w-full h-10 rounded-md border border-gray-200 px-3"
                value={style}
                onChange={(e) => setStyle(e.target.value as typeof style)}
              >
                <option value="Kids">Kids</option>
                <option value="Adult">Adult</option>
                <option value="Mandala">Mandala</option>
                <option value="Animals">Animals</option>
              </select>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <div className="text-sm text-gray-600 mb-2">Number of Pages (5–20)</div>
              <Input
                type="number"
                min={5}
                max={20}
                value={clampedCount}
                onChange={(e) => setPageCount(Number(e.target.value || 10))}
              />
            </div>
            <div className="flex items-end gap-2">
              <Button
                className="w-full bg-gradient-to-r from-indigo-600 to-emerald-500 hover:from-indigo-700 hover:to-emerald-600 text-white"
                onClick={() => void generateBook()}
                disabled={isGenerating}
              >
                <BookOpen className="w-5 h-5 mr-2" />
                {isGenerating ? 'Generating...' : 'Generate Book'}
              </Button>
              <Button
                variant="outline"
                className="whitespace-nowrap"
                onClick={() => void downloadAll()}
                disabled={isGenerating || isDownloadingAll || pages.length === 0}
              >
                {isDownloadingAll ? 'Preparing ZIP...' : 'Download All (ZIP)'}
              </Button>
            </div>
          </div>

          {zipProgress && (
            <div className="mt-2">
              <div className="flex justify-between text-sm text-gray-600 mb-2">
                <span>Preparing ZIP {zipProgress.current} of {zipProgress.total}...</span>
                <span>{Math.round((zipProgress.current / zipProgress.total) * 100)}%</span>
              </div>
              <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-indigo-600 to-emerald-500"
                  style={{ width: `${(zipProgress.current / zipProgress.total) * 100}%` }}
                />
              </div>
            </div>
          )}

          {progress && (
            <div className="mt-2">
              <div className="flex justify-between text-sm text-gray-600 mb-2">
                <span>Generating page {progress.current} of {progress.total}...</span>
                <span>{Math.round((progress.current / progress.total) * 100)}%</span>
              </div>
              <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-indigo-600 to-emerald-500"
                  style={{ width: `${(progress.current / progress.total) * 100}%` }}
                />
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-700 flex items-center justify-between gap-3">
              <div className="text-sm">{error}</div>
              <Button variant="outline" onClick={() => void generateBook()} disabled={isGenerating}>
                Retry
              </Button>
            </div>
          )}
        </div>

        {pages.length > 0 && (
          <div className="mt-10">
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {pages.map((url, idx) => (
                <div key={url} className="bg-white rounded-2xl border border-gray-100 overflow-hidden shadow-sm">
                  <div className="aspect-square bg-gray-50">
                    <img
                      src={url}
                      alt={`Generated page ${idx + 1}`}
                      crossOrigin="anonymous"
                      onError={() => setError('Generation failed. Please try again.')}
                      className="w-full h-full object-contain"
                    />
                  </div>
                  <div className="p-4 flex items-center justify-between">
                    <div className="text-sm text-gray-600">Page {idx + 1}</div>
                    <Button
                      size="sm"
                      className="bg-gray-900 text-white hover:bg-gray-800"
                      onClick={() => void downloadUrlAsPng(url, `inkbloom-book-page-${idx + 1}.png`)}
                    >
                      <Download className="w-4 h-4 mr-2" />
                      Download
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function ImageEditorSection() {
  type EditMode = 'colorize' | 'enhance' | 'background' | 'style' | 'custom'

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [mode, setMode] = useState<EditMode>('colorize')
  const [isWorking, setIsWorking] = useState(false)
  const [progressText, setProgressText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [compare, setCompare] = useState(50)
  const [isColoringOpen, setIsColoringOpen] = useState(false)
  const [isBgOpen, setIsBgOpen] = useState(false)

  useEffect(() => {
    if (!file) {
      queueMicrotask(() =>
        setPreviewUrl((prev) => {
          if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
          return null
        })
      )
      return
    }
    const url = URL.createObjectURL(file)
    queueMicrotask(() =>
      setPreviewUrl((prev) => {
        if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
        return url
      })
    )
    return () => URL.revokeObjectURL(url)
  }, [file])

  useEffect(() => {
    return () => {
      if (resultUrl?.startsWith('blob:')) URL.revokeObjectURL(resultUrl)
    }
  }, [resultUrl])

  const handleFileSelect = (selected: File) => {
    const allowed = new Set(['image/png', 'image/jpeg', 'image/webp'])
    if (!allowed.has(selected.type)) {
      setError('Please upload a PNG, JPG, or WEBP image.')
      return
    }
    if (selected.size > 10 * 1024 * 1024) {
      setError('File too large. Max 10MB.')
      return
    }
    setError(null)
    setFile(selected)
    setCompare(50)
    setResultUrl((prev) => {
      if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
      return null
    })
  }

  const enhanceInBrowser = async (source: File) => {
    const bmp = await createImageBitmap(source)
    const maxSide = 2048
    const scale = 2
    const targetW = Math.min(maxSide, bmp.width * scale)
    const targetH = Math.min(maxSide, bmp.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = targetW
    canvas.height = targetH
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas not supported')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, 0, 0, targetW, targetH)

    const img = ctx.getImageData(0, 0, targetW, targetH)
    const d = img.data
    const out = new Uint8ClampedArray(d.length)
    const idx = (x: number, y: number) => (y * targetW + x) * 4
    const clamp = (n: number) => (n < 0 ? 0 : n > 255 ? 255 : n)
    for (let y = 1; y < targetH - 1; y++) {
      for (let x = 1; x < targetW - 1; x++) {
        const i = idx(x, y)
        for (let c = 0; c < 3; c++) {
          const v =
            5 * d[i + c] -
            d[idx(x - 1, y) + c] -
            d[idx(x + 1, y) + c] -
            d[idx(x, y - 1) + c] -
            d[idx(x, y + 1) + c]
          const contrast = 1.08
          const centered = (v - 128) * contrast + 128
          out[i + c] = clamp(centered)
        }
        out[i + 3] = d[i + 3]
      }
    }
    img.data.set(out)
    ctx.putImageData(img, 0, 0)

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('Enhancement failed')
    return URL.createObjectURL(blob)
  }

  const runEdit = async () => {
    if (!file || !previewUrl) {
      setError('Please upload an image first.')
      return
    }
    setError(null)

    if (mode === 'colorize') {
      setIsColoringOpen(true)
      return
    }
    if (mode === 'background') {
      setIsBgOpen(true)
      return
    }
    if (mode === 'style' || mode === 'custom') {
      setError('Coming soon.')
      return
    }

    setIsWorking(true)
    setProgressText('Enhancing image...')
    try {
      const outUrl = await enhanceInBrowser(file)
      setResultUrl((prev) => {
        if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
        return outUrl
      })
      setCompare(50)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enhancement failed')
    } finally {
      setProgressText(null)
      setIsWorking(false)
    }
  }

  const handleDownload = () => {
    if (!resultUrl) return
    fetch(resultUrl)
      .then((res) => res.blob())
      .then((blob) => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'edited.png'
        a.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
      })
      .catch(() => window.open(resultUrl, '_blank', 'noopener,noreferrer'))
  }

  return (
    <section id="edit-feature" className="py-20 bg-slate-950 text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid lg:grid-cols-2 gap-12 items-start">
          <div className="space-y-6">
            <Badge className="bg-indigo-500/20 text-indigo-200 border border-indigo-500/30">AI Image Editing</Badge>
            <h2 className="text-3xl lg:text-5xl font-bold">
              Edit Photos with <span className="text-transparent bg-clip-text bg-gradient-to-r from-violet-400 to-emerald-300">AI</span>
            </h2>
            <p className="text-slate-300 leading-relaxed">
              Upload an image, choose an edit, and apply it directly in your browser. No API keys required.
            </p>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleFileSelect(f)
              }}
            />

            <div
              role="button"
              tabIndex={0}
              className={`rounded-xl border-2 border-dashed p-5 transition-colors ${isDragging ? 'border-violet-400 bg-white/5' : 'border-white/15 hover:border-violet-400/70'}`}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click()
              }}
              onDragEnter={(e) => {
                e.preventDefault()
                setIsDragging(true)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setIsDragging(true)
              }}
              onDragLeave={(e) => {
                e.preventDefault()
                setIsDragging(false)
              }}
              onDrop={(e) => {
                e.preventDefault()
                setIsDragging(false)
                const f = e.dataTransfer.files?.[0]
                if (f) handleFileSelect(f)
              }}
            >
              <div className="flex items-center gap-3">
                <Upload className="w-5 h-5 text-violet-300" />
                <div className="flex-1">
                  <div className="font-medium">{file ? file.name : 'Drag & drop or click to upload'}</div>
                  <div className="text-sm text-slate-400">JPG, PNG, WEBP up to 10MB</div>
                </div>
                {file && (
                  <Button
                    type="button"
                    variant="outline"
                    className="border-white/20 text-white hover:bg-white/10"
                    onClick={(e) => {
                      e.stopPropagation()
                      setFile(null)
                      setResultUrl((prev) => {
                        if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
                        return null
                      })
                    }}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                )}
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                <div className="text-sm text-slate-300 mb-3">Edit Type</div>
                <Tabs value={mode} onValueChange={(v) => setMode(v as EditMode)}>
                  <TabsList className="grid grid-cols-2 sm:grid-cols-3 bg-slate-900/70">
                    <TabsTrigger value="colorize">Colorize</TabsTrigger>
                    <TabsTrigger value="enhance">Enhance</TabsTrigger>
                    <TabsTrigger value="background">Background</TabsTrigger>
                    <TabsTrigger value="style" disabled>
                      Style
                    </TabsTrigger>
                    <TabsTrigger value="custom" disabled>
                      Custom
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                {(mode === 'style' || mode === 'custom') && (
                  <div className="mt-2 text-xs text-slate-400">Coming soon.</div>
                )}
              </div>
              <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                <div className="text-sm text-slate-300 mb-2">Output</div>
                <div className="text-sm text-slate-400">
                  {mode === 'enhance'
                    ? 'Upscale + sharpen (browser)'
                    : mode === 'background'
                      ? 'Transparent PNG'
                      : 'Manual workspace'}
                </div>
              </div>
            </div>

            <Button
              className="w-full bg-gradient-to-r from-violet-500 to-indigo-500 hover:from-violet-600 hover:to-indigo-600 text-white py-6 text-lg rounded-xl"
              disabled={isWorking || !file}
              onClick={() => void runEdit()}
            >
              {isWorking ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  {progressText ?? 'Working...'}
                </>
              ) : (
                <>
                  <Wand2 className="w-5 h-5 mr-2" />
                  {mode === 'colorize' ? 'Open Coloring' : mode === 'background' ? 'Open Background Remover' : 'Enhance'}
                </>
              )}
            </Button>

            {error && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-red-100 flex items-center justify-between gap-3">
                <div className="text-sm">{error}</div>
                <Button
                  variant="outline"
                  className="border-red-500/40 text-red-100 hover:bg-red-500/20"
                  onClick={() => void runEdit()}
                  disabled={isWorking}
                >
                  Retry
                </Button>
              </div>
            )}

          </div>

          <div className="space-y-4">
            <div className="bg-white/5 border border-white/10 rounded-3xl p-5">
              {!previewUrl ? (
                <div className="h-[420px] flex items-center justify-center text-slate-400">
                  Upload an image to start editing.
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="relative rounded-2xl overflow-hidden bg-black/30">
                    <div className="relative w-full h-[420px]">
                      {resultUrl && (
                        <img
                          src={resultUrl}
                          alt="After"
                          onError={() => setError('Generation failed, please try again')}
                          className="absolute inset-0 w-full h-full object-contain"
                        />
                      )}
                      <img
                        src={previewUrl}
                        alt="Before"
                        className="absolute inset-0 w-full h-full object-contain"
                        style={resultUrl ? { clipPath: `inset(0 ${100 - compare}% 0 0)` } : undefined}
                      />
                      {resultUrl && (
                        <div className="absolute inset-y-0" style={{ left: `${compare}%` }}>
                          <div className="w-0.5 h-full bg-white/70" />
                        </div>
                      )}
                    </div>
                  </div>

                  {resultUrl && (
                    <div className="space-y-3">
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={compare}
                        onChange={(e) => setCompare(Number(e.target.value))}
                        className="w-full"
                      />
                      <div className="grid grid-cols-2 gap-3">
                        <Button className="bg-gray-900 text-white hover:bg-gray-800" onClick={handleDownload}>
                          <Download className="w-4 h-4 mr-2" />
                          Download
                        </Button>
                        <Button
                          variant="outline"
                          className="border-white/15 text-white hover:bg-white/10"
                          onClick={() => void runEdit()}
                          disabled={isWorking}
                        >
                          Retry
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        <ManualColoringDialog
          open={isColoringOpen}
          onOpenChange={setIsColoringOpen}
          imageUrl={previewUrl}
          title="Colorize (Manual)"
          onExport={(url) =>
            setResultUrl((prev) => {
              if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
              return url
            })
          }
        />
        <BackgroundRemovalDialog
          open={isBgOpen}
          onOpenChange={setIsBgOpen}
          imageUrl={previewUrl}
          title="Background Remover"
          onExport={(url) =>
            setResultUrl((prev) => {
              if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
              return url
            })
          }
        />
      </div>
    </section>
  )
}

// ==================== COLORIZE DRAWING ====================
function ColorizeSection() {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [isColoringOpen, setIsColoringOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!file) {
      queueMicrotask(() =>
        setPreviewUrl((prev) => {
          if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
          return null
        })
      )
      return
    }
    const url = URL.createObjectURL(file)
    queueMicrotask(() =>
      setPreviewUrl((prev) => {
        if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
        return url
      })
    )
    return () => URL.revokeObjectURL(url)
  }, [file])

  const handleFileSelect = (f: File) => {
    const allowed = new Set(['image/png', 'image/jpeg', 'image/webp'])
    if (!allowed.has(f.type)) {
      setError('Please upload a PNG, JPG, or WEBP image.')
      return
    }
    if (f.size > 10 * 1024 * 1024) {
      setError('File is too large. Please upload an image under 10MB.')
      return
    }
    setError(null)
    setFile(f)
  }

  const reset = () => {
    setError(null)
    setFile(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <section id="colorize-feature" className="py-20 bg-gradient-to-br from-slate-50 via-indigo-50 to-emerald-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          <div className="space-y-8 order-2 lg:order-1">
            <div>
              <Badge className="bg-indigo-100 text-indigo-700 mb-4">Online Coloring</Badge>
              <h2 className="text-3xl lg:text-5xl font-bold text-gray-900 mb-4">
                Color your page <span className="text-gradient">in the browser</span>
              </h2>
              <p className="text-lg text-gray-600 leading-relaxed">
                Upload a black and white coloring page and color it manually online. No account, no API keys.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              {[
                { icon: Palette, title: 'Brush & Colors', desc: 'Pick colors and paint instantly' },
                { icon: Download, title: 'Download', desc: 'Export your colored PNG' },
                { icon: Shield, title: 'No Keys', desc: 'Works without external AI APIs' },
                { icon: Zap, title: 'Fast', desc: 'Runs entirely in your browser' },
              ].map((item) => (
                <div key={item.title} className="flex items-start gap-3">
                  <item.icon className="w-5 h-5 text-indigo-600 mt-0.5" />
                  <div>
                    <h4 className="font-medium text-gray-900">{item.title}</h4>
                    <p className="text-sm text-gray-500">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleFileSelect(f)
              }}
            />

            <div
              role="button"
              tabIndex={0}
              className={`rounded-xl border-2 border-dashed p-6 bg-white transition-colors ${isDragging ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-indigo-300'}`}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click()
              }}
              onDragEnter={(e) => {
                e.preventDefault()
                setIsDragging(true)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setIsDragging(true)
              }}
              onDragLeave={(e) => {
                e.preventDefault()
                setIsDragging(false)
              }}
              onDrop={(e) => {
                e.preventDefault()
                setIsDragging(false)
                const f = e.dataTransfer.files?.[0]
                if (f) handleFileSelect(f)
              }}
            >
              <div className="flex items-center gap-3">
                <Upload className="w-5 h-5 text-indigo-600" />
                <div className="flex-1">
                  <div className="font-medium text-gray-900">{file ? file.name : 'Drag & drop or click to upload'}</div>
                  <div className="text-sm text-gray-500">Supports PNG, JPG, WEBP up to 10MB</div>
                </div>
                {file && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={(e) => {
                      e.stopPropagation()
                      reset()
                    }}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Button
                className="w-full bg-gradient-to-r from-emerald-500 to-indigo-600 hover:from-emerald-600 hover:to-indigo-700 text-white px-8 py-6 text-lg rounded-xl"
                disabled={!previewUrl}
                onClick={() => setIsColoringOpen(true)}
              >
                <Palette className="w-5 h-5 mr-2" />
                Start Coloring
              </Button>
              <Button variant="outline" className="w-full" disabled={!previewUrl} onClick={reset}>
                Try Another
              </Button>
            </div>

            {error && <div className="text-sm text-red-600">{error}</div>}
          </div>

          <div className="order-1 lg:order-2">
            <div className="bg-white rounded-3xl shadow-2xl p-6">
              {previewUrl ? (
                <div className="rounded-2xl overflow-hidden bg-gray-50 border border-gray-100">
                  <img src={previewUrl} alt="Preview" className="w-full h-auto block" />
                </div>
              ) : (
                <div className="relative rounded-2xl overflow-hidden">
                  <img src="/lion.jpg" alt="Example" className="w-full h-auto" />
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
                </div>
              )}
            </div>
          </div>
        </div>
        <ManualColoringDialog
          open={isColoringOpen}
          onOpenChange={setIsColoringOpen}
          imageUrl={previewUrl}
          title="Color Online"
        />
      </div>
    </section>
  )
}

// ==================== GALLERY SECTION ====================
function GallerySection({ initialFilter }: { initialFilter?: string }) {
  const [activeFilter, setActiveFilter] = useState(initialFilter ?? 'all');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  const filters = [
    { id: 'all', label: 'All', count: LIBRARY_ITEMS.length },
    { id: 'animals', label: 'Animals', count: LIBRARY_ITEMS.filter((x) => x.category === 'animals').length },
    { id: 'cartoons', label: 'Cartoons', count: LIBRARY_ITEMS.filter((x) => x.category === 'cartoons').length },
    { id: 'fantasy', label: 'Fantasy', count: LIBRARY_ITEMS.filter((x) => x.category === 'fantasy').length },
    { id: 'holidays', label: 'Holidays', count: LIBRARY_ITEMS.filter((x) => x.category === 'holidays').length },
    { id: 'nature', label: 'Nature', count: LIBRARY_ITEMS.filter((x) => x.category === 'nature').length },
  ];

  const coloringPages = LIBRARY_ITEMS.map((item, index) => ({
    id: item.id,
    image: item.image,
    title: item.title,
    category: item.category,
    pages: String(24 + ((index * 7) % 68)),
    downloads: `${1 + ((index * 3) % 9)}.${(index * 7) % 10}k`,
    likes: 80 + ((index * 19) % 260),
  }))

  const filteredPages = activeFilter === 'all' 
    ? coloringPages 
    : coloringPages.filter(page => page.category === activeFilter);

  return (
    <section id="gallery" className="py-20 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <Badge className="bg-green-100 text-green-600 mb-4">Free Library</Badge>
          <h2 className="text-3xl lg:text-5xl font-bold text-gray-900 mb-4">
            Browse 32,017+ Free Coloring Pages
          </h2>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Download and print thousands of free coloring pages. New designs added daily!
          </p>
        </div>
        
        {/* Search & Filters */}
        <div className="mb-8">
          <div className="flex flex-col lg:flex-row gap-4 mb-6">
            <div className="flex-1 relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
              <Input 
                placeholder="Search coloring pages..."
                className="pl-12 h-14 text-lg"
              />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="h-14 px-6">
                <Filter className="w-5 h-5 mr-2" />
                Filters
              </Button>
              <div className="flex border rounded-lg overflow-hidden">
                <button 
                  onClick={() => setViewMode('grid')}
                  className={`p-4 ${viewMode === 'grid' ? 'bg-indigo-100 text-indigo-700' : 'text-gray-500'}`}
                >
                  <Grid3X3 className="w-5 h-5" />
                </button>
                <button 
                  onClick={() => setViewMode('list')}
                  className={`p-4 ${viewMode === 'list' ? 'bg-indigo-100 text-indigo-700' : 'text-gray-500'}`}
                >
                  <List className="w-5 h-5" />
                </button>
              </div>
            </div>
          </div>
          
          {/* Category Filters */}
          <div className="flex flex-wrap gap-2 justify-center">
            {filters.map((filter) => (
              <button
                key={filter.id}
                onClick={() => setActiveFilter(filter.id)}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                  activeFilter === filter.id
                    ? 'bg-gradient-to-r from-indigo-600 to-emerald-500 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {filter.label}
                <span className="ml-1 opacity-70">({filter.count})</span>
              </button>
            ))}
          </div>
        </div>
        
        {/* Gallery Grid */}
        <div className={`grid ${viewMode === 'grid' ? 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4' : 'grid-cols-1'} gap-6`}>
          {filteredPages.map((page) => (
            <Dialog key={page.id}>
              <DialogTrigger asChild>
                <div className={`group cursor-pointer bg-white rounded-2xl overflow-hidden border border-gray-100 hover:shadow-xl transition-all ${viewMode === 'list' ? 'flex' : ''}`}>
                  <div className={`relative overflow-hidden ${viewMode === 'list' ? 'w-48 h-48' : 'aspect-square'}`}>
                    <img 
                      src={page.image} 
                      alt={page.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                    />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                    <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button size="sm" className="bg-white text-gray-900 hover:bg-gray-100">
                        <Eye className="w-4 h-4 mr-1" />
                        Preview
                      </Button>
                    </div>
                  </div>
                  <div className="p-4 flex-1">
                    <div className="flex items-center gap-2 text-xs text-gray-500 mb-2">
                      <Download className="w-3 h-3" />
                      <span>Free PDF/PNG</span>
                    </div>
                    <h3 className="font-semibold text-gray-900 mb-2">{page.title}</h3>
                    <div className="flex items-center justify-between text-sm text-gray-500">
                      <span>{page.pages} Pages</span>
                      <div className="flex items-center gap-3">
                        <span className="flex items-center gap-1">
                          <Download className="w-3 h-3" />
                          {page.downloads}
                        </span>
                        <span className="flex items-center gap-1">
                          <Heart className="w-3 h-3" />
                          {page.likes}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </DialogTrigger>
              <DialogContent className="max-w-3xl">
                <DialogHeader>
                  <DialogTitle>{page.title}</DialogTitle>
                </DialogHeader>
                <div className="grid md:grid-cols-2 gap-6">
                  <img src={page.image} alt={page.title} className="rounded-xl w-full" />
                  <div className="space-y-4">
                    <p className="text-gray-600">Download this beautiful coloring page for free!</p>
                    <div className="flex gap-2">
                      <Button className="flex-1 bg-gradient-to-r from-indigo-600 to-emerald-500 text-white">
                        <Download className="w-4 h-4 mr-2" />
                        Download PDF
                      </Button>
                      <Button variant="outline" className="flex-1">
                        <Download className="w-4 h-4 mr-2" />
                        Download PNG
                      </Button>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm">
                        <Heart className="w-4 h-4 mr-1" />
                        Favorite
                      </Button>
                      <Button variant="outline" size="sm">
                        <Share2 className="w-4 h-4 mr-1" />
                        Share
                      </Button>
                    </div>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          ))}
        </div>
        
        <div className="text-center mt-12">
          <Button variant="outline" className="px-8 py-6 text-lg">
            Load More Coloring Pages
            <ChevronDown className="w-5 h-5 ml-2" />
          </Button>
        </div>
      </div>
    </section>
  );
}

// ==================== ONLINE COLORING ====================
function OnlineColoringSection() {
  const tools = [
    { icon: PenTool, name: 'Brush' as const, shortcut: 'B' },
    { icon: Paintbrush, name: 'Fill' as const, shortcut: 'F' },
    { icon: Eraser, name: 'Eraser' as const, shortcut: 'E' },
    { icon: ScanLine, name: 'Line' as const, shortcut: 'L' },
  ];

  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD',
    '#FFD93D', '#6BCB77', '#4D96FF', '#FF6B9D', '#C9B1FF', '#95DAC1'
  ];

  const [activeTool, setActiveTool] = useState<(typeof tools)[number]['name']>('Brush');
  const [activeColor, setActiveColor] = useState(colors[0]);
  const [brushSize, setBrushSize] = useState(10);
  const [zoom, setZoom] = useState(1)
  const [status, setStatus] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [baseImageUrl, setBaseImageUrl] = useState(() => {
    try {
      const saved = localStorage.getItem('ONLINE_COLORING_STATE');
      if (saved) {
        const parsed = JSON.parse(saved) as { baseImageUrl?: unknown };
        if (typeof parsed.baseImageUrl === 'string' && !parsed.baseImageUrl.startsWith('blob:')) {
          return parsed.baseImageUrl;
        }
      }
      const selected = localStorage.getItem('ONLINE_COLORING_IMAGE_URL');
      if (typeof selected === 'string' && selected && !selected.startsWith('blob:')) return selected;
    } catch {
      return '/butterfly.jpg';
    }
    return '/butterfly.jpg';
  });

  useEffect(() => {
    const handler = (event: Event) => {
      const e = event as CustomEvent<{ url?: unknown }>
      const url = e.detail?.url
      if (typeof url !== 'string' || !url) return
      setBaseImageUrl((prev) => {
        if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
        return url
      })
      try {
        if (!url.startsWith('blob:')) localStorage.setItem('ONLINE_COLORING_IMAGE_URL', url)
      } catch {
        return
      }
    }
    window.addEventListener('online-coloring:set-image', handler)
    return () => {
      window.removeEventListener('online-coloring:set-image', handler)
    }
  }, []);

  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const beforeActionRef = useRef<ImageData | null>(null);
  const undoStackRef = useRef<ImageData[]>([]);
  const redoStackRef = useRef<ImageData[]>([]);
  const isPointerDownRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const lineStartRef = useRef<{ x: number; y: number } | null>(null);

  const syncHistoryState = () => {
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(redoStackRef.current.length > 0);
  };

  const parseHex = (hex: string) => {
    const raw = hex.replace('#', '').trim();
    const value = raw.length === 3
      ? raw.split('').map((c) => c + c).join('')
      : raw;
    const r = Number.parseInt(value.slice(0, 2), 16);
    const g = Number.parseInt(value.slice(2, 4), 16);
    const b = Number.parseInt(value.slice(4, 6), 16);
    return { r, g, b, a: 255 };
  };

  const getPointOnCanvas = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.max(0, Math.min(canvas.width - 1, (e.clientX - rect.left) * scaleX));
    const y = Math.max(0, Math.min(canvas.height - 1, (e.clientY - rect.top) * scaleY));
    return { x, y };
  };

  const getDrawCtx = () => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return null;
    return canvas.getContext('2d');
  };

  const saveStateToStorage = () => {
    try {
      const drawCanvas = drawCanvasRef.current;
      if (!drawCanvas) return;
      const overlay = drawCanvas.toDataURL('image/png');
      localStorage.setItem(
        'ONLINE_COLORING_STATE',
        JSON.stringify({ baseImageUrl, overlay })
      );
      setStatus('Saved');
      window.setTimeout(() => setStatus(null), 1500);
    } catch {
      setStatus('Save failed');
      window.setTimeout(() => setStatus(null), 2000);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const baseCanvas = baseCanvasRef.current;
    const drawCanvas = drawCanvasRef.current;
    if (!baseCanvas || !drawCanvas) return;

    const baseCtx = baseCanvas.getContext('2d');
    const drawCtx = drawCanvas.getContext('2d');
    if (!baseCtx || !drawCtx) return;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = baseImageUrl;

    img.onload = async () => {
      if (cancelled) return;
      const maxWidth = 1024;
      const scale = img.naturalWidth > maxWidth ? maxWidth / img.naturalWidth : 1;
      const width = Math.max(1, Math.round(img.naturalWidth * scale));
      const height = Math.max(1, Math.round(img.naturalHeight * scale));

      baseCanvas.width = width;
      baseCanvas.height = height;
      drawCanvas.width = width;
      drawCanvas.height = height;

      baseCtx.clearRect(0, 0, width, height);
      baseCtx.fillStyle = '#ffffff';
      baseCtx.fillRect(0, 0, width, height);
      baseCtx.drawImage(img, 0, 0, width, height);

      drawCtx.clearRect(0, 0, width, height);
      undoStackRef.current = [];
      redoStackRef.current = [];
      beforeActionRef.current = null;
      setCanUndo(false);
      setCanRedo(false);
      try {
        const saved = localStorage.getItem('ONLINE_COLORING_STATE');
        if (saved) {
          const parsed = JSON.parse(saved) as { overlay?: unknown };
          if (typeof parsed.overlay === 'string' && parsed.overlay) {
            const overlayImg = new Image();
            overlayImg.crossOrigin = 'anonymous';
            overlayImg.src = parsed.overlay;
            await new Promise<void>((resolve, reject) => {
              overlayImg.onload = () => resolve();
              overlayImg.onerror = () => reject(new Error('Overlay load failed'));
            });
            drawCtx.drawImage(overlayImg, 0, 0, width, height);
          }
        }
      } catch {
        return;
      }
      setStatus(null);
    };

    img.onerror = () => {
      if (cancelled) return;
      setStatus('Image load failed');
      window.setTimeout(() => setStatus(null), 2000);
    };

    return () => {
      cancelled = true;
    };
  }, [baseImageUrl]);

  const pushUndoBefore = () => {
    const ctx = getDrawCtx();
    const canvas = drawCanvasRef.current;
    if (!ctx || !canvas) return;
    beforeActionRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
  };

  const commitUndo = () => {
    const before = beforeActionRef.current;
    if (!before) return;
    undoStackRef.current.push(before);
    redoStackRef.current = [];
    beforeActionRef.current = null;
    syncHistoryState();
  };

  const undo = () => {
    const ctx = getDrawCtx();
    const canvas = drawCanvasRef.current;
    if (!ctx || !canvas) return;
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    const current = ctx.getImageData(0, 0, canvas.width, canvas.height);
    redoStackRef.current.push(current);
    ctx.putImageData(previous, 0, 0);
    syncHistoryState();
  };

  const redo = () => {
    const ctx = getDrawCtx();
    const canvas = drawCanvasRef.current;
    if (!ctx || !canvas) return;
    const next = redoStackRef.current.pop();
    if (!next) return;
    const current = ctx.getImageData(0, 0, canvas.width, canvas.height);
    undoStackRef.current.push(current);
    ctx.putImageData(next, 0, 0);
    syncHistoryState();
  };

  const download = () => {
    const baseCanvas = baseCanvasRef.current;
    const drawCanvas = drawCanvasRef.current;
    if (!baseCanvas || !drawCanvas) return;

    try {
      const out = document.createElement('canvas');
      out.width = baseCanvas.width;
      out.height = baseCanvas.height;
      const outCtx = out.getContext('2d');
      if (!outCtx) return;
      outCtx.drawImage(baseCanvas, 0, 0);
      outCtx.drawImage(drawCanvas, 0, 0);
      const url = out.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = 'coloring.png';
      a.click();
    } catch {
      setStatus('Download failed');
      window.setTimeout(() => setStatus(null), 2000);
    }
  };

  const fillAt = (x: number, y: number) => {
    const baseCanvas = baseCanvasRef.current;
    const drawCanvas = drawCanvasRef.current;
    const drawCtx = getDrawCtx();
    if (!baseCanvas || !drawCanvas || !drawCtx) return;

    const w = drawCanvas.width;
    const h = drawCanvas.height;

    const composite = document.createElement('canvas');
    composite.width = w;
    composite.height = h;
    const compositeCtx = composite.getContext('2d');
    if (!compositeCtx) return;
    compositeCtx.drawImage(baseCanvas, 0, 0);
    compositeCtx.drawImage(drawCanvas, 0, 0);

    const compositeData = compositeCtx.getImageData(0, 0, w, h);
    const drawData = drawCtx.getImageData(0, 0, w, h);
    const data = compositeData.data;
    const out = drawData.data;

    const startX = Math.floor(x);
    const startY = Math.floor(y);
    const startIndex = (startY * w + startX) * 4;

    const target = {
      r: data[startIndex],
      g: data[startIndex + 1],
      b: data[startIndex + 2],
      a: data[startIndex + 3],
    };
    const fill = parseHex(activeColor);

    const dist = (r: number, g: number, b: number, a: number) =>
      Math.abs(r - target.r) + Math.abs(g - target.g) + Math.abs(b - target.b) + Math.abs(a - target.a);
    const isBarrier = (r: number, g: number, b: number, a: number) =>
      a > 80 && r < 40 && g < 40 && b < 40;

    if (dist(fill.r, fill.g, fill.b, fill.a) < 10) return;

    const tolerance = 80;
    const visited = new Uint8Array(w * h);
    const stack: Array<[number, number]> = [[startX, startY]];

    while (stack.length) {
      const item = stack.pop();
      if (!item) break;
      const [cx, cy] = item;
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
      const pos = cy * w + cx;
      if (visited[pos]) continue;
      visited[pos] = 1;

      const idx = pos * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const a = data[idx + 3];

      if (isBarrier(r, g, b, a)) continue;
      if (dist(r, g, b, a) > tolerance) continue;

      out[idx] = fill.r;
      out[idx + 1] = fill.g;
      out[idx + 2] = fill.b;
      out[idx + 3] = 255;

      stack.push([cx + 1, cy]);
      stack.push([cx - 1, cy]);
      stack.push([cx, cy + 1]);
      stack.push([cx, cy - 1]);
    }

    drawCtx.putImageData(drawData, 0, 0);
  };

  const beginStroke = (point: { x: number; y: number }) => {
    const ctx = getDrawCtx();
    if (!ctx) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = brushSize;
    if (activeTool === 'Eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = activeColor;
    }
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
  };

  const strokeTo = (point: { x: number; y: number }) => {
    const ctx = getDrawCtx();
    if (!ctx) return;
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
  };

  const drawLinePreview = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const ctx = getDrawCtx();
    const canvas = drawCanvasRef.current;
    if (!ctx || !canvas) return;
    const before = beforeActionRef.current;
    if (!before) return;
    ctx.putImageData(before, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = brushSize;
    ctx.strokeStyle = activeColor;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };

  return (
    <section id="online-coloring" className="py-20 bg-gray-900 text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <Badge className="bg-indigo-600 text-white mb-4">Try It Now</Badge>
          <h2 className="text-3xl lg:text-5xl font-bold mb-4">Color Online - No Download Needed</h2>
          <p className="text-lg text-gray-400 max-w-2xl mx-auto">
            Use our free online coloring tool to color pages directly in your browser. 
            Save your progress and share your creations!
          </p>
        </div>
        
        <div className="bg-gray-800 rounded-3xl p-4 lg:p-8">
          <div className="grid lg:grid-cols-4 gap-6">
            {/* Tools Panel */}
            <div className="lg:col-span-1 space-y-6">
              <div>
                <h4 className="text-sm font-medium text-gray-400 mb-3">Page</h4>
                <Input
                  type="file"
                  accept="image/*"
                  className="bg-gray-800 border-gray-700 text-white"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const url = URL.createObjectURL(file);
                    setBaseImageUrl((prev) => {
                      if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
                      return url;
                    });
                  }}
                />
              </div>

              <div>
                <h4 className="text-sm font-medium text-gray-400 mb-3">Tools</h4>
                <div className="grid grid-cols-2 gap-2">
                  {tools.map((tool, index) => (
                    <button 
                      key={index}
                      className={`p-3 rounded-xl flex flex-col items-center gap-1 transition-colors ${
                        tool.name === activeTool ? 'bg-indigo-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                      onClick={() => setActiveTool(tool.name)}
                    >
                      <tool.icon className="w-5 h-5" />
                      <span className="text-xs">{tool.name}</span>
                    </button>
                  ))}
                </div>
              </div>
              
              <div>
                <h4 className="text-sm font-medium text-gray-400 mb-3">Colors</h4>
                <div className="grid grid-cols-4 gap-2">
                  {colors.map((color, index) => (
                    <button 
                      key={index}
                      className={`w-10 h-10 rounded-lg border-2 transition-colors ${
                        color === activeColor ? 'border-white' : 'border-transparent hover:border-white/60'
                      }`}
                      style={{ backgroundColor: color }}
                      onClick={() => setActiveColor(color)}
                    />
                  ))}
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <input
                    type="color"
                    value={activeColor}
                    onChange={(e) => setActiveColor(e.target.value)}
                    className="h-10 w-12 rounded-lg bg-gray-700 border border-gray-600"
                  />
                  <div className="text-xs text-gray-400">Custom color</div>
                </div>
              </div>
              
              <div>
                <h4 className="text-sm font-medium text-gray-400 mb-3">Brush Size</h4>
                <input
                  type="range"
                  className="w-full"
                  min="1"
                  max="50"
                  value={brushSize}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                />
                <div className="text-xs text-gray-400 mt-1">{brushSize}px</div>
              </div>

              <div>
                <h4 className="text-sm font-medium text-gray-400 mb-3">Zoom</h4>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    className="border-gray-600 text-gray-300 hover:bg-gray-700"
                    onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))}
                  >
                    -
                  </Button>
                  <div className="text-sm text-gray-300 w-16 text-center">{Math.round(zoom * 100)}%</div>
                  <Button
                    variant="outline"
                    className="border-gray-600 text-gray-300 hover:bg-gray-700"
                    onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.1) * 10) / 10))}
                  >
                    +
                  </Button>
                </div>
                <input
                  type="range"
                  className="w-full mt-2"
                  min="0.5"
                  max="3"
                  step="0.1"
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                />
              </div>
            </div>
            
            {/* Canvas Area */}
            <div className="lg:col-span-3">
              <div className="bg-white rounded-2xl overflow-auto relative">
                <canvas ref={baseCanvasRef} style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }} className="w-full h-auto max-h-[600px] object-contain block" />
                <canvas
                  ref={drawCanvasRef}
                  style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}
                  className="absolute inset-0 w-full h-auto max-h-[600px] object-contain touch-none"
                  onPointerDown={(e) => {
                    const canvas = drawCanvasRef.current;
                    const ctx = getDrawCtx();
                    if (!canvas || !ctx) return;
                    const point = getPointOnCanvas(e);
                    if (!point) return;
                    canvas.setPointerCapture(e.pointerId);
                    pushUndoBefore();

                    if (activeTool === 'Fill') {
                      isPointerDownRef.current = true;
                      fillAt(point.x, point.y);
                      commitUndo();
                      isPointerDownRef.current = false;
                      return;
                    }

                    if (activeTool === 'Line') {
                      isPointerDownRef.current = true;
                      lineStartRef.current = point;
                      return;
                    }

                    isPointerDownRef.current = true;
                    lastPointRef.current = point;
                    beginStroke(point);
                  }}
                  onPointerMove={(e) => {
                    if (!isPointerDownRef.current) return;
                    const point = getPointOnCanvas(e);
                    if (!point) return;

                    if (activeTool === 'Line') {
                      const start = lineStartRef.current;
                      if (!start) return;
                      drawLinePreview(start, point);
                      return;
                    }

                    const last = lastPointRef.current;
                    if (!last) return;
                    strokeTo(point);
                    lastPointRef.current = point;
                  }}
                  onPointerUp={(e) => {
                    const canvas = drawCanvasRef.current;
                    if (!canvas) return;
                    if (!isPointerDownRef.current && activeTool !== 'Line') return;
                    const point = getPointOnCanvas(e);
                    canvas.releasePointerCapture(e.pointerId);

                    if (activeTool === 'Line') {
                      const start = lineStartRef.current;
                      if (start && point) {
                        drawLinePreview(start, point);
                        commitUndo();
                      } else {
                        beforeActionRef.current = null;
                      }
                      lineStartRef.current = null;
                      isPointerDownRef.current = false;
                      return;
                    }

                    const ctx = getDrawCtx();
                    if (ctx && activeTool === 'Eraser') ctx.globalCompositeOperation = 'source-over';
                    commitUndo();
                    isPointerDownRef.current = false;
                    lastPointRef.current = null;
                  }}
                  onPointerCancel={(e) => {
                    const canvas = drawCanvasRef.current;
                    if (!canvas) return;
                    canvas.releasePointerCapture(e.pointerId);
                    const ctx = getDrawCtx();
                    if (ctx) ctx.globalCompositeOperation = 'source-over';
                    beforeActionRef.current = null;
                    isPointerDownRef.current = false;
                    lastPointRef.current = null;
                    lineStartRef.current = null;
                  }}
                />
              </div>
              
              <div className="flex justify-between items-center mt-4">
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="border-gray-600 text-gray-300 hover:bg-gray-700"
                    onClick={undo}
                    disabled={!canUndo}
                  >
                    <Undo className="w-4 h-4 mr-2" />
                    Undo
                  </Button>
                  <Button
                    variant="outline"
                    className="border-gray-600 text-gray-300 hover:bg-gray-700"
                    onClick={redo}
                    disabled={!canRedo}
                  >
                    <Redo className="w-4 h-4 mr-2" />
                    Redo
                  </Button>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="border-gray-600 text-gray-300 hover:bg-gray-700"
                    onClick={saveStateToStorage}
                  >
                    <Bookmark className="w-4 h-4 mr-2" />
                    Save
                  </Button>
                  <Button className="bg-gradient-to-r from-indigo-600 to-emerald-500 text-white" onClick={download}>
                    <Download className="w-4 h-4 mr-2" />
                    Download
                  </Button>
                </div>
              </div>

              {status && (
                <div className="mt-3 text-sm text-gray-300">
                  {status}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ==================== TESTIMONIALS ====================
function TestimonialsSection() {
  const testimonials = [
    {
      name: 'Sarah Mitchell',
      role: 'Elementary School Teacher',
      image: '/testimonial-1.jpg',
      text: 'This tool has transformed my classroom! I can create custom coloring pages that match our lesson themes. The kids absolutely love them, and it saves me hours of prep time.',
      rating: 5
    },
    {
      name: 'Michael Chen',
      role: 'Amazon KDP Seller',
      image: '/testimonial-2.jpg',
      text: 'I\'ve published over 50 coloring books using this platform. The quality is exceptional, and the coloring book generator with consistent characters is a game-changer for my business.',
      rating: 5
    },
    {
      name: 'Emily Rodriguez',
      role: 'Etsy Shop Owner',
      text: 'The photo-to-coloring feature is incredible! My customers love ordering personalized coloring pages of their pets. Sales have increased by 300% since I started using this tool.',
      rating: 5
    }
  ];

  return (
    <section className="py-20 bg-gradient-to-br from-slate-50 via-indigo-50 to-emerald-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <Badge className="bg-indigo-100 text-indigo-700 mb-4">Testimonials</Badge>
          <h2 className="text-3xl lg:text-5xl font-bold text-gray-900 mb-4">Loved by 320,000+ Users</h2>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            See what our community is creating with AI-powered coloring pages
          </p>
        </div>
        
        <div className="grid md:grid-cols-3 gap-8">
          {testimonials.map((testimonial, index) => (
            <Card key={index} className="bg-white border-0 shadow-xl">
              <CardContent className="p-8">
                <div className="flex gap-1 mb-4">
                  {[...Array(testimonial.rating)].map((_, i) => (
                    <Star key={i} className="w-5 h-5 fill-yellow-400 text-yellow-400" />
                  ))}
                </div>
                <p className="text-gray-600 leading-relaxed mb-6">"{testimonial.text}"</p>
                <div className="flex items-center gap-4">
                  <img 
                    src={testimonial.image} 
                    alt={testimonial.name}
                    className="w-14 h-14 rounded-full object-cover"
                  />
                  <div>
                    <h4 className="font-semibold text-gray-900">{testimonial.name}</h4>
                    <p className="text-sm text-gray-500">{testimonial.role}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        
        {/* Stats Bar */}
        <div className="mt-16 bg-white rounded-2xl shadow-lg p-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
            {[
              { value: '4.9/5', label: 'Average Rating', icon: Star },
              { value: '2.4M+', label: 'Pages Created', icon: Palette },
              { value: '320K+', label: 'Happy Users', icon: Users },
              { value: '50K+', label: 'Books Published', icon: BookOpen },
            ].map((stat, index) => (
              <div key={index}>
                <div className="flex justify-center mb-2">
                  <stat.icon className="w-8 h-8 text-indigo-600" />
                </div>
                <div className="text-3xl font-bold text-gray-900">{stat.value}</div>
                <div className="text-gray-500">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ==================== PRICING ====================
function PricingSection() {
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');

  const plans = [
    {
      name: 'Starter',
      description: 'Perfect for personal use',
      monthlyPrice: 6.99,
      yearlyPrice: 4.99,
      features: [
        '10 coloring pages/month',
        '10-page coloring books',
        'Basic styles',
        'Email support',
        'Standard resolution'
      ],
      cta: 'Start Free Trial'
    },
    {
      name: 'Hobby',
      description: 'For creative enthusiasts',
      monthlyPrice: 13.99,
      yearlyPrice: 9.99,
      features: [
        '300 coloring pages/month',
        '50-page coloring books',
        'All styles included',
        'Priority support',
        'High resolution',
        'No watermark'
      ],
      cta: 'Start Free Trial'
    },
    {
      name: 'Professional',
      description: 'For sellers & businesses',
      monthlyPrice: 27.99,
      yearlyPrice: 19.99,
      popular: true,
      features: [
        '1,000 coloring pages/month',
        '200-page coloring books',
        'All styles + KDP Builder',
        '24/7 priority support',
        '4K resolution',
        'Commercial license',
        'Batch generation'
      ],
      cta: 'Start Free Trial'
    },
    {
      name: 'Business',
      description: 'For teams & agencies',
      monthlyPrice: 69.99,
      yearlyPrice: 49.99,
      features: [
        '5,000 coloring pages/month',
        'Unlimited coloring books',
        'All features included',
        'Dedicated account manager',
        '8K resolution',
        'API access',
        'White-label option'
      ],
      cta: 'Contact Sales'
    }
  ];

  return (
    <section className="py-20 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <Badge className="bg-indigo-100 text-indigo-700 mb-4">Pricing</Badge>
          <h2 className="text-3xl lg:text-5xl font-bold text-gray-900 mb-4">Choose Your Plan</h2>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Start free and scale as you grow. All plans include a 7-day free trial.
          </p>
        </div>
        
        {/* Billing Toggle */}
        <div className="flex justify-center mb-12">
          <div className="bg-gray-100 rounded-full p-1 flex">
            <button
              onClick={() => setBillingCycle('monthly')}
              className={`px-6 py-2 rounded-full text-sm font-medium transition-colors ${
                billingCycle === 'monthly' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setBillingCycle('yearly')}
              className={`px-6 py-2 rounded-full text-sm font-medium transition-colors flex items-center gap-2 ${
                billingCycle === 'yearly' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
              }`}
            >
              Yearly
              <Badge className="bg-green-500 text-white text-xs">Save 30%</Badge>
            </button>
          </div>
        </div>
        
        {/* Pricing Cards */}
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {plans.map((plan, index) => (
            <Card 
              key={index} 
              className={`relative ${plan.popular ? 'border-2 border-indigo-600 shadow-xl scale-105' : 'border border-gray-200'}`}
            >
              {plan.popular && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                  <Badge className="bg-gradient-to-r from-indigo-600 to-emerald-500 text-white px-4 py-1">
                    Most Popular
                  </Badge>
                </div>
              )}
              <CardHeader className="pb-4">
                <CardTitle className="text-xl">{plan.name}</CardTitle>
                <CardDescription>{plan.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="mb-6">
                  <span className="text-4xl font-bold">${billingCycle === 'monthly' ? plan.monthlyPrice : plan.yearlyPrice}</span>
                  <span className="text-gray-500">/month</span>
                  {billingCycle === 'yearly' && (
                    <p className="text-sm text-green-600 mt-1">Billed annually</p>
                  )}
                </div>
                
                <ul className="space-y-3 mb-6">
                  {plan.features.map((feature, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-gray-600">
                      <Check className="w-4 h-4 text-indigo-600 mt-0.5 flex-shrink-0" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                
                <Button 
                  className={`w-full ${
                    plan.popular 
                      ? 'bg-gradient-to-r from-indigo-600 to-emerald-500 hover:from-indigo-700 hover:to-emerald-600 text-white' 
                      : 'bg-gray-100 text-gray-900 hover:bg-gray-200'
                  }`}
                >
                  {plan.cta}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
        
        <p className="text-center text-gray-500 mt-8">
          All plans include a 7-day free trial. No credit card required.
        </p>
      </div>
    </section>
  );
}

// ==================== FAQ ====================
function FAQSection() {
  const faqs = [
    {
      category: 'getting-started',
      question: 'What is InkBloom?',
      answer: 'InkBloom is an AI-powered studio that turns photos and text prompts into clean, print-ready coloring pages. It includes generators for single pages, simple book concepts, and colorizing drawings for quick mockups.'
    },
    {
      category: 'getting-started',
      question: 'Is it free to use?',
      answer: 'Yes. You can start for free and generate coloring pages without a credit card. Availability and limits may change as we improve the service.'
    },
    {
      category: 'creating',
      question: 'Can I sell the coloring pages I create?',
      answer: 'In most cases, yes. Make sure your prompts and uploaded images do not infringe on third-party rights (e.g., copyrighted characters, logos, or trademarks). You are responsible for compliance.'
    },
    {
      category: 'creating',
      question: 'Can I upload my own photos?',
      answer: 'Yes. Upload JPG, PNG, or WEBP images (up to 10MB). For best line art, use clear photos with good lighting and a simple background.'
    },
    {
      category: 'creating',
      question: 'How does the AI coloring book generator work?',
      answer: 'You choose a theme and main character. InkBloom generates a cover and matching interior pages using consistent line-art prompts so the book feels cohesive.'
    },
    {
      category: 'downloading',
      question: 'What image formats are supported?',
      answer: 'For uploads: JPG, PNG, and WEBP. For downloads: PNG images that you can print or import into design tools.'
    },
    {
      category: 'downloading',
      question: 'How long does generation take?',
      answer: 'Most generations take around 10–30 seconds. Sometimes it can take longer depending on demand; if it fails or times out, just retry.'
    },
    {
      category: 'downloading',
      question: 'Can I use these for Amazon KDP?',
      answer: 'Yes, many creators use InkBloom outputs as a starting point for KDP interiors. Always review print settings, margins, and ensure the content is original and compliant with KDP policies.'
    },
    {
      category: 'account',
      question: 'Is there a limit on how many pages I can create?',
      answer: 'We limit concurrency and apply rate limits to keep the service stable for everyone. If you need higher throughput, contact us.'
    },
    {
      category: 'account',
      question: 'Do you offer refunds?',
      answer: 'If paid plans are enabled, refunds may be available depending on your plan and local law. Contact support and we’ll help you.'
    }
  ];

  return (
    <section className="py-20 bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <Badge className="bg-indigo-100 text-indigo-700 mb-4">FAQ</Badge>
          <h2 className="text-3xl lg:text-5xl font-bold text-gray-900 mb-4">Frequently Asked Questions</h2>
          <p className="text-lg text-gray-600">
            Everything you need to know about our AI coloring page generator
          </p>
        </div>
        
        <Tabs defaultValue="getting-started" className="w-full">
          <TabsList className="w-full justify-center mb-8 flex-wrap h-auto gap-2">
            <TabsTrigger value="getting-started">Getting Started</TabsTrigger>
            <TabsTrigger value="creating">Creating</TabsTrigger>
            <TabsTrigger value="downloading">Downloading</TabsTrigger>
            <TabsTrigger value="account">Account</TabsTrigger>
          </TabsList>
          
          {['getting-started', 'creating', 'downloading', 'account'].map((category) => (
            <TabsContent key={category} value={category}>
              <Accordion type="single" collapsible className="w-full">
                {faqs
                  .filter(faq => faq.category === category)
                  .map((faq, index) => (
                    <AccordionItem key={index} value={`item-${index}`} className="bg-white rounded-lg mb-2 border-0 shadow-sm">
                      <AccordionTrigger className="px-6 py-4 text-left font-medium hover:no-underline">
                        {faq.question}
                      </AccordionTrigger>
                      <AccordionContent className="px-6 pb-4 text-gray-600">
                        {faq.answer}
                      </AccordionContent>
                    </AccordionItem>
                  ))}
              </Accordion>
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </section>
  );
}

// ==================== CTA ====================
function CTASection() {
  const navigate = useNavigate()
  return (
    <section className="py-20 bg-gradient-to-r from-indigo-700 via-fuchsia-600 to-emerald-600">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <h2 className="text-3xl lg:text-5xl font-bold text-white mb-6">
          Ready to Create Your First Coloring Page?
        </h2>
        <p className="text-xl text-white/80 mb-8 max-w-2xl mx-auto">
          Join 320,000+ creators and start making beautiful coloring pages in seconds. 
          No credit card required.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Button
            className="bg-white text-indigo-700 hover:bg-gray-100 px-8 py-6 text-lg rounded-xl"
            onClick={() => navigate('/generators/text-to-coloring')}
          >
            <Sparkles className="w-5 h-5 mr-2" />
            Start Creating Free
          </Button>
          <Button
            variant="outline"
            className="border-2 border-white text-white hover:bg-white/10 px-8 py-6 text-lg rounded-xl"
            onClick={() => navigate('/?demo=1')}
          >
            <Play className="w-5 h-5 mr-2" />
            Watch Demo
          </Button>
        </div>
        <div className="flex flex-wrap gap-6 justify-center mt-8 text-white/80">
          <span className="flex items-center gap-2">
            <Check className="w-5 h-5" />
            Free 7-day trial
          </span>
          <span className="flex items-center gap-2">
            <Check className="w-5 h-5" />
            No credit card
          </span>
          <span className="flex items-center gap-2">
            <Check className="w-5 h-5" />
            Cancel anytime
          </span>
        </div>
      </div>
    </section>
  );
}

// ==================== FOOTER ====================
function Footer() {
  const footerLinks: Record<string, Array<{ label: string; to: string }>> = {
    'AI Generators': [
      { label: 'Photo to Coloring Page', to: '/generators/photo-to-coloring' },
      { label: 'Text to Coloring Page', to: '/generators/text-to-coloring' },
      { label: 'Coloring Book Generator', to: '/generators/coloring-book' },
      { label: 'AI Image Editor', to: '/generators/image-editor' },
      { label: 'Colorize Drawing', to: '/generators/colorize' },
    ],
    'Free Coloring Pages': [
      { label: 'Animals', to: '/coloring-pages/animals' },
      { label: 'Cartoons', to: '/coloring-pages/cartoons' },
      { label: 'Holidays', to: '/coloring-pages/holidays' },
      { label: 'Fantasy', to: '/coloring-pages/fantasy' },
      { label: 'Nature', to: '/coloring-pages/nature' },
      { label: 'View All', to: '/coloring-pages/all' },
    ],
    Resources: [
      { label: 'Blog', to: '/blog' },
      { label: 'Tutorials', to: '/tutorials' },
      { label: 'Help Center', to: '/help' },
      { label: 'Community', to: '/community' },
      { label: 'API Docs', to: '/api-docs' },
    ],
    Company: [
      { label: 'About Us', to: '/about' },
      { label: 'Careers', to: '/careers' },
      { label: 'Contact', to: '/contact' },
      { label: 'Press Kit', to: '/press' },
      { label: 'Partners', to: '/partners' },
    ],
  };

  return (
    <footer className="bg-gray-900 text-gray-300">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="grid md:grid-cols-2 lg:grid-cols-6 gap-12">
          {/* Brand */}
          <div className="lg:col-span-2">
            <Link to="/" className="flex items-center gap-2 mb-6">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-600 via-fuchsia-500 to-emerald-400 flex items-center justify-center">
                <img src={inkbloomLogo} alt="InkBloom" className="w-6 h-6" />
              </div>
              <span className="text-xl font-bold text-white">
                <span className="text-indigo-300">Ink</span>
                <span className="text-emerald-300">Bloom</span>
              </span>
            </Link>
            <p className="text-gray-400 mb-6 leading-relaxed">
              AI-powered coloring page generator for creators, educators, and entrepreneurs. 
              Create unlimited designs in seconds.
            </p>
            
            {/* Newsletter */}
            <div className="mb-6">
              <h4 className="text-white font-medium mb-3">Subscribe to our newsletter</h4>
              <div className="flex gap-2">
                <Input 
                  placeholder="Enter your email"
                  className="bg-gray-800 border-gray-700 text-white"
                />
                <Button className="bg-gradient-to-r from-indigo-600 to-emerald-500 text-white">
                  <Mail className="w-4 h-4" />
                </Button>
              </div>
            </div>
            
            {/* Social Links */}
            <div className="flex gap-3">
              {[
                { Icon: Facebook, href: 'https://facebook.com' },
                { Icon: Twitter, href: 'https://x.com' },
                { Icon: Instagram, href: 'https://instagram.com' },
                { Icon: Youtube, href: 'https://youtube.com' },
                { Icon: Linkedin, href: 'https://linkedin.com' },
              ].map(({ Icon, href }) => (
                <a 
                  key={href}
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="w-10 h-10 bg-gray-800 rounded-lg flex items-center justify-center hover:bg-gray-700 transition-colors"
                >
                  <Icon className="w-5 h-5" />
                </a>
              ))}
            </div>
          </div>
          
          {/* Links */}
          {Object.entries(footerLinks).map(([title, links]) => (
            <div key={title}>
              <h4 className="text-white font-semibold mb-4">{title}</h4>
              <ul className="space-y-3">
                {links.map((link, index) => (
                  <li key={index}>
                    <Link to={link.to} className="text-gray-400 hover:text-white transition-colors">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        
        <Separator className="my-12 bg-gray-800" />
        
        <div className="flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-gray-500 text-sm">
            © 2026 InkBloom. All rights reserved.
          </p>
          <div className="flex gap-6 text-sm">
            <Link to="/privacy" className="text-gray-500 hover:text-white transition-colors">Privacy Policy</Link>
            <Link to="/terms" className="text-gray-500 hover:text-white transition-colors">Terms of Service</Link>
            <Link to="/cookies" className="text-gray-500 hover:text-white transition-colors">Cookie Policy</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}

function useSeo(title: string, description: string) {
  useEffect(() => {
    document.title = title
    const ensureMeta = (name: string, content: string) => {
      let tag = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null
      if (!tag) {
        tag = document.createElement('meta')
        tag.setAttribute('name', name)
        document.head.appendChild(tag)
      }
      tag.setAttribute('content', content)
    }
    const ensureOg = (property: string, content: string) => {
      let tag = document.querySelector(`meta[property="${property}"]`) as HTMLMetaElement | null
      if (!tag) {
        tag = document.createElement('meta')
        tag.setAttribute('property', property)
        document.head.appendChild(tag)
      }
      tag.setAttribute('content', content)
    }
    ensureMeta('description', description)
    ensureOg('og:title', title)
    ensureOg('og:description', description)
    ensureOg('og:type', 'website')
    ensureOg('og:url', window.location.href)

    const id = 'ld-product'
    let script = document.getElementById(id) as HTMLScriptElement | null
    if (!script) {
      script = document.createElement('script')
      script.id = id
      script.type = 'application/ld+json'
      document.head.appendChild(script)
    }
    const origin = window.location.origin
    script.text = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'InkBloom',
      applicationCategory: 'DesignApplication',
      operatingSystem: 'Web',
      description,
      url: `${origin}/`,
    })
  }, [title, description])
}

function PageShell({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  useSeo(title, description)
  return (
    <main className="min-h-[70vh] bg-white">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-6">{title}</h1>
        <div className="prose prose-gray max-w-none">{children}</div>
      </div>
    </main>
  )
}

function PrivacyPage() {
  return (
    <PageShell
      title="Privacy Policy"
      description="InkBloom Privacy Policy. Learn how we collect, use, and protect your data."
    >
      <p>
        InkBloom (“we”, “us”) provides an AI coloring page studio. This Privacy Policy explains what data we collect, how we use it, and your choices.
      </p>
      <h2>Data We Collect</h2>
      <ul>
        <li>Account data: email, name, and profile photo when you sign in with Google.</li>
        <li>Usage data: pages visited, device information, and basic analytics.</li>
        <li>Content: prompts you enter and images you upload to generate results.</li>
      </ul>
      <h2>How We Use Data</h2>
      <ul>
        <li>Provide and improve the service.</li>
        <li>Operate security, prevent abuse, and debug issues.</li>
        <li>Measure performance and feature usage.</li>
      </ul>
      <h2>Legal Bases (GDPR)</h2>
      <ul>
        <li>Contract: to provide the service you request.</li>
        <li>Legitimate interests: security and product improvement.</li>
        <li>Consent: where required for analytics/cookies.</li>
      </ul>
      <h2>Sharing</h2>
      <p>
        We may share data with service providers (hosting, analytics, authentication) only to operate InkBloom. We do not sell your personal data.
      </p>
      <h2>Retention</h2>
      <p>We retain data only as long as necessary for the purposes described, unless a longer period is required by law.</p>
      <h2>Your Rights</h2>
      <p>
        Depending on your location, you may have rights to access, correct, delete, or export your data, and object or restrict processing.
      </p>
      <h2>Contact</h2>
      <p>For privacy requests, contact us via the Contact page.</p>
    </PageShell>
  )
}

function CookiesPage() {
  return (
    <PageShell title="Cookie Policy" description="InkBloom Cookie Policy. Learn what cookies are used and how to control them.">
      <p>
        This Cookie Policy explains how InkBloom uses cookies and similar technologies to provide and improve the service.
      </p>
      <h2>What Are Cookies?</h2>
      <p>
        Cookies are small text files stored on your device. They help websites remember preferences and understand how users interact with pages.
      </p>
      <h2>Cookies We Use</h2>
      <ul>
        <li>Essential cookies: required for basic site functionality and security.</li>
        <li>Preferences: remember settings like UI preferences.</li>
        <li>Analytics: help us understand usage and improve performance (where enabled).</li>
      </ul>
      <h2>Managing Cookies</h2>
      <p>
        You can control cookies through your browser settings. You can delete existing cookies and block future cookies, but some features may stop working.
      </p>
      <h2>Updates</h2>
      <p>We may update this Cookie Policy as the product evolves.</p>
    </PageShell>
  )
}

function TermsPage() {
  return (
    <PageShell
      title="Terms of Service"
      description="InkBloom Terms of Service. Please read these terms before using the service."
    >
      <p>
        By using InkBloom, you agree to these Terms. If you do not agree, do not use the service.
      </p>
      <h2>Use of the Service</h2>
      <ul>
        <li>You must follow applicable laws and not misuse InkBloom.</li>
        <li>You are responsible for the content you upload or generate.</li>
        <li>You may not attempt to disrupt or reverse engineer the service.</li>
      </ul>
      <h2>Content and Licensing</h2>
      <p>
        You retain rights to your uploaded content. Generated outputs may be used commercially by you unless prohibited by law or third-party rights.
      </p>
      <h2>Payments and Refunds</h2>
      <p>Paid plans, if offered, are billed as described at checkout. Refunds may be offered at our discretion unless required by law.</p>
      <h2>Disclaimer</h2>
      <p>
        The service is provided “as is” without warranties. We do not guarantee uninterrupted availability or perfect outputs.
      </p>
      <h2>Limitation of Liability</h2>
      <p>To the maximum extent permitted by law, InkBloom is not liable for indirect or consequential damages.</p>
      <h2>Changes</h2>
      <p>We may update these Terms from time to time. Continued use means acceptance of the updated Terms.</p>
    </PageShell>
  )
}

function AboutPage() {
  return (
    <PageShell
      title="About InkBloom"
      description="InkBloom is an AI coloring page company founded in 2025 with a mission to democratize art."
    >
      <p>
        InkBloom is an AI-powered coloring page studio founded in 2025. Our mission is to democratize art by helping anyone turn ideas, text prompts, and photos into clean, print-ready coloring pages.
      </p>
      <h2>Who It’s For</h2>
      <ul>
        <li>Creators selling printables on Etsy</li>
        <li>Authors publishing on Amazon KDP</li>
        <li>Teachers and parents creating fun activities</li>
        <li>Anyone who loves coloring</li>
      </ul>
      <h2>What We Believe</h2>
      <ul>
        <li>Creativity should be accessible.</li>
        <li>Tools should be simple and fast.</li>
        <li>Outputs should be high quality and printable.</li>
      </ul>
    </PageShell>
  )
}

function CareersPage() {
  return (
    <PageShell title="Careers" description="Join InkBloom. We’re hiring builders who love creativity and AI.">
      <p>We’re hiring.</p>
      <h2>Open Roles</h2>
      <ul>
        <li>Frontend Engineer (React)</li>
        <li>Product Designer</li>
        <li>Growth Marketer</li>
      </ul>
      <p>Send your portfolio and a short note via the Contact page.</p>
    </PageShell>
  )
}

function BlogPage() {
  return (
    <PageShell title="Blog" description="InkBloom blog: coloring pages, Amazon KDP tips, and creative workflows.">
      <div className="grid gap-6">
        {[
          {
            title: 'How to Make High-Quality Coloring Pages for Amazon KDP',
            excerpt: 'A practical checklist: clean line art, margins, interior sizing, and consistency.',
            date: '2026-03-01',
          },
          {
            title: '10 Coloring Page Niches That Sell (And How to Validate Demand)',
            excerpt: 'Find niches, test keywords, and build a product line you can expand.',
            date: '2026-02-14',
          },
          {
            title: 'From Photo to Coloring Page: Best Practices for Clean Outlines',
            excerpt: 'How to choose photos and prompts to get crisp, printable results.',
            date: '2026-01-28',
          },
          {
            title: 'Bundles, Upsells, and Printables: Monetizing Your Coloring Page Library',
            excerpt: 'Pricing and packaging ideas that work on Etsy and your own store.',
            date: '2025-12-10',
          },
        ].map((post) => (
          <div key={post.title} className="rounded-2xl border border-gray-200 p-6 bg-white">
            <div className="text-xs text-gray-500">{post.date}</div>
            <div className="text-xl font-semibold text-gray-900 mt-2">{post.title}</div>
            <div className="text-gray-600 mt-2">{post.excerpt}</div>
          </div>
        ))}
      </div>
    </PageShell>
  )
}

function ContactPage() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <PageShell title="Contact" description="Contact InkBloom. Send us a message and we’ll get back to you.">
      <div className="max-w-xl">
        <div className="grid gap-3 not-prose">
          <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <textarea
            className="w-full rounded-md border border-gray-200 px-3 py-2 min-h-[140px]"
            placeholder="Message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              className="bg-gradient-to-r from-indigo-600 to-emerald-500 text-white"
              onClick={() => {
                setError(null)
                if (!name.trim() || !email.trim() || !message.trim()) {
                  setError('Please fill out all fields.')
                  return
                }
                setSent(true)
              }}
            >
              Send Message
            </Button>
            <Button variant="outline" onClick={() => window.location.assign('mailto:support@inkbloom.app')}>
              Email Support
            </Button>
          </div>
          {error && <div className="text-sm text-red-600">{error}</div>}
          {sent && <div className="text-sm text-emerald-700">Message sent. We’ll reply soon.</div>}
        </div>
      </div>
    </PageShell>
  )
}

function TutorialsPage() {
  return (
    <PageShell title="Tutorials" description="InkBloom tutorials: quick guides for creating and selling coloring pages.">
      <p>Quick guides to help you get the best results from InkBloom.</p>
      <ul>
        <li>How to write prompts for crisp line art</li>
        <li>How to prepare pages for printing</li>
        <li>How to bundle pages for Etsy and KDP</li>
      </ul>
    </PageShell>
  )
}

function HelpPage() {
  return (
    <PageShell title="Help Center" description="InkBloom help center: troubleshooting, FAQs, and best practices.">
      <p>If something isn’t working, try these steps:</p>
      <ul>
        <li>Wait 10–30 seconds after generating (some images take longer).</li>
        <li>Retry if generation fails.</li>
        <li>Use JPG/PNG/WEBP uploads under 10MB.</li>
      </ul>
      <p>If you still need help, use the Contact page.</p>
    </PageShell>
  )
}

function CommunityPage() {
  return (
    <PageShell title="Community" description="Join the InkBloom community and share coloring pages and tips.">
      <p>Community features are coming soon.</p>
      <p>For now, follow InkBloom on social media and share your creations.</p>
    </PageShell>
  )
}

function ApiDocsPage() {
  return (
    <PageShell title="API Docs" description="InkBloom API docs and integration notes.">
      <p>InkBloom uses the Pollinations image endpoints directly from the browser.</p>
      <p>If you’re building integrations, start with the official Pollinations documentation.</p>
    </PageShell>
  )
}

function PressPage() {
  return (
    <PageShell title="Press Kit" description="InkBloom press kit: product overview, screenshots, and brand assets.">
      <p>Press kit content is coming soon.</p>
    </PageShell>
  )
}

function PartnersPage() {
  return (
    <PageShell title="Partners" description="Partner with InkBloom.">
      <p>Interested in partnering with InkBloom? Reach out via the Contact page.</p>
    </PageShell>
  )
}

function GeneratorsIndexPage() {
  return (
    <PageShell title="AI Generators" description="Choose an InkBloom generator: photo, text, book, editor, or colorize.">
      <div className="grid sm:grid-cols-2 gap-4 not-prose">
        {[
          { title: 'Photo to Coloring Page', to: '/generators/photo-to-coloring', desc: 'Upload a photo and get clean outlines.' },
          { title: 'Text to Coloring Page', to: '/generators/text-to-coloring', desc: 'Type a prompt and generate line art.' },
          { title: 'Coloring Book Generator', to: '/generators/coloring-book', desc: 'Generate a themed cover and pages.' },
          { title: 'AI Image Editor', to: '/generators/image-editor', desc: 'Edit images: enhance, style, background.' },
          { title: 'Colorize Drawing', to: '/generators/colorize', desc: 'Colorize black & white images.' },
        ].map((item) => (
          <Link key={item.to} to={item.to} className="rounded-2xl border border-gray-200 p-6 hover:shadow-lg transition-shadow">
            <div className="text-lg font-semibold text-gray-900">{item.title}</div>
            <div className="text-sm text-gray-600 mt-2">{item.desc}</div>
            <div className="text-sm text-indigo-600 mt-4">Open →</div>
          </Link>
        ))}
      </div>
    </PageShell>
  )
}

function HomePage() {
  useSeo('InkBloom — AI Coloring Page Studio', 'Turn photos and text into printable coloring pages with InkBloom.')
  return (
    <main>
      <HeroSection />
      <HowItWorksSection />
      <FeaturesGridSection />
      <PhotoToColoringSection />
      <TextToColoringSection />
      <ColoringBookSection />
      <ImageEditorSection />
      <ColorizeSection />
      <GallerySection />
      <OnlineColoringSection />
      <TestimonialsSection />
      <PricingSection />
      <FAQSection />
      <CTASection />
    </main>
  )
}

function GeneratorPhotoPage() {
  useSeo('Photo to Coloring Page — InkBloom', 'Upload a photo and generate a clean black & white coloring page.')
  return (
    <div className="pt-24">
      <PhotoToColoringSection />
    </div>
  )
}

function GeneratorTextPage() {
  useSeo('Text to Coloring Page — InkBloom', 'Describe what you want and generate a coloring page from text.')
  return (
    <div className="pt-24">
      <TextToColoringSection />
    </div>
  )
}

function GeneratorBookPage() {
  useSeo('Coloring Book Generator — InkBloom', 'Generate a themed cover and pages for a coloring book.')
  return (
    <div className="pt-24">
      <ColoringBookSection />
    </div>
  )
}

function GeneratorEditorPage() {
  useSeo('AI Image Editor — InkBloom', 'Edit images with AI: colorize, enhance, style transfer, and background removal.')
  return (
    <div className="pt-24">
      <ImageEditorSection />
    </div>
  )
}

function GeneratorColorizePage() {
  useSeo('Online Coloring — InkBloom', 'Upload a coloring page and color it online in your browser.')
  return (
    <div className="pt-24">
      <ColorizeSection />
    </div>
  )
}

function OnlineColoringPage() {
  useSeo('Online Coloring Tool — InkBloom', 'Color online with brushes, fill, undo/redo, and download.')
  return (
    <div className="pt-24">
      <OnlineColoringSection />
    </div>
  )
}

function ColoringPagesCategoryPage() {
  const params = useParams()
  const raw = typeof params.category === 'string' ? params.category : 'all'
  const allowed = new Set(['all', 'animals', 'cartoons', 'holidays', 'fantasy', 'nature'])
  const category = (allowed.has(raw) ? raw : 'all') as 'all' | LibraryCategory

  const config = COLORING_PAGES_PAGE_CONFIG[category]
  useSeo(`${config.title} — InkBloom`, config.subtitle)

  const [activeFilter, setActiveFilter] = useState(config.filters[0]?.id ?? 'all')
  const [visibleCount, setVisibleCount] = useState(12)
  const [likedIds, setLikedIds] = useState<Record<string, boolean>>(() => {
    try {
      const rawValue = localStorage.getItem('INKBLOOM_LIKES')
      if (!rawValue) return {}
      const parsed = JSON.parse(rawValue) as unknown
      if (!parsed || typeof parsed !== 'object') return {}
      return parsed as Record<string, boolean>
    } catch {
      return {}
    }
  })

  useEffect(() => {
    const nextFilter = COLORING_PAGES_PAGE_CONFIG[category].filters[0]?.id ?? 'all'
    const id = window.setTimeout(() => {
      setActiveFilter(nextFilter)
      setVisibleCount(12)
    }, 0)
    return () => window.clearTimeout(id)
  }, [category])

  useEffect(() => {
    try {
      localStorage.setItem('INKBLOOM_LIKES', JSON.stringify(likedIds))
    } catch {
      return
    }
  }, [likedIds])

  const downloadPng = async (url: string, filename: string) => {
    try {
      const res = await fetch(url)
      const blob = await res.blob()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = filename
      a.click()
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000)
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }

  const allItems = category === 'all' ? LIBRARY_ITEMS : LIBRARY_ITEMS.filter((x) => x.category === category)
  const filtered =
    activeFilter === 'all'
      ? allItems
      : allItems.filter((x) => x.tags.map((t) => t.toLowerCase()).includes(activeFilter.toLowerCase()))

  const shown = filtered.slice(0, visibleCount)

  return (
    <div className="pt-24">
      <section className="py-16 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-10">
            <Badge className="bg-green-100 text-green-600 mb-4">Free Library</Badge>
            <h1 className="text-3xl lg:text-5xl font-bold text-gray-900">{config.title}</h1>
            <p className="text-lg text-gray-600 mt-3 max-w-2xl mx-auto">{config.subtitle}</p>
          </div>

          <div className="flex flex-wrap gap-2 justify-center mb-8">
            {config.filters.map((f) => (
              <button
                key={f.id}
                onClick={() => {
                  setActiveFilter(f.id)
                  setVisibleCount(12)
                }}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                  activeFilter === f.id
                    ? 'bg-gradient-to-r from-indigo-600 to-emerald-500 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {shown.map((item) => (
              <div key={item.id} className="bg-white rounded-2xl border border-gray-100 overflow-hidden shadow-sm">
                <div className="relative aspect-square bg-gray-50">
                  <img
                    src={item.image}
                    alt={item.title}
                    crossOrigin="anonymous"
                    className="w-full h-full object-contain"
                  />
                  <div className="absolute top-3 left-3">
                    <Badge className="bg-green-100 text-green-700">Free</Badge>
                  </div>
                  <button
                    className="absolute top-3 right-3 w-10 h-10 bg-white/90 rounded-full flex items-center justify-center border border-gray-200"
                    onClick={() => {
                      if (!auth.currentUser) {
                        window.dispatchEvent(new Event('auth:required'))
                        return
                      }
                      setLikedIds((prev) => ({ ...prev, [item.id]: !prev[item.id] }))
                    }}
                  >
                    <Heart className={`w-5 h-5 ${likedIds[item.id] ? 'text-red-500 fill-red-500' : 'text-gray-600'}`} />
                  </button>
                </div>
                <div className="p-4">
                  <div className="font-semibold text-gray-900 truncate">{item.title}</div>
                  <div className="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      className="flex-1 bg-gray-900 text-white hover:bg-gray-800"
                      onClick={() => void downloadPng(item.image, `${item.id}.png`)}
                    >
                      <Download className="w-4 h-4 mr-2" />
                      Download
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      onClick={() => openOnlineColoring(item.image)}
                    >
                      Color Online
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {shown.length < filtered.length && (
            <div className="text-center mt-10">
              <Button variant="outline" className="px-8 py-6 text-lg" onClick={() => setVisibleCount((n) => n + 12)}>
                Load More
                <ChevronDown className="w-5 h-5 ml-2" />
              </Button>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

// ==================== MAIN APP ====================
function App() {
  const [user, setUser] = useState<User | null>(null)
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [authDialogOpen, setAuthDialogOpen] = useState(false)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u))
    return () => unsub()
  }, [])

  useEffect(() => {
    const handler = () => setAuthDialogOpen(true)
    window.addEventListener('auth:required', handler)
    return () => window.removeEventListener('auth:required', handler)
  }, [])

  useEffect(() => {
    const run = async () => {
      const sessionId = getOrCreateSessionId()
      try {
        await addDoc(collection(db, 'visits'), {
          createdAt: serverTimestamp(),
          uid: user?.uid ?? null,
          sessionId,
          path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
          referrer: document.referrer || null,
          userAgent: navigator.userAgent,
        })
      } catch {
        return
      }
    }
    void run()
  }, [user?.uid])

  useEffect(() => {
    const run = async () => {
      if (!user) return
      try {
        await setDoc(
          doc(db, 'users', user.uid),
          {
            uid: user.uid,
            email: user.email ?? null,
            displayName: user.displayName ?? null,
            photoURL: user.photoURL ?? null,
            lastSignInAt: serverTimestamp(),
          },
          { merge: true }
        )
      } catch {
        return
      }
    }
    void run()
  }, [user])

  const handleSignIn = async () => {
    setIsSigningIn(true)
    try {
      await signInWithPopup(auth, googleProvider)
    } catch {
      return
    } finally {
      setIsSigningIn(false)
    }
  }

  const handleSignOut = async () => {
    try {
      await signOut(auth)
    } catch {
      return
    }
  }

  return (
    <div className="min-h-screen bg-white">
      <Header user={user} onSignIn={handleSignIn} onSignOut={handleSignOut} isSigningIn={isSigningIn} />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/cookies" element={<CookiesPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="/contact" element={<ContactPage />} />
        <Route path="/blog" element={<BlogPage />} />
        <Route path="/tutorials" element={<TutorialsPage />} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="/community" element={<CommunityPage />} />
        <Route path="/api-docs" element={<ApiDocsPage />} />
        <Route path="/press" element={<PressPage />} />
        <Route path="/partners" element={<PartnersPage />} />
        <Route path="/careers" element={<CareersPage />} />
        <Route path="/online-coloring" element={<OnlineColoringPage />} />
        <Route path="/generators" element={<GeneratorsIndexPage />} />
        <Route path="/generators/photo-to-coloring" element={<GeneratorPhotoPage />} />
        <Route path="/generators/text-to-coloring" element={<GeneratorTextPage />} />
        <Route path="/generators/coloring-book" element={<GeneratorBookPage />} />
        <Route path="/generators/image-editor" element={<GeneratorEditorPage />} />
        <Route path="/generators/colorize" element={<GeneratorColorizePage />} />
        <Route path="/coloring-pages/:category" element={<ColoringPagesCategoryPage />} />
        <Route path="*" element={<HomePage />} />
      </Routes>
      <Dialog open={authDialogOpen} onOpenChange={setAuthDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Please sign in to continue</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-gray-600">This feature requires an account.</div>
          <div className="mt-4 flex gap-2">
            <Button
              className="bg-gradient-to-r from-indigo-600 to-emerald-500 text-white"
              onClick={async () => {
                await handleSignIn()
                setAuthDialogOpen(false)
              }}
              disabled={isSigningIn}
            >
              {isSigningIn && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Sign In
            </Button>
            <Button variant="outline" onClick={() => setAuthDialogOpen(false)}>
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Footer />
    </div>
  );
}

export default App;
