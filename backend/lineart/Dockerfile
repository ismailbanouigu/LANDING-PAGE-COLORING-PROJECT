FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY main.py /app/main.py

# Pre-download model at build time to avoid cold start
ENV LINEART_MODEL_URL="https://huggingface.co/rocca/informative-drawings-line-art-onnx/resolve/main/informative-drawings_model_3.onnx" \
    LINEART_MODEL_PATH="/app/model.onnx"
RUN python - <<'PY'\nfrom main import ensure_model\nensure_model()\nprint('Model downloaded')\nPY

CMD uvicorn main:app --host 0.0.0.0 --port $PORT

