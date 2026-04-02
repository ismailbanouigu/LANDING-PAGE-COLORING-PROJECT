import io
import os
import urllib.request
from typing import Optional

import numpy as np
from fastapi import FastAPI, File, UploadFile, Response
from PIL import Image

try:
    import onnxruntime as ort
except Exception as e:
    ort = None

MODEL_URL = os.environ.get(
    "LINEART_MODEL_URL",
    "https://huggingface.co/rocca/informative-drawings-line-art-onnx/resolve/main/informative-drawings_model_3.onnx",
)
MODEL_PATH = os.environ.get("LINEART_MODEL_PATH", "/app/model.onnx")
IMG_SIZE = 512

app = FastAPI(title="InkBloom Line-Art API", version="1.0.0")
_session: Optional["ort.InferenceSession"] = None


def ensure_model():
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    if not os.path.exists(MODEL_PATH):
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)


def get_session():
    global _session
    if _session is not None:
        return _session
    if ort is None:
        raise RuntimeError("onnxruntime not available")
    ensure_model()
    _session = ort.InferenceSession(MODEL_PATH, providers=["CPUExecutionProvider"])
    return _session


def preprocess(pil_img: Image.Image) -> np.ndarray:
    img = pil_img.convert("RGB").resize((IMG_SIZE, IMG_SIZE), Image.BILINEAR)
    arr = np.asarray(img).astype("float32") / 255.0
    arr = np.transpose(arr, (2, 0, 1))  # HWC -> CHW
    arr = np.expand_dims(arr, 0)  # NCHW
    return arr


def postprocess(output: np.ndarray) -> Image.Image:
    o = output.reshape(IMG_SIZE, IMG_SIZE)
    o = np.clip(1.0 - o, 0.0, 1.0)  # invert, black lines on white
    gray = (o * 255.0).astype("uint8")
    pil = Image.fromarray(gray, mode="L").convert("RGB")
    return pil


@app.post("/api/convert", response_class=Response)
def convert_to_lineart(image: UploadFile = File(...)):
    try:
        session = get_session()
        raw = image.file.read()
        pil = Image.open(io.BytesIO(raw))
        inp = preprocess(pil)
        input_name = session.get_inputs()[0].name
        outputs = session.run(None, {input_name: inp})
        out = outputs[0]
        pil_out = postprocess(out)
        buf = io.BytesIO()
        pil_out.save(buf, format="PNG")
        buf.seek(0)
        return Response(content=buf.read(), media_type="image/png")
    except Exception as e:
        return Response(
            content=f'{{"error":"{str(e)}"}}'.encode("utf-8"),
            media_type="application/json",
            status_code=500,
        )

