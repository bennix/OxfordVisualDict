#!/usr/bin/env python3
"""Local CosyVoice 2 / 3 server. Loads the model from a checkout of
https://github.com/FunAudioLLM/CosyVoice and serves WAV on POST /tts.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import signal
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
MODEL = None
SAMPLE_RATE = 24000
LOAD_ERROR = ""
ARGS = None


def load_model():
    global MODEL, SAMPLE_RATE, LOAD_ERROR
    try:
        repo = os.path.abspath(ARGS.repo)
        if repo not in sys.path:
            sys.path.insert(0, repo)
        matcha = os.path.join(repo, "third_party", "Matcha-TTS")
        if os.path.isdir(matcha) and matcha not in sys.path:
            sys.path.insert(0, matcha)
        os.chdir(repo)
        from cosyvoice.cli.cosyvoice import AutoModel

        MODEL = AutoModel(model_dir=os.path.abspath(ARGS.model_dir))
        SAMPLE_RATE = int(getattr(MODEL, "sample_rate", 24000))
        LOAD_ERROR = ""
    except Exception:
        LOAD_ERROR = traceback.format_exc()
        MODEL = None


def synthesize(text: str) -> bytes:
    if MODEL is None:
        raise RuntimeError(LOAD_ERROR or "CosyVoice 模型尚未加载")
    import torch
    import torchaudio

    prompt_wav = ARGS.prompt_wav
    prompt_text = ARGS.prompt_text or "This is a clear English voice."
    spoken = text.strip()
    if not spoken:
        raise RuntimeError("没有可朗读的文本")
    if ARGS.version == "cosyvoice3" and "<|endofprompt|>" not in prompt_text:
        prompt_text = "You are a helpful assistant.<|endofprompt|>" + prompt_text
    chunks = []
    with LOCK:
        generated = MODEL.inference_zero_shot(spoken, prompt_text, prompt_wav, stream=False)
        for item in generated:
            chunks.append(item["tts_speech"])
    if not chunks:
        raise RuntimeError("CosyVoice 没有返回音频")
    speech = torch.cat(chunks, dim=-1) if chunks[0].dim() > 1 else torch.cat(chunks, dim=0)
    if speech.dim() == 1:
        speech = speech.unsqueeze(0)
    buf = io.BytesIO()
    torchaudio.save(buf, speech.cpu(), SAMPLE_RATE, format="wav")
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args):
        try:
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))
        except Exception:
            pass

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] != "/health":
            self._json(404, {"ok": False})
            return
        self._json(
            200,
            {
                "ok": MODEL is not None,
                "engine": ARGS.version,
                "sample_rate": SAMPLE_RATE,
                "error": LOAD_ERROR[-1200:] if LOAD_ERROR else "",
            },
        )

    def do_POST(self):
        if self.path.split("?")[0] != "/tts":
            self._json(404, {"ok": False})
            return
        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
            wav = synthesize(str(payload.get("text") or ""))
        except Exception as exc:
            self._json(500, {"ok": False, "error": str(exc)})
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.end_headers()
        self.wfile.write(wav)


def main():
    global ARGS
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--version", choices=["cosyvoice2", "cosyvoice3"], default="cosyvoice3")
    parser.add_argument("--prompt-wav", required=True)
    parser.add_argument("--prompt-text", default="This is a clear English voice.")
    ARGS = parser.parse_args()

    class Server(ThreadingHTTPServer):
        allow_reuse_address = True

    server = Server((ARGS.host, ARGS.port), Handler)
    threading.Thread(target=load_model, daemon=True).start()
    print(f"listening {ARGS.host}:{ARGS.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
