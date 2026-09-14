# JANUS CORE

Local-first personal AI operating system for Jean.

## Current milestone

**M0 — Observable Voice Execution**

Janus can listen, execute, expose verifiable activity and speak through replaceable local voice adapters. Voice is a first-class client of Janus Core, not a reduced chat mode.

### Non-negotiable rules

1. **Janus Core is the authority.** Models and external services are replaceable adapters.
2. **Local-first.** SQLite/local storage owns state, memory, context, knowledge, lessons and task traces. Cloud services are adapters/sync, not the brain.
3. **Continue by default.** A task keeps advancing until completed, explicitly paused, blocked by a real dependency, or waiting for approval for a risky/irreversible action.
4. **Observable execution.** Never leave the user staring at a static screen while work is happening. Emit structured activity events for every meaningful step.
5. **Voice parity.** Anything allowed from text should be invokable from voice under the same permissions and approval rules.
6. **Provider independence.** Model Gateway, Voice Gateway and Tool Gateway isolate vendors.
7. **Safety + traceability.** External actions are permissioned, idempotent where possible, logged and revalidated after offline periods.

## Current architecture

```text
 iPhone / PWA
      │
      │ AudioWorklet -> PCM16 16 kHz mono
      ▼
 WebSocket Voice Transport
      │
      ▼
 ┌───────────────────────────────┐
 │          JANUS CORE           │
 │                               │
 │ Task/Run Engine               │
 │ Event Stream + Audit Log      │
 │ SQLite durable state          │
 │ Approval / policy boundary    │
 └───────┬──────────┬────────────┘
         │          │
   ┌─────▼────┐ ┌───▼─────────┐
   │ Voice    │ │ Tool / Model│
   │ Gateway  │ │ Gateways    │
   └──┬────┬──┘ └─────────────┘
      │    │
      │    └── TTS adapter -> local Qwen sidecar
      └─────── STT adapter -> local whisper.cpp server
```

Neither Whisper nor Qwen is part of Janus Core. Both can be replaced without changing the task engine, PWA contract or durable state.

## Voice path

### Input

`iPhone microphone -> AudioWorklet -> PCM16 -> WebSocket -> Whisper adapter -> transcript -> VoiceSession -> TaskRunner`

### Output

`terminal run event -> safe spoken summary -> Qwen adapter -> typed PCM -> WebSocket -> AudioBuffer queue -> iPhone speaker`

Barge-in is local and immediate: when the user starts speaking, scheduled TTS playback is cut without cancelling the underlying Janus task.

Automatic spoken responses use only sanitized `artifact.updated.payload.preview` data. Raw tool payloads, file bodies, message snippets, tokens and error details are not automatically sent to TTS.

## Execution event contract

Active runs emit observable events such as:

- `run.heard`
- `run.started`
- `run.step.started`
- `tool.started`
- `tool.progress`
- `tool.completed`
- `artifact.updated`
- `run.blocked`
- `approval.required`
- `run.step.completed`
- `run.completed`
- `run.paused`
- `run.failed`

The UI renders observable work only; it never exposes private model chain-of-thought.

## Status

### HECHO

- Janus Core repository and provider-independent gateway boundaries.
- Task state machine with pause/resume/cancel/block semantics.
- Structured event protocol and mobile-first PWA activity console.
- SQLite persistence and interrupted-run recovery.
- Capability registry and Core-side plan validation.
- GitHub and Google Workspace read adapters.
- Replaceable Model Gateway.
- Voice session authority in Core.
- Full-duplex PCM WebSocket transport.
- iPhone AudioWorklet capture and PCM resampling.
- Local VAD/endpointing and barge-in.
- Local whisper.cpp STT adapter with loopback-only default.
- Typed TTS contract and local Qwen3-TTS HTTP adapter.
- Janus-owned Qwen sidecar supporting custom voice, voice design and voice clone modes.
- Mobile PCM playback queue and immediate interruption.
- Safe automatic spoken completion summaries.
- End-to-end integration test: PCM -> STT -> task -> safe summary -> TTS -> PCM over WebSocket.
- CI gates: strict TypeScript, PWA syntax, Qwen sidecar syntax, tests and runtime smoke.

### AHORA

- Materialize the local voice runtime on the actual Janus host.
- Install/build whisper.cpp locally and place multilingual model weights outside Git.
- Install Qwen3-TTS in an isolated Python 3.12 environment and place selected model weights outside Git.
- Create the private local voice configuration with the already approved canonical voice identity.
- Add Jean's cloned voice only after a local approved reference recording + exact transcript exist.

See `docs/voice-local-runtime.md` and `.env.voice.example`.

### PENDIENTE

- Physical-host latency benchmark and hardware profile.
- Offline acceptance test on the actual host.
- Final voice IDs and model checksums recorded as the VIGENTE runtime profile.
- Wider Tool Gateway coverage and remaining Janus capabilities after M0 voice acceptance.
- Apple ecosystem and home-device bridges where they add real value.

### BLOQUEADO

- Physical always-on local voice execution remains blocked until a suitable Janus host is available/configured with local models. This is a deployment/hardware dependency, not an architecture dependency.

## Verification

The CI suite includes an end-to-end full-duplex smoke that starts local simulated STT/TTS services plus the real Janus runtime and verifies:

1. PCM input reaches the STT adapter as an in-memory WAV.
2. The final transcript starts a real Janus run.
3. The completed run generates only a safe spoken preview.
4. The TTS adapter receives the approved voice ID and returns typed PCM.
5. WebSocket sends `speech.audio` metadata immediately before each binary PCM frame.
6. The entire suite still passes the general runtime smoke.

## Repository layout

```text
apps/pwa/                 Mobile-first Janus interface
apps/runtime/             Local Janus runtime HTTP/WebSocket process
packages/core/            Task/run state, event protocol, SQLite persistence
packages/gateways/        Model, Voice and Tool contracts
packages/voice/           Voice session, duplex engine and transport
packages/adapters/        Replaceable provider/tool/model/voice adapters
sidecars/                 Optional local provider processes outside Core
config/                   Tracked examples only; private local config is ignored
docs/                     Architecture, deployment and continuity decisions
tests/                    Unit, integration and end-to-end gates
```
