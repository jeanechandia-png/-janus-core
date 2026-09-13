# ADR-001 — Voice is a first-class execution surface

**Status:** Accepted  
**Date:** 2026-09-13

## Problem

Most assistant voice modes behave like a separate, reduced product surface. A user can speak, but tool execution, navigation, file operations and visible progress often require leaving voice or waiting on a static screen. That breaks continuity and makes long-running work feel stalled even when the system is active.

## Decision

Janus will treat voice, text and future device surfaces as clients of the same **Janus Core run engine**.

Voice does not own planning, memory or tools. It captures/plays audio and exchanges structured events with the Core.

```text
Voice UI ─────┐
Text UI ──────┼──> Janus Core Run Engine ──> Tool Gateway
Desktop UI ───┘            │                Model Gateway
                           ├───────────────> Voice Gateway
                           └───────────────> Local state / audit
```

## Observable execution rule

Janus must never use hidden model reasoning as the progress display. Instead it emits observable facts:

- request received;
- current task/step;
- tool or adapter being used;
- target being accessed;
- progress/result returned by that tool;
- artifact/file changed;
- approval requested;
- real blocker;
- completion.

This provides reassurance without exposing private chain-of-thought or fabricating activity.

## Continue-by-default rule

A run continues after intermediate results. Rendering a page, producing a draft, finding a source or speaking a partial update does **not** imply completion.

A run stops only when:

1. the objective is complete;
2. Jean explicitly pauses/stops it;
3. a real external dependency blocks progress;
4. an approval is required for a risky/irreversible action;
5. continuation would violate a safety or permission boundary.

## Voice transport

Target architecture is full-duplex streaming:

- microphone stream stays logically attached to the active Janus session;
- ASR produces partial/final transcripts;
- Janus can execute tools while TTS is speaking;
- activity events stream independently of audio;
- barge-in interrupts speech, not the task unless the user says to pause/stop;
- a voice session can survive UI route changes and reconnect to an existing run.

Web Speech APIs may be used only as a temporary mobile prototype. The canonical Voice Gateway must support replaceable ASR/TTS engines and must not bind Janus Core to one provider.

## iPhone-first constraint

Until a local Janus host is available, the iPhone 16 Pro Max is the primary client. The client must be a PWA/native-capable shell, while execution can temporarily occur on a replaceable remote runtime. Once a laptop/mini-PC exists, the same protocol moves Core execution local without replacing the client.

## Consequences

### Positive
- Voice has feature parity with text.
- Long work is visibly alive.
- Model/provider changes do not rewrite the interface.
- The same run can be observed from phone, tablet or desktop.
- Audit and recovery are natural because work already emits events.

### Costs
- Requires a durable run/event model.
- Full duplex needs explicit audio-session handling on iOS.
- Tool adapters must report progress consistently.
- Remote temporary runtime cannot become the permanent authority.
