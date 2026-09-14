# Local Voice Runtime

Status: architecture and end-to-end contract are complete. Physical local execution depends only on a host with the required models and runtimes installed.

## Boundary

Janus Core does not import Whisper or Qwen. The runtime only knows two local HTTP adapters:

- STT: `JANUS_STT_BASE_URL` -> whisper.cpp compatible `/inference`
- TTS: `JANUS_TTS_BASE_URL` -> Janus Qwen sidecar `/synthesize`

If either adapter is absent, `/health` reports voice streaming unavailable and the PWA falls back instead of pretending full-duplex is active.

## Local-only defaults

Keep all of the following outside Git:

- model weights
- cloned/reference voice audio
- `config/voices.local.json`
- `.env.voice.local`
- virtual environments

The repository `.gitignore` already excludes these locations. Do not store tokens or secrets in voice config JSON.

## 1. whisper.cpp

Official project: `ggml-org/whisper.cpp`.

Build locally according to the upstream instructions. A multilingual model is required for Spanish; do not use an `.en` model. A practical first benchmark is `small`, then move up or down based on measured latency on the actual Janus host.

Example upstream flow:

```bash
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -B build
cmake --build build -j --config Release
sh ./models/download-ggml-model.sh small
./build/bin/whisper-server --host 127.0.0.1 --no-timestamps -m ./models/ggml-small.bin
```

Janus expects the default local server endpoint at:

```text
http://127.0.0.1:8080
```

`--no-timestamps` is intentional: current whisper.cpp server versions can otherwise insert unwanted line wrapping in normal text output when token timestamps are enabled.

## 2. Qwen3-TTS

Official project: `QwenLM/Qwen3-TTS`.

Use a clean Python 3.12 environment. The upstream package is `qwen-tts`.

```bash
python3.12 -m venv .venv-qwen
source .venv-qwen/bin/activate
python -m pip install --upgrade pip
pip install -U qwen-tts
```

Model families used by Janus:

- `CustomVoice`: approved built-in speaker identities.
- `VoiceDesign`: designed canonical voice; currently available in the 1.7B family.
- `Base`: voice cloning from local reference audio; suitable for Jean's cloned voice once the approved reference sample exists locally.

For low-resource hardware, benchmark a 0.6B model first. Promote to 1.7B only when quality gains justify measured RAM/VRAM and latency on the actual host.

Download model weights deliberately to a local directory before runtime. Do not rely on background downloads during normal Janus startup.

## 3. Voice identities

Copy the tracked template once:

```bash
cp config/voices.example.json config/voices.local.json
```

Then replace placeholders with absolute local paths. `config/voices.local.json` is ignored by Git.

Rules:

- The canonical Janus voice gets a stable `voiceId` but the model/provider behind it stays replaceable.
- Jean's cloned voice must use only an explicitly approved local reference recording and matching transcript.
- Never commit reference recordings.
- Do not use remote URLs for clone audio.
- Do not enable remote model IDs or remote bind unless explicitly approved.

## 4. Start Qwen sidecar

With the Python environment active:

```bash
export JANUS_QWEN_VOICE_CONFIG=/absolute/path/janus-core/config/voices.local.json
export JANUS_QWEN_HOST=127.0.0.1
export JANUS_QWEN_PORT=8090
python sidecars/qwen3_tts_server.py
```

Health check:

```text
GET http://127.0.0.1:8090/health
```

The sidecar loads models lazily and returns typed PCM16 audio. It binds to loopback by default.

## 5. Start Janus Core with both local adapters

Copy `.env.voice.example` to `.env.voice.local` and set the local absolute paths and approved voice ID. Load those variables in the shell, then run:

```bash
npm start
```

Expected `/health` state:

```json
{
  "voice": {
    "streaming": {
      "state": "available",
      "transport": "websocket"
    }
  }
}
```

## 6. Acceptance gate on the physical host

Do not call the physical setup complete until all of these are verified on the actual machine:

1. Whisper transcribes Spanish speech locally with acceptable latency and no network dependency.
2. Qwen synthesizes the approved Janus voice locally and reports typed PCM.
3. iPhone PWA completes a full spoken command -> task -> spoken response cycle.
4. Barge-in cuts playback immediately while the underlying task remains active.
5. Disconnect Internet and repeat a local command successfully.

Record the tested model names, checksums, measured latency, host hardware and final voice IDs after this gate. Those measurements become the VIGENTE runtime profile; previous profiles become HISTORICAL rather than being overwritten.
