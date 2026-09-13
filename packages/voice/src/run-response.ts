import type { JanusEvent, RunSnapshot } from '../../core/src/events.js';

const MAX_SPOKEN_PREVIEW_CHARS = 420;

export function safeSpokenRunSummary(
  snapshot: RunSnapshot,
  events: readonly JanusEvent[],
): string | undefined {
  if (snapshot.status === 'cancelled') return undefined;

  const preview = latestSafePreview(events);
  if (snapshot.status === 'completed') {
    return preview ? `Listo. ${preview}` : 'Listo. La tarea terminó.';
  }
  if (snapshot.status === 'blocked') {
    return preview
      ? `La tarea necesita atención. ${preview}`
      : 'La tarea necesita atención antes de continuar.';
  }
  if (snapshot.status === 'failed') {
    return 'La tarea terminó con un error y necesita revisión.';
  }
  return undefined;
}

function latestSafePreview(events: readonly JanusEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'artifact.updated') continue;
    const preview = event.payload?.preview;
    if (typeof preview !== 'string') continue;
    const clean = sanitizeForSpeech(preview);
    if (clean) return clean;
  }
  return undefined;
}

export function sanitizeForSpeech(value: string): string {
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  if (clean.length <= MAX_SPOKEN_PREVIEW_CHARS) return clean;
  return `${clean.slice(0, MAX_SPOKEN_PREVIEW_CHARS - 1).trimEnd()}…`;
}
