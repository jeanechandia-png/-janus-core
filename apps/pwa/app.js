import { PcmTtsPlayer } from './pcm-tts-player.js';

const activity = document.querySelector('#activity');
const template = document.querySelector('#eventTemplate');
const connection = document.querySelector('#connection');
const capabilityList = document.querySelector('#capabilityList');
const voiceButton = document.querySelector('#voiceButton');
const presenceState = document.querySelector('#presenceState');
const transcript = document.querySelector('#transcript');
const command = document.querySelector('#command');
const sendButton = document.querySelector('#sendButton');
const pauseButton = document.querySelector('#pauseButton');
const stopButton = document.querySelector('#stopButton');
const clearButton = document.querySelector('#clearButton');

const storedVoiceSessionId = localStorage.getItem('janus.voiceSessionId');
const voiceSessionId = storedVoiceSessionId || `iphone_${crypto.randomUUID()}`;
if (!storedVoiceSessionId) localStorage.setItem('janus.voiceSessionId', voiceSessionId);

const PCM_MIME_TYPE = 'audio/pcm;rate=16000;channels=1;format=s16le';
const VAD_START_RMS = 0.025;
const VAD_END_RMS = 0.012;
const VAD_START_FRAMES = 2;
const VAD_END_FRAMES = 25;
const ttsPlayer = new PcmTtsPlayer();

let currentRunId = null;
let currentRunActive = false;
let paused = false;
let listening = false;
let recognition = null;
let recognitionConfigured = false;
let events = null;
let voiceMode = 'pending';
let voiceSocket = null;
let audioContext = null;
let mediaStream = null;
let captureSource = null;
let captureNode = null;
let muteNode = null;
let pcmStarting = false;
let speechActive = false;
let speechFrames = 0;
let silenceFrames = 0;
let ttsActive = false;
let pendingTtsAudioMeta = [];

function setConnection(online) {
  connection.classList.toggle('online', online);
  connection.classList.toggle('offline', !online);
  connection.lastChild.textContent = online ? ' conectado' : ' desconectado';
}

function setPresence(state, text) {
  presenceState.textContent = state;
  if (text) transcript.textContent = text;
  voiceButton.classList.toggle('working', ['Trabajando', 'Ejecutando', 'Procesando'].includes(state));
}

function detailFrom(event) {
  const payload = event.payload ?? {};
  if (typeof payload.preview === 'string') return payload.preview;
  if (typeof payload.error === 'string') return payload.error;
  if (typeof payload.percent === 'number') return `Progreso: ${payload.percent}%`;
  if (typeof payload.tool === 'string') return `Herramienta: ${payload.tool}`;
  if (typeof payload.goal === 'string') return payload.goal;
  return '';
}

function eventState(type) {
  if (type.includes('failed')) return 'error';
  if (type.includes('blocked') || type.includes('approval')) return 'alert';
  if (type.includes('completed') || type === 'artifact.updated') return 'done';
  if (type.includes('cancelled')) return 'alert';
  return 'active';
}

function setRunControls(active) {
  currentRunActive = active;
  pauseButton.disabled = !active;
  stopButton.disabled = !active;
  if (!active) {
    paused = false;
    pauseButton.textContent = 'Pausar';
  }
}

function renderEvent(event) {
  if (currentRunId && event.runId !== currentRunId) return;
  if (activity.classList.contains('empty')) {
    activity.classList.remove('empty');
    activity.innerHTML = '';
  }

  const detail = detailFrom(event);
  const node = template.content.firstElementChild.cloneNode(true);
  node.dataset.state = eventState(event.type);
  node.querySelector('.event-source').textContent = `${event.source} · ${event.type}`;
  node.querySelector('.event-time').textContent = new Date(event.at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  node.querySelector('.event-summary').textContent = event.summary;
  node.querySelector('.event-detail').textContent = detail;
  activity.append(node);
  node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  if (event.type === 'run.heard') setPresence('Escuchado', 'Te escuché. Empiezo ahora.');
  if (event.type === 'run.started' || event.type === 'run.step.started') setPresence('Trabajando', event.summary);
  if (event.type === 'tool.progress') setPresence('Procesando', event.summary);
  if (event.type === 'run.paused') {
    paused = true;
    pauseButton.textContent = 'Continuar';
    setPresence('Pausado', 'La ejecución está detenida, pero la sesión sigue viva.');
  }
  if (event.type === 'run.resumed') {
    paused = false;
    pauseButton.textContent = 'Pausar';
    setPresence('Trabajando', 'Continuando desde el punto anterior.');
  }
  if (event.type === 'run.completed') {
    setPresence('Terminado', 'Objetivo completado.');
    setRunControls(false);
  }
  if (event.type === 'run.cancelled') {
    setPresence('Detenido', 'Ejecución detenida por tu orden.');
    setRunControls(false);
  }
  if (event.type === 'run.failed' || event.type === 'run.blocked') {
    setPresence('Necesita atención', detail || event.summary);
    setRunControls(false);
    void checkHealth();
  }
}

function connectEvents(runId) {
  events?.close();
  const query = runId ? `?runId=${encodeURIComponent(runId)}` : '';
  events = new EventSource(`/api/events${query}`);
  events.onopen = () => setConnection(true);
  events.onerror = () => setConnection(false);
  events.onmessage = (message) => {
    try {
      renderEvent(JSON.parse(message.data));
    } catch (error) {
      console.error('invalid event', error);
    }
  };
}

function renderCapabilities(capabilities) {
  capabilityList.innerHTML = '';
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    capabilityList.textContent = 'No hay herramientas registradas.';
    capabilityList.classList.add('capability-empty');
    return;
  }

  capabilityList.classList.remove('capability-empty');
  const grouped = new Map();
  for (const item of capabilities) {
    if (!item || typeof item.tool !== 'string' || typeof item.action !== 'string') continue;
    const group = grouped.get(item.tool) ?? { tool: item.tool, actions: [], states: [], reasons: [] };
    group.actions.push(item.action);
    group.states.push(item.state);
    if (typeof item.reason === 'string' && item.reason.trim()) group.reasons.push(item.reason.trim());
    grouped.set(item.tool, group);
  }

  for (const group of grouped.values()) {
    const state = aggregateCapabilityState(group.states);
    const row = document.createElement('div');
    row.className = 'capability-row';
    row.dataset.state = state;

    const copy = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'capability-name';
    name.textContent = capabilityToolName(group.tool);
    const detail = document.createElement('div');
    detail.className = 'capability-detail';
    detail.textContent = group.reasons[0] ?? `${group.actions.length} acción${group.actions.length === 1 ? '' : 'es'} registrada${group.actions.length === 1 ? '' : 's'}`;
    copy.append(name, detail);

    const badge = document.createElement('div');
    badge.className = 'capability-badge';
    badge.textContent = capabilityStateLabel(state);
    row.append(copy, badge);
    capabilityList.append(row);
  }
}

function aggregateCapabilityState(states) {
  const priority = ['disabled', 'needs_auth', 'unavailable', 'available'];
  return priority.find((state) => states.includes(state)) ?? 'unavailable';
}

function capabilityToolName(tool) {
  if (tool === 'google-workspace') return 'Google Workspace';
  if (tool === 'github') return 'GitHub';
  return tool;
}

function capabilityStateLabel(state) {
  if (state === 'available') return 'Disponible';
  if (state === 'needs_auth') return 'Autorizar';
  if (state === 'disabled') return 'Desactivado';
  return 'No disponible';
}

function supportsPcmStreaming() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  return Boolean(
    window.WebSocket
    && navigator.mediaDevices?.getUserMedia
    && AudioContextClass
    && window.AudioWorkletNode,
  );
}

function configureVoiceMode(health) {
  const streamingState = health?.voice?.streaming?.state;
  if (streamingState === 'available' && supportsPcmStreaming()) {
    voiceMode = 'pcm-stream';
    voiceButton.disabled = false;
    if (!listening) {
      setPresence('Listo', 'Voz PCM streaming lista. Toca el núcleo y habla con Janus.');
    }
    return;
  }

  if (!recognitionConfigured) configureSpeechRecognition();
  if (voiceMode === 'pending') voiceMode = recognition ? 'browser-fallback' : 'text-only';
}

async function checkHealth() {
  try {
    const response = await fetch('/health', { cache: 'no-store' });
    setConnection(response.ok);
    if (!response.ok) throw new Error('Core no disponible');
    const health = await response.json();
    renderCapabilities(health.capabilities);
    configureVoiceMode(health);
    return health;
  } catch {
    setConnection(false);
    renderCapabilities([]);
    if (!recognitionConfigured) configureSpeechRecognition();
    return null;
  }
}

function activateRun(runId) {
  currentRunId = runId;
  paused = false;
  setRunControls(true);
  connectEvents(runId);
}

async function submit(text) {
  const clean = text.trim();
  if (!clean) return;

  activity.classList.remove('empty');
  activity.innerHTML = '';
  setPresence('Enviando', clean);
  sendButton.disabled = true;

  try {
    const response = await fetch('/api/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: clean, inputMode: 'text' }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'No se pudo iniciar');
    activateRun(data.runId);
    command.value = '';
  } catch (error) {
    setPresence('Error', error?.message ?? String(error));
  } finally {
    sendButton.disabled = false;
  }
}

async function submitVoice(text) {
  const clean = text.trim();
  if (!clean) return;

  try {
    const response = await fetch('/api/voice/utterance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: voiceSessionId,
        text: clean,
        final: true,
        language: 'es-ES',
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'No se pudo procesar la voz');

    if (data.result?.kind === 'task' && data.result.runId) {
      activity.classList.remove('empty');
      activity.innerHTML = '';
      activateRun(data.result.runId);
    }
  } catch (error) {
    setPresence('Voz', error?.message ?? String(error));
  }
}

async function controlRun(action) {
  if (!currentRunId || !currentRunActive) return;
  const response = await fetch(`/api/runs/${encodeURIComponent(currentRunId)}/${action}`, { method: 'POST' });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    setPresence('Control', data.error ?? 'No se pudo controlar la ejecución.');
  }
}

async function syncMicrophone(state) {
  try {
    await fetch('/api/voice/microphone', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: voiceSessionId, state }),
    });
  } catch {
    // El fallback puede seguir intentando recuperar la conexión de voz.
  }
}

function voiceSocketUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/api/voice/stream`;
}

async function connectPcmSocket() {
  const socket = new WebSocket(voiceSocketUrl());
  socket.binaryType = 'arraybuffer';
  voiceSocket = socket;
  socket.addEventListener('message', handleVoiceStreamMessage);
  socket.addEventListener('close', () => {
    if (voiceSocket === socket) voiceSocket = null;
    ttsPlayer.interrupt();
    pendingTtsAudioMeta = [];
    if (listening && voiceMode === 'pcm-stream') {
      void stopPcmVoice({ preserveMessage: true });
      setPresence('Voz desconectada', 'El canal de voz se cerró. La tarea activa sigue en Janus Core.');
    }
  });

  await waitForSocketOpen(socket);
  socket.send(JSON.stringify({
    type: 'hello',
    version: 1,
    sessionId: voiceSessionId,
    audio: { mimeType: PCM_MIME_TYPE },
  }));
  await waitForVoiceReady(socket);
  return socket;
}

function waitForSocketOpen(socket) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Tiempo agotado al abrir el canal de voz.')), 5000);
    const onOpen = () => {
      clearTimeout(timer);
      socket.removeEventListener('error', onError);
      resolve();
    };
    const onError = () => {
      clearTimeout(timer);
      socket.removeEventListener('open', onOpen);
      reject(new Error('No se pudo abrir el canal de voz.'));
    };
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
  });
}

function waitForVoiceReady(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error('Voice Gateway no confirmó disponibilidad.'));
    }, 5000);
    const onMessage = (event) => {
      if (typeof event.data !== 'string') return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'ready') {
        clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        resolve(message);
      } else if (message.type === 'error') {
        clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        reject(new Error(message.message ?? 'Voice Gateway no disponible.'));
      }
    };
    socket.addEventListener('message', onMessage);
  });
}

function handleVoiceStreamMessage(event) {
  if (typeof event.data !== 'string') {
    const meta = pendingTtsAudioMeta.shift();
    if (!meta || !(event.data instanceof ArrayBuffer)) return;
    void ttsPlayer.enqueue(event.data, meta.mimeType).catch((error) => {
      setPresence('Audio', error?.message ?? String(error));
    });
    return;
  }

  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }

  if (message.type === 'transcript.partial' && typeof message.text === 'string') {
    transcript.textContent = message.text;
    return;
  }
  if (message.type === 'transcript.final' && typeof message.text === 'string') {
    transcript.textContent = message.text;
    return;
  }
  if (message.type === 'session.action' && message.result?.kind === 'task' && message.result.runId) {
    activity.classList.remove('empty');
    activity.innerHTML = '';
    activateRun(message.result.runId);
    return;
  }
  if (message.type === 'speech.started') {
    ttsActive = true;
    setPresence('Janus hablando', 'Puedes interrumpir hablando; la tarea no se detendrá.');
    return;
  }
  if (message.type === 'speech.audio' && typeof message.mimeType === 'string') {
    pendingTtsAudioMeta.push({
      sequence: message.sequence,
      mimeType: message.mimeType,
      byteLength: message.byteLength,
    });
    return;
  }
  if (message.type === 'speech.interrupted') {
    ttsActive = false;
    ttsPlayer.interrupt();
    pendingTtsAudioMeta = [];
    if (listening) setPresence('Escuchando', 'Interrupción aplicada. Canal de voz activo.');
    return;
  }
  if (message.type === 'speech.completed') {
    ttsActive = false;
    if (listening) setPresence('Escuchando', 'Canal de voz activo.');
    return;
  }
  if (message.type === 'voice.error' || message.type === 'error') {
    setPresence('Voz', message.message ?? 'El canal de voz informó un error.');
  }
}

async function startPcmVoice() {
  if (pcmStarting || listening) return;
  pcmStarting = true;
  voiceButton.disabled = true;
  setPresence('Conectando voz', 'Abriendo canal PCM seguro con Janus Core…');

  try {
    const socket = await connectPcmSocket();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass({ sampleRate: 16000, latencyHint: 'interactive' });
    await audioContext.audioWorklet.addModule('/pcm-capture-worklet.js');

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    captureSource = audioContext.createMediaStreamSource(mediaStream);
    captureNode = new AudioWorkletNode(audioContext, 'janus-pcm-capture', {
      processorOptions: { targetSampleRate: 16000, frameMs: 20 },
    });
    muteNode = audioContext.createGain();
    muteNode.gain.value = 0;
    captureSource.connect(captureNode).connect(muteNode).connect(audioContext.destination);
    captureNode.port.onmessage = (event) => handlePcmFrame(event, socket);
    await audioContext.resume();

    listening = true;
    speechActive = false;
    speechFrames = 0;
    silenceFrames = 0;
    voiceButton.classList.add('listening');
    setPresence('Escuchando', 'PCM16 · 16 kHz · mono. La sesión permanece en Janus Core.');
  } catch (error) {
    await stopPcmVoice({ preserveMessage: true });
    setPresence('Voz', error?.message ?? String(error));
  } finally {
    pcmStarting = false;
    voiceButton.disabled = false;
  }
}

function handlePcmFrame(event, socket) {
  const data = event.data;
  if (!data || data.type !== 'pcm' || !(data.pcm instanceof ArrayBuffer)) return;
  if (!listening || socket.readyState !== WebSocket.OPEN) return;

  updateLocalVad(Number(data.rms), socket);
  socket.send(data.pcm);
}

function updateLocalVad(rms, socket) {
  const level = Number.isFinite(rms) ? rms : 0;
  if (!speechActive) {
    speechFrames = level >= VAD_START_RMS ? speechFrames + 1 : 0;
    if (speechFrames >= VAD_START_FRAMES) {
      speechActive = true;
      silenceFrames = 0;
      if (ttsActive) {
        ttsPlayer.interrupt();
        pendingTtsAudioMeta = [];
        setPresence('Interrumpiendo', 'Te escucho; corto la salida de voz y mantengo la tarea activa.');
      }
      socket.send(JSON.stringify({ type: 'speech.start' }));
    }
    return;
  }

  if (level <= VAD_END_RMS) {
    silenceFrames += 1;
  } else {
    silenceFrames = 0;
  }

  if (silenceFrames >= VAD_END_FRAMES) {
    speechActive = false;
    speechFrames = 0;
    silenceFrames = 0;
    socket.send(JSON.stringify({ type: 'speech.end' }));
  }
}

async function stopPcmVoice(options = {}) {
  listening = false;
  voiceButton.classList.remove('listening');

  const socket = voiceSocket;
  if (socket?.readyState === WebSocket.OPEN && speechActive) {
    socket.send(JSON.stringify({ type: 'speech.end' }));
  }
  speechActive = false;
  speechFrames = 0;
  silenceFrames = 0;
  ttsActive = false;
  ttsPlayer.interrupt();
  pendingTtsAudioMeta = [];

  captureNode?.disconnect();
  captureSource?.disconnect();
  muteNode?.disconnect();
  captureNode = null;
  captureSource = null;
  muteNode = null;

  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
    mediaStream = null;
  }

  if (audioContext) {
    await audioContext.close().catch(() => undefined);
    audioContext = null;
  }

  if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'microphone paused');
  if (voiceSocket === socket) voiceSocket = null;

  if (!options.preserveMessage) {
    setPresence('Listo', 'Micrófono en pausa. La tarea activa puede seguir trabajando.');
  }
}

sendButton.addEventListener('click', () => submit(command.value));
command.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit(command.value);
});

pauseButton.addEventListener('click', () => controlRun(paused ? 'resume' : 'pause'));
stopButton.addEventListener('click', () => controlRun('cancel'));

clearButton.addEventListener('click', () => {
  activity.classList.add('empty');
  activity.innerHTML = '<div class="empty-state">Vista limpia. El historial de ejecución sigue guardado en Janus Core.</div>';
});

function configureSpeechRecognition() {
  if (recognitionConfigured) return;
  recognitionConfigured = true;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    voiceMode = 'text-only';
    transcript.textContent = 'El Voice Gateway local aún no está disponible y este navegador no ofrece fallback de reconocimiento. Puedes usar texto.';
    voiceButton.disabled = true;
    return;
  }

  voiceMode = 'browser-fallback';
  recognition = new SpeechRecognition();
  recognition.lang = 'es-ES';
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onstart = () => {
    listening = true;
    void syncMicrophone('connected');
    voiceButton.classList.add('listening');
    setPresence('Escuchando', 'Fallback del navegador activo; Janus migrará a PCM local cuando el Voice Gateway esté disponible.');
  };

  recognition.onresult = (event) => {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result[0].transcript.trim();
      if (result.isFinal) {
        transcript.textContent = text;
        void submitVoice(text);
      } else {
        interim += `${text} `;
      }
    }
    if (interim.trim()) transcript.textContent = interim.trim();
  };

  recognition.onerror = (event) => {
    if (event.error !== 'no-speech') {
      setPresence('Reconectando voz', `Micrófono: ${event.error}. Janus mantiene la ejecución activa.`);
    }
  };

  recognition.onend = () => {
    voiceButton.classList.remove('listening');
    if (listening) {
      try {
        recognition.start();
      } catch {
        listening = false;
        void syncMicrophone('disconnected');
      }
    } else {
      void syncMicrophone('disconnected');
    }
  };
}

voiceButton.addEventListener('click', () => {
  if (voiceMode === 'pcm-stream') {
    if (listening) {
      void stopPcmVoice();
    } else {
      void startPcmVoice();
    }
    return;
  }

  if (!recognition) return;
  if (listening) {
    listening = false;
    recognition.stop();
    voiceButton.classList.remove('listening');
    void syncMicrophone('disconnected');
    setPresence('Listo', 'Micrófono en pausa. La tarea activa puede seguir trabajando.');
  } else {
    listening = true;
    try {
      recognition.start();
    } catch {
      listening = false;
      setPresence('Voz', 'No se pudo abrir el micrófono. La ejecución de Janus sigue disponible por texto.');
    }
  }
});

void checkHealth();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
