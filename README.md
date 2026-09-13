# JANUS CORE

Local-first personal AI operating system for Jean.

## Current milestone

**M0 — Observable Voice Execution**

Janus must be able to listen, speak, execute tools and show verifiable activity at the same time. Voice is a first-class client of Janus Core, not a reduced chat mode.

### Non-negotiable rules

1. **Janus Core is the authority.** Models and external services are replaceable adapters.
2. **Local-first.** SQLite/local storage owns state, memory, context, knowledge, lessons and task traces. Cloud services are adapters/sync, not the brain.
3. **Continue by default.** A task keeps advancing until completed, explicitly paused, blocked by a real dependency, or waiting for approval for a risky/irreversible action.
4. **Observable execution.** Never leave the user staring at a static screen while work is happening. Emit structured activity events for every meaningful step.
5. **Voice parity.** Anything allowed from text should be invokable from voice under the same permissions and approval rules.
6. **Provider independence.** Model Gateway, Voice Gateway and Tool Gateway isolate vendors.
7. **Safety + traceability.** External actions are permissioned, idempotent where possible, logged and revalidated after offline periods.

## M0 architecture

```text
                  ┌─────────────────────┐
 iPhone / PWA ───▶│                     │
 Voice client ───▶│     JANUS CORE      │◀── Text / future desktop
                  │                     │
                  └──────┬───────┬──────┘
                         │       │
                 ┌───────▼──┐ ┌──▼──────────┐
                 │ Task/Run │ │ Event Stream│
                 │ Engine   │ │ + Audit Log │
                 └───────┬──┘ └─────────────┘
                         │
              ┌──────────┼───────────┐
              │          │           │
        ┌─────▼─────┐┌───▼──────┐┌──▼─────────┐
        │Model      ││Voice     ││Tool        │
        │Gateway    ││Gateway   ││Gateway     │
        └───────────┘└──────────┘└────┬───────┘
                                      │
                     Google / GitHub / Vercel / Hostinger /
                     browser / files / Apple / home devices
```

## Execution event contract

Every active run emits events such as:

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

The UI renders these events live; it never exposes private model chain-of-thought. It shows only **observable work**: tool, target, result, progress, file/page/action and next step.

## Status

### HECHO
- Janus Core repository created.
- Voice audition assets already exist separately; canonical voice selection remains pending.
- M0 requirements frozen: voice + tools + observable execution + continue-by-default.

### AHORA
- Implement event protocol and task state machine.
- Build mobile-first PWA activity console.
- Define Voice Gateway and Tool Gateway contracts.

### PENDIENTE
- SQLite persistence and durable run recovery.
- Real tool adapters.
- Full-duplex voice transport (WebRTC preferred on iPhone).
- Apple ecosystem bridge and home-device adapters.

### BLOQUEADO
- Local always-on Janus host until a suitable laptop/mini-PC is available. Until then the iPhone remains the primary client and a replaceable remote runtime may be used for execution.

## Repository layout

```text
apps/pwa/                 Mobile-first Janus interface
packages/core/            Task/run state machine and event protocol
packages/gateways/        Model, Voice and Tool adapter contracts
docs/                     Architecture and UX decisions
```
