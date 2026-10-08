const orb = document.querySelector('#orb');
const trigger = document.querySelector('#orbTrigger');
const title = document.querySelector('#voiceTitle');
const subtitle = document.querySelector('#voiceSubtitle');
const audio = new Audio();
const history = [];
let active = false;
let session = 0;
let turn = 0;
let stream, context, processor, source, mutedOutput;
let pending, audioUrl, playback;
let priming = false;
let speaking = false;
let capturing = false;
let speechFrames = 0;
let lastVoice = 0;
let utteranceStart = 0;
let noise = .002;
let preRoll = [];
let samples = [];

function show(mode, text, detail = '') {
  orb.dataset.state = mode;
  title.textContent = text;
  subtitle.textContent = detail;
  trigger.setAttribute('aria-label', active ? 'Terminar conversación' : 'Comenzar conversación');
  trigger.setAttribute('aria-pressed', String(active));
}

function wav(chunks, sampleRate) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => [...text].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true);
  write(8, 'WAVE'); write(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (const sample of chunk) {
    const value = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function cancelResponse() {
  ++turn;
  pending?.abort();
  pending = null;
  if (playback) {
    history.push({ role: 'assistant', content: `${playback.text}\n[El usuario interrumpió esta respuesta antes de que terminara de reproducirse.]` });
    playback = null;
  }
  audio.pause();
  speaking = false;
}

function stop() {
  active = false;
  ++session;
  cancelResponse();
  if (processor) { processor.onaudioprocess = null; processor.disconnect(); processor = null; }
  source?.disconnect(); source = null;
  mutedOutput?.disconnect(); mutedOutput = null;
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  context?.close().catch(() => {}); context = null;
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = null;
  capturing = false; speechFrames = 0; samples = []; preRoll = [];
  show('idle', 'Tocá para conversar');
}

function onMicrophone(event) {
  if (!active) return;
  const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
  const now = performance.now();
  const rms = Math.sqrt(chunk.reduce((total, value) => total + value * value, 0) / chunk.length);
  orb.style.setProperty('--voice-energy', Math.min(rms * 6, .15));
  const threshold = speaking ? Math.max(.02, noise * 3.5) : Math.max(.006, noise * 2.8);
  const voiced = rms > threshold;
  if (!capturing) {
    preRoll.push(chunk);
    while (preRoll.length > 4) preRoll.shift();
    speechFrames = voiced ? speechFrames + 1 : 0;
    if (!voiced && !speaking) noise = Math.max(.0005, Math.min(.008, noise * .98 + rms * .02));
    if (speechFrames < (speaking ? 3 : 2)) return;
    // New speech cancels playback and any older network result immediately.
    cancelResponse();
    capturing = true; samples = preRoll.slice(); preRoll = [];
    utteranceStart = lastVoice = now;
    show('listening', 'Te escucho');
    return;
  }
  samples.push(chunk);
  if (voiced) lastVoice = now;
  if (now - lastVoice > 700 || now - utteranceStart > 25000) {
    const blob = wav(samples, context.sampleRate);
    samples = []; capturing = false; speechFrames = 0; preRoll = [];
    answer(blob, turn);
  }
}

async function readJson(path, options, signal) {
  const response = await fetch(path, { ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'No pude responder en este momento');
  return data;
}

async function answer(blob, currentTurn) {
  const controller = new AbortController();
  pending = controller;
  const current = () => active && currentTurn === turn && !controller.signal.aborted;
  try {
    show('thinking', 'Un momento');
    const form = new FormData(); form.append('file', blob, 'consulta.wav');
    const transcript = await readJson('/api/transcribe', { method: 'POST', body: form }, controller.signal);
    if (!current()) return;
    if (!transcript.text?.trim()) { pending = null; show('listening', 'Te escucho'); return; }
    // The transcript is internal context only, never rendered on screen.
    history.push({ role: 'user', content: transcript.text });
    const result = await readJson('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history.slice(-12) }),
    }, controller.signal);
    if (!current()) return;
    const response = await fetch('/api/speak', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: result.message }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'No pude generar la voz');
    }
    const voice = await response.blob();
    if (!current()) return;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(voice); audio.src = audioUrl;
    playback = { text: result.message, turn: currentTurn };
    await audio.play();
  } catch (error) {
    if (!current()) return;
    pending = null; playback = null; speaking = false;
    show('listening', error.name === 'NotAllowedError' ? 'Tocá para habilitar la voz' : 'No pude responder', error.name === 'NotAllowedError' ? '' : 'Podés intentar de nuevo');
  }
}

audio.onplaying = () => {
  if (priming || !active) return;
  speaking = true;
  speechFrames = 0; preRoll = [];
  show('speaking', 'Podés interrumpirme hablando');
};
audio.onended = () => {
  if (priming || !active) return;
  if (playback && playback.turn === turn) history.push({ role: 'assistant', content: playback.text });
  playback = null; pending = null; speaking = false; speechFrames = 0; preRoll = [];
  show('listening', 'Te escucho');
};
audio.onerror = () => { if (active && !priming) { speaking = false; playback = null; show('listening', 'No pude reproducir la voz'); } };

trigger.addEventListener('click', async () => {
  if (active) return stop();
  active = true; const currentSession = ++session;
  show('listening', 'Activando el micrófono');
  try {
    // A valid silent WAV unlocks this audio element from the user's gesture.
    priming = true;
    audio.src = URL.createObjectURL(wav([new Float32Array(1600)], 16000));
    const primeUrl = audio.src;
    const prime = audio.play().catch(() => {});
    const capture = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    await prime; audio.pause(); priming = false; URL.revokeObjectURL(primeUrl);
    if (!active || currentSession !== session) { capture.getTracks().forEach(track => track.stop()); return; }
    stream = capture; context = new AudioContext(); await context.resume();
    if (!active || currentSession !== session) return;
    source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(2048, 1, 1);
    mutedOutput = context.createGain(); mutedOutput.gain.value = 0;
    source.connect(processor); processor.connect(mutedOutput); mutedOutput.connect(context.destination);
    processor.onaudioprocess = onMicrophone;
    noise = .002;
    show('listening', 'Te escucho');
  } catch (error) {
    if (currentSession !== session) return;
    stop(); show('idle', error.name === 'NotAllowedError' ? 'Permití el micrófono para conversar' : 'No pude abrir el micrófono');
  }
});
window.addEventListener('pagehide', stop);
show('idle', 'Tocá para conversar');
