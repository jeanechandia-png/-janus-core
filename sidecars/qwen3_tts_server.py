#!/usr/bin/env python3
"""Local JANUS Qwen3-TTS sidecar.

The sidecar is deliberately outside JANUS CORE. It exposes one small local
contract: POST /synthesize -> typed PCM16 audio. Model paths and voice identity
live in a local config file, not in Core or SQLite.
"""

from __future__ import annotations

import json
import os
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

MAX_REQUEST_BYTES = 64 * 1024
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8090

_MODEL_CACHE: dict[str, Any] = {}
_MODEL_LOCK = threading.Lock()
_INFERENCE_LOCK = threading.Lock()


def env_true(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() == "true"


def load_voice_config(path: str) -> dict[str, dict[str, Any]]:
    config_path = Path(path).expanduser().resolve()
    payload = json.loads(config_path.read_text(encoding="utf-8"))
    voices = payload.get("voices")
    if not isinstance(voices, dict) or not voices:
        raise RuntimeError("voice config must contain a non-empty 'voices' object")

    normalized: dict[str, dict[str, Any]] = {}
    for voice_id, spec in voices.items():
        if not isinstance(voice_id, str) or not voice_id.strip() or not isinstance(spec, dict):
            raise RuntimeError("each voice must have a non-empty id and object config")
        mode = str(spec.get("mode", "")).strip()
        if mode not in {"custom_voice", "voice_design", "voice_clone"}:
            raise RuntimeError(f"voice '{voice_id}' has unsupported mode '{mode}'")
        model_path = str(spec.get("model_path", "")).strip()
        if not model_path:
            raise RuntimeError(f"voice '{voice_id}' is missing model_path")
        normalized[voice_id.strip()] = dict(spec)
    return normalized


def resolve_model_reference(value: str, allow_remote: bool) -> str:
    candidate = Path(value).expanduser()
    if candidate.exists():
        return str(candidate.resolve())
    if allow_remote:
        return value
    raise RuntimeError(
        "Qwen model_path must resolve to a local file/directory. "
        "Set JANUS_QWEN_ALLOW_REMOTE_MODEL_ID=true explicitly to permit a remote model id."
    )


def resolve_local_audio(value: str) -> str:
    path = Path(value).expanduser()
    if not path.exists() or not path.is_file():
        raise RuntimeError("voice clone ref_audio must be an existing local file")
    return str(path.resolve())


def load_model(model_reference: str) -> Any:
    with _MODEL_LOCK:
        existing = _MODEL_CACHE.get(model_reference)
        if existing is not None:
            return existing

        from qwen_tts import Qwen3TTSModel  # Imported lazily; Core never imports this package.

        kwargs: dict[str, Any] = {}
        device = os.environ.get("JANUS_QWEN_DEVICE", "").strip()
        if device:
            kwargs["device_map"] = device
        model = Qwen3TTSModel.from_pretrained(model_reference, **kwargs)
        _MODEL_CACHE[model_reference] = model
        return model


def synthesize_voice(
    spec: dict[str, Any],
    text: str,
    request_language: str | None,
    allow_remote_model: bool,
) -> tuple[bytes, int]:
    import numpy as np

    model_reference = resolve_model_reference(str(spec["model_path"]), allow_remote_model)
    model = load_model(model_reference)
    mode = str(spec["mode"])
    language = str(spec.get("language") or request_language or "Auto")

    with _INFERENCE_LOCK:
        if mode == "custom_voice":
            speaker = str(spec.get("speaker", "")).strip()
            if not speaker:
                raise RuntimeError("custom_voice requires speaker")
            wavs, sample_rate = model.generate_custom_voice(
                text=text,
                language=language,
                speaker=speaker,
                instruct=str(spec.get("instruct", "")),
                non_streaming_mode=True,
            )
        elif mode == "voice_design":
            instruct = str(spec.get("instruct", "")).strip()
            if not instruct:
                raise RuntimeError("voice_design requires instruct")
            wavs, sample_rate = model.generate_voice_design(
                text=text,
                language=language,
                instruct=instruct,
                non_streaming_mode=True,
            )
        else:
            ref_audio = resolve_local_audio(str(spec.get("ref_audio", "")))
            ref_text = spec.get("ref_text")
            x_vector_only = bool(spec.get("x_vector_only_mode", False))
            wavs, sample_rate = model.generate_voice_clone(
                text=text,
                language=language,
                ref_audio=ref_audio,
                ref_text=str(ref_text) if ref_text is not None else None,
                x_vector_only_mode=x_vector_only,
                non_streaming_mode=True,
            )

    if not wavs:
        raise RuntimeError("Qwen returned no audio")
    waveform = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
    waveform = np.nan_to_num(waveform, nan=0.0, posinf=1.0, neginf=-1.0)
    pcm = (np.clip(waveform, -1.0, 1.0) * 32767.0).astype("<i2", copy=False)
    return pcm.tobytes(), int(sample_rate)


class JanusQwenHandler(BaseHTTPRequestHandler):
    server_version = "janus-qwen3-tts/0.1"

    @property
    def voices(self) -> dict[str, dict[str, Any]]:
        return self.server.voices  # type: ignore[attr-defined]

    @property
    def allow_remote_model(self) -> bool:
        return self.server.allow_remote_model  # type: ignore[attr-defined]

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self.send_json(
            HTTPStatus.OK,
            {
                "ok": True,
                "service": "janus-qwen3-tts-sidecar",
                "voices": [
                    {"id": voice_id, "mode": str(spec.get("mode", "unknown"))}
                    for voice_id, spec in self.voices.items()
                ],
                "loadedModels": len(_MODEL_CACHE),
                "remoteModelIdsAllowed": self.allow_remote_model,
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/synthesize":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        content_length = self.headers.get("content-length")
        try:
            length = int(content_length or "0")
        except ValueError:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid content-length"})
            return
        if length <= 0 or length > MAX_REQUEST_BYTES:
            self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "request size is invalid"})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid JSON"})
            return
        if not isinstance(payload, dict):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "JSON body must be an object"})
            return

        text = str(payload.get("text", "")).strip()
        voice_id = str(payload.get("voiceId", "")).strip()
        language = str(payload.get("language", "")).strip() or None
        if not text or not voice_id:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "text and voiceId are required"})
            return
        if len(text) > 8_000:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "text exceeds 8000 characters"})
            return

        spec = self.voices.get(voice_id)
        if spec is None:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "unknown voiceId"})
            return

        try:
            pcm, sample_rate = synthesize_voice(spec, text, language, self.allow_remote_model)
        except Exception as exc:  # Sidecar boundary: return a compact error, never a traceback.
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": compact_error(exc)})
            return

        self.send_response(HTTPStatus.OK)
        self.send_header(
            "content-type",
            f"audio/pcm;rate={sample_rate};channels=1;format=s16le",
        )
        self.send_header("content-length", str(len(pcm)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(pcm)

    def log_message(self, fmt: str, *args: Any) -> None:
        if env_true("JANUS_QWEN_HTTP_LOG"):
            super().log_message(fmt, *args)

    def send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def compact_error(exc: Exception) -> str:
    text = " ".join(str(exc).split()).strip()
    return (text or exc.__class__.__name__)[:300]


def main() -> None:
    config_path = os.environ.get("JANUS_QWEN_VOICE_CONFIG", "").strip()
    if not config_path:
        raise SystemExit("JANUS_QWEN_VOICE_CONFIG must point to a local JSON voice config")

    host = os.environ.get("JANUS_QWEN_HOST", DEFAULT_HOST).strip() or DEFAULT_HOST
    if host not in {"127.0.0.1", "localhost", "::1"} and not env_true("JANUS_QWEN_ALLOW_REMOTE_BIND"):
        raise SystemExit("Qwen sidecar binds to loopback by default; remote bind requires JANUS_QWEN_ALLOW_REMOTE_BIND=true")
    try:
        port = int(os.environ.get("JANUS_QWEN_PORT", str(DEFAULT_PORT)))
    except ValueError as exc:
        raise SystemExit("JANUS_QWEN_PORT must be an integer") from exc

    voices = load_voice_config(config_path)
    server = ThreadingHTTPServer((host, port), JanusQwenHandler)
    server.voices = voices  # type: ignore[attr-defined]
    server.allow_remote_model = env_true("JANUS_QWEN_ALLOW_REMOTE_MODEL_ID")  # type: ignore[attr-defined]
    print(f"JANUS Qwen3-TTS sidecar listening on http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
