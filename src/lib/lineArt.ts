const LINE_ART_MODEL_URL =
  'https://huggingface.co/rocca/informative-drawings-line-art-onnx/resolve/main/informative-drawings_model_3.onnx'

type OrtTensor = {
  data: Float32Array | Uint8Array | Int32Array | number[]
  dims?: number[]
}

type OrtSession = {
  inputNames?: string[]
  outputNames?: string[]
  run: (feeds: Record<string, unknown>) => Promise<Record<string, OrtTensor>>
}

type Ort = {
  InferenceSession: {
    create: (pathOrUrl: string) => Promise<OrtSession>
  }
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown
}

function getOrt(): Ort {
  const ortCandidate =
    typeof window !== 'undefined' ? (window as unknown as { ort?: unknown }).ort : undefined
  if (!ortCandidate || typeof ortCandidate !== 'object') {
    throw new Error('AI model failed to load, please try again')
  }
  const record = ortCandidate as Record<string, unknown>
  const inference = record.InferenceSession
  if (!inference || (typeof inference !== 'object' && typeof inference !== 'function')) {
    throw new Error('AI model failed to load, please try again')
  }
  const create =
    typeof inference === 'object' && inference !== null ? (inference as Record<string, unknown>).create : undefined
  if (typeof create !== 'function') {
    throw new Error('AI model failed to load, please try again')
  }
  if (typeof record.Tensor !== 'function') {
    throw new Error('AI model failed to load, please try again')
  }
  return ortCandidate as Ort
}

let sessionPromise: Promise<OrtSession> | null = null

export async function getLineArtSession() {
  if (!sessionPromise) {
    const ort = getOrt()
    sessionPromise = ort.InferenceSession.create(LINE_ART_MODEL_URL)
  }
  return sessionPromise
}

function clamp01(n: number) {
  if (Number.isNaN(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function createImageFromObjectUrl(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = url
  })
}

export async function convertFileToLineArtDataUrl(file: File) {
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = await createImageFromObjectUrl(objectUrl)
    return await convertImageToLineArtDataUrl(image)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export async function convertImageToLineArtDataUrl(image: CanvasImageSource) {
  const session = await getLineArtSession()
  const ort = getOrt()

  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas not supported')
  ctx.drawImage(image, 0, 0, size, size)

  const imageData = ctx.getImageData(0, 0, size, size)
  const float32Data = new Float32Array(3 * size * size)
  for (let i = 0; i < size * size; i++) {
    float32Data[i] = imageData.data[i * 4] / 255
    float32Data[size * size + i] = imageData.data[i * 4 + 1] / 255
    float32Data[2 * size * size + i] = imageData.data[i * 4 + 2] / 255
  }

  const tensor = new ort.Tensor('float32', float32Data, [1, 3, size, size])
  const inputName = (session.inputNames && session.inputNames[0]) || 'input'
  const results = await session.run({ [inputName]: tensor })
  const outputName =
    (session.outputNames && session.outputNames[0]) || Object.keys(results)[0] || 'output'
  const outputTensor = results[outputName]
  if (!outputTensor) throw new Error('Conversion failed')

  const dataRaw = outputTensor.data
  const out = Array.isArray(dataRaw) ? Float32Array.from(dataRaw) : (dataRaw as Float32Array)
  const expected = size * size
  const offset = out.length >= expected ? out.length - expected : 0

  const outputCanvas = document.createElement('canvas')
  outputCanvas.width = size
  outputCanvas.height = size
  const outCtx = outputCanvas.getContext('2d')
  if (!outCtx) throw new Error('Canvas not supported')
  const outImageData = outCtx.createImageData(size, size)
  for (let i = 0; i < expected; i++) {
    const v = clamp01(out[offset + i] ?? 0)
    const gray = Math.round((1 - v) * 255)
    outImageData.data[i * 4] = gray
    outImageData.data[i * 4 + 1] = gray
    outImageData.data[i * 4 + 2] = gray
    outImageData.data[i * 4 + 3] = 255
  }
  outCtx.putImageData(outImageData, 0, 0)
  return outputCanvas.toDataURL('image/png')
}
