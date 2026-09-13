const activity = document.querySelector('#activity');
const template = document.querySelector('#eventTemplate');
const connection = document.querySelector('#connection');
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

let currentRunId = null;
let currentRunActive = false;
let paused = false;
let listening = false;
let recognition = null;
let events = null;

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
  if (typeof payload.percent === 'number') return `Progreso: ${payload.percent}%`;
  if (typeof payload.tool === 'string') return `Herramienta: ${payload.tool}`;
  if (typeof payload.error === 'string') return payload.error;
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

  const node = template.content.firstElementChild.cloneNode(true);
  node.dataset.state = eventState(event.type);
  node.querySelector('.event-source').textContent = `${event.source} · ${event.type}`;
  node.querySelector('.event-time').textContent = new Date(event.at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  node.querySelector('.event-summary').textContent = event.summary;
  node.querySelector('.event-detail').textContent = detailFrom(event);
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
    setPresence('Necesita atención', event.summary);
    setRunControls(false);
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

async function checkHealth() {
  try {
    const response = await fetch('/health', { cache: 'no-store' });
    setConnection(response.ok);
  } catch {
    setConnection(false);
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
    setPresence('Error', error.message);
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
    setPresence('Voz', error.message);
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
    // La UI puede seguir intentando recuperar la conexión de voz.
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
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    transcript.textContent = 'Este navegador no expone reconocimiento de voz directo. Puedes escribir el comando; el Voice Gateway streaming sustituirá este prototipo.';
    voiceButton.disabled = true;
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'es-ES';
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onstart = () => {
    listening = true;
    void syncMicrophone('connected');
    voiceButton.classList.add('listening');
    setPresence('Escuchando', 'Habla con normalidad. La ejecución no necesita salir del modo de voz.');
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

configureSpeechRecognition();
checkHealth();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
