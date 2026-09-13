# JANUS — Estado vigente

Fecha: 2026-09-13

## AHORA

**M0 — Observable Voice Execution**

Construir una vertical slice donde Jean pueda iniciar una tarea desde voz o texto, mantener la sesión activa, ver actividad verificable en tiempo real, pausar/reanudar y recibir el resultado sin abandonar el modo de voz.

## HECHO

- Repositorio `janus-core` inicializado.
- Contrato de eventos de ejecución definido.
- `TaskRunner` implementado con regla continue-by-default.
- Estados de pausa, bloqueo, error, aprobación y finalización implementados.
- EventHub con replay acotado implementado.
- Model Gateway, Voice Gateway y Tool Gateway desacoplados por interfaces.
- Tool Gateway base con registro de adaptadores implementado.
- Runtime HTTP/SSE inicial implementado.
- PWA mobile-first inicial implementada.
- Entrada de voz de navegador añadida como prototipo temporal.
- PWA shell con caché offline añadida.
- Prueba manual del runner ejecutada: 11 eventos, estado final `completed`.
- Pruebas automatizadas añadidas al repositorio.
- ADR de voz + ejecución observable aceptado.
- Activos previos de audición de voz localizados: Qwen3-TTS probado en español; voz canónica y validación NL aún pendientes.

## PENDIENTE — M0

1. Ejecutar `npm install && npm test && npm run typecheck` en un runtime con acceso a npm.
2. Añadir persistencia SQLite de runs/events/tasks.
3. Recuperación después de reinicio/reconexión.
4. Sustituir pasos demo por un planner mínimo y Tool Gateway real.
5. Implementar primer adaptador real: GitHub o Google Workspace.
6. Añadir aprobación desde UI para acciones de riesgo.
7. Implementar Voice Gateway streaming real (ASR/TTS) y barge-in.
8. Probar Safari/iPhone instalado como PWA.

## BLOQUEADO / LIMITACIONES REALES

- No hay todavía ordenador local que pueda actuar como Janus Core siempre encendido.
- El entorno local de validación usado durante esta sesión no tiene salida DNS a GitHub/npm; por eso la validación completa de dependencias deberá ejecutarse en un runtime conectado.
- La voz canónica de Janus todavía no está elegida y Qwen3-TTS no está validado como motor único para neerlandés.

## PRÓXIMO

### P0
- Persistencia SQLite + recuperación de runs.
- Primera herramienta real con eventos observables.
- Voice session state independiente del render de UI.

### P1
- Google Workspace adapter.
- GitHub adapter.
- Browser/navigation adapter.
- Vercel + Hostinger adapters.

### P2
- Apple bridge (Shortcuts/App Intents/macOS helper cuando exista host local).
- Canva/CapCut integration según API/automatización disponible.
- Home/device control via HomeKit/Home Assistant-compatible gateway.

## Regla de continuidad

El presente documento describe el **VIGENTE**. Cambios futuros no borran decisiones previas: las sustituyen dejando historial en Git/ADRs. Antes de trabajar se sincroniza este estado, los ADRs y las pruebas.
