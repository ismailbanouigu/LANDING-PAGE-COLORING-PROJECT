InkBloom — Line-Art Backend (Cloud Run)

This adds a minimal Python FastAPI service that converts uploaded images into line-art using an ONNX model (CPU). The frontend stays on Cloudflare; the Worker proxies /api/convert to this service.

What was added
- backend/lineart/
  - main.py — FastAPI app with /api/convert (multipart "image" -> PNG line-art)
  - requirements.txt — fastapi, uvicorn, onnxruntime, numpy, pillow
  - Dockerfile — installs deps and pre-downloads the ONNX model
- worker.ts — new route /api/convert that forwards to LINEART_API_URL (with CORS/OPTIONS)
- src/App.tsx — “Convert to Coloring Page” now: try /api/convert, fallback to in-browser ONNX if backend not reachable

Deploy (Google Cloud Run)
Prereqs: gcloud installed and authenticated; a GCP project selected; Cloud Run + Container Registry enabled.

1) Build & push

  cd backend/lineart
  gcloud builds submit --tag gcr.io/PROJECT_ID/inkbloom-lineart:latest

2) Deploy

  gcloud run deploy inkbloom-lineart \
    --image gcr.io/PROJECT_ID/inkbloom-lineart:latest \
    --platform managed \
    --region REGION \
    --allow-unauthenticated \
    --memory 1Gi --cpu 1

Note the service URL (e.g., https://inkbloom-lineart-xxxxx-uc.a.run.app).

3) Set Worker env var and redeploy

  wrangler secret put LINEART_API_URL
  # paste the Cloud Run service URL
  npm run deploy

(Optional) Pollinations key for /api/edit-image

  wrangler secret put POLLINATIONS_API_KEY
  npm run deploy

Local testing

  docker build -t inkbloom-lineart:local backend/lineart
  docker run -p 8080:8080 inkbloom-lineart:local
  curl -X POST http://localhost:8080/api/convert \
    -F image=@/path/to/photo.jpg --output out.png

Notes
- /api/convert returns image/png. The frontend reads it as blob and shows it.
- If the backend is down, the UI falls back to the in-browser ONNX path automatically.
- Keep secrets off the frontend; use Worker secrets for any keys (e.g., POLLINATIONS_API_KEY).

