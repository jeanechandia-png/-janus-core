const activity = document.querySelector('#activity');
const template = document.querySelector('#eventTemplate');
const connection = document.querySelector('#connection');
const voiceButton = document.querySelector('#voiceButton');
const presenceState = document.querySelector('#presenceState');
const transcript = document.querySelector('#transcript');
const command = document.querySelector('#command');
const sendButton = document.querySelector('#sendButton');
const pauseButton = document.querySelector('#pauseButton');
const clearButton = document.querySelector('#clearButton');

let currentRunId = null;
let paused = false;
let listening = false;
let recognition = null;

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
  return 'active';
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
  node.querySelector('.event-time').textContent = new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  node.querySelector('.event-summary').textContent = event.summary;
  node.querySelector('.event-detail').textContent = detailFrom(event);
  activity.append(node);
  node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  if (event.type === 'run.heard') setPresence('Escuchado', 'Te escuché. Empiezo ahora.');
  if (event.type === 'run.started' || event.type === 'run.step.started') setPresence('Trabajando', event.summary);
  if (event.type === 'tool.progress') setPresence('Procesando', event.summary);
  if (event.type === 'run.paused') setPresence('Pausado', 'La ejecución está detenida, pero la sesión sigue viva.');
  if (event.type === 'run.resumed') setPresence('Trabajando', 'Continuando desde el punto anterior.');
  if (event.type === 'run.completed') {
    setPresence('Terminado', 'Objetivo completado.');
    pauseButton.disabled = true;
  }
  if (event.type === 'run.failed' || event.type === 'run.blocked') {
    setPresence('Necesita atención', event.summary);
  }
}

const events = new EventSource('/api/events');
events.onopen = () => setConnection(true);
events.onerror = () => setConnection(false);
events.onmessage = (message) => {
  try { renderEvent(JSON.parse(message.data)); }
  catch (error) { console.error('invalid event', error); }
};

async function submit(text, inputMode = 'text') {
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
      body: JSON.stringify({ text: clean, inputMode }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'No se pudo iniciar');
    currentRunId = data.runId;
    paused = false;
    pauseButton.textContent = 'Pausar';
    pauseButton.disabled = false;
    command.value = '';
  } catch (error) {
    setPresence('Error', error.message);
  } finally {
    sendButton.disabled = false;
  }
}

sendButton.addEventListener('click', () => submit(command.value, 'text'));
command.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit(command.value, 'text');
});

pauseButton.addEventListener('click', async () => {
  if (!currentRunId) return;
  const action = paused ? 'resume' : 'pause';
  const response = await fetch(`/api/runs/${encodeURIComponent(currentRunId)}/${action}`, { method: 'POST' });
  if (!response.ok) return;
  paused = !paused;
  pauseButton.textContent = paused ? 'Continuar' : 'Pausar';
});

clearButton.addEventListener('click', () => {
  activity.classList.add('empty');
  activity.innerHTML = '<div class="empty-state">Vista limpia. El historial de ejecución sigue en Janus Core.</div>';
});

function configureSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    transcript.textContent = 'Este navegador no expone reconocimiento de voz directo. Puedes escribir el comando; el Voice Gateway nativo se conectará en la siguiente fase.';
    voiceButton.disabled = true;
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'es-ES';
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onstart = () => {
    listening = true;
    voiceButton.classList.add('listening');
    setPresence('Escuchando', 'Habla con normalidad.');
  };

  recognition.onresult = (event) => {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result[0].transcript.trim();
      if (result.isFinal) {
        transcript.textContent = text;
        submit(text, 'voice');
      } else {
        interim += `${text} `;
      }
    }
    if (interim.trim()) transcript.textContent = interim.trim();
  };

  recognition.onerror = (event) => {
    if (event.error !== 'no-speech') setPresence('Voz', `Reconocimiento: ${event.error}`);
  };

  recognition.onend = () => {
    voiceButton.classList.remove('listening');
    if (listening) {
      try { recognition.start(); }
      catch { listening = false; }
    }
  };
}

voiceButton.addEventListener('click', () => {
  if (!recognition) return;
  if (listening) {
    listening = false;
    recognition.stop();
    voiceButton.classList.remove('listening');
    setPresence('Listo', 'Micrófono en pausa. Toca para volver a escuchar.');
  } else {
    listening = true;
    try { recognition.start(); }
    catch { listening = false; }
  }
});

configureSpeechRecognition();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
