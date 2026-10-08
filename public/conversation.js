const orb = document.querySelector('#orb');
const trigger = document.querySelector('#orbTrigger');
const title = document.querySelector('#voiceTitle');
const subtitle = document.querySelector('#voiceSubtitle');
const audio = new Audio();
const history = [];
const UPLOAD_RATE = 16000;
let active = false;
let session = 0;
let turn = 0;
let stream, context, processor, source, mutedOutput;
let pending, audioUrl, playback;
let priming = false;
let speaking = false;
let capturing = false;
let confirmed = false;
let speechFrames = 0;
let voicedMs = 0;
let lastVoice = 0;
let utteranceStart = 0;
let noise = .002;
let preRoll = [];
let samples = [];
let resumable = null;

function show(mode, text, detail = '') {
  orb.dataset.state = mode;
  title.textContent = text;
  subtitle.textContent = detail;
  trigger.setAttribute('aria-label', active ? 'Terminar conversación' : 'Comenzar conversación');
  trigger.setAttribute('aria-pressed', String(active));
}

// Speech recognition only needs 16 kHz; sending less audio makes the upload much faster on mobile.
function downsample(chunks, sampleRate) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const input = new Float32Array(length);
  let position = 0;
  for (const chunk of chunks) { input.set(chunk, position); position += chunk.length; }
  if (sampleRate <= UPLOAD_RATE) return { data: input, sampleRate };
  const ratio = sampleRate / UPLOAD_RATE;
  const output = new Float32Array(Math.floor(length / ratio));
  for (let index = 0; index < output.length; index++) {
    const from = Math.floor(index * ratio);
    const to = Math.min(length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let cursor = from; cursor < to; cursor++) sum += input[cursor];
    output[index] = sum / Math.max(1, to - from);
  }
  return { data: output, sampleRate: UPLOAD_RATE };
}

function wav(chunks, inputRate) {
  const { data, sampleRate } = downsample(chunks, inputRate);
  const length = data.length;
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
  for (const sample of data) {
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
  resumable = null;
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
  capturing = false; confirmed = false; speechFrames = 0; voicedMs = 0; samples = []; preRoll = [];
  show('idle', 'Tocá para conversar');
}

function onMicrophone(event) {
  if (!active) return;
  const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
  const now = performance.now();
  const frameMs = chunk.length / context.sampleRate * 1000;
  const rms = Math.sqrt(chunk.reduce((total, value) => total + value * value, 0) / chunk.length);
  orb.style.setProperty('--voice-energy', Math.min(rms * 6, .15));
  // While the assistant talks the microphone also hears it, so interrupting needs a clearly louder voice.
  const threshold = speaking ? Math.max(.03, noise * 5) : Math.max(.008, noise * 3);
  const voiced = rms > threshold;
  if (!capturing) {
    preRoll.push(chunk);
    while (preRoll.length > 6) preRoll.shift();
    speechFrames = voiced ? speechFrames + 1 : 0;
    if (!voiced && !speaking) noise = Math.max(.0005, Math.min(.02, noise * .98 + rms * .02));
    if (speechFrames < 2) return;
    capturing = true; confirmed = false; samples = preRoll.slice(); preRoll = [];
    voicedMs = speechFrames * frameMs;
    utteranceStart = lastVoice = now;
    if (!speaking && !pending) show('listening', 'Te escucho');
    return;
  }
  samples.push(chunk);
  if (voiced) { lastVoice = now; voicedMs += frameMs; }
  // A cough, a click or the assistant's own echo must not cancel an answer: only sustained speech does.
  if (!confirmed && voicedMs >= (speaking ? 400 : pending ? 280 : 200)) {
    confirmed = true;
    // The user paused and kept talking before the answer arrived: treat both parts as one question.
    if (pending && !speaking && resumable) samples = resumable.concat(samples);
    cancelResponse();
    show('listening', 'Te escucho');
  }
  if (now - lastVoice > 700 || now - utteranceStart > 25000) {
    const heard = samples;
    samples = []; capturing = false; speechFrames = 0; preRoll = [];
    if (!confirmed) return;
    confirmed = false;
    resumable = heard;
    answer(wav(heard, context.sampleRate), turn);
  }
}

// AbortSignal.any/timeout are missing in older mobile browsers, where they made every turn fail.
function linkedSignal(signal, milliseconds) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, milliseconds);
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  return { signal: controller.signal, release: () => clearTimeout(timer) };
}

async function request(path, options, signal) {
  const link = linkedSignal(signal, 45000);
  try { return await fetch(path, { ...options, signal: link.signal }); }
  finally { link.release(); }
}

async function readJson(path, options, signal) {
  const response = await request(path, options, signal);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'No pude responder en este momento');
  return data;
}

async function fetchVoice(text, signal) {
  const response = await request('/api/speak', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }, signal);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'No pude generar la voz');
  }
  return response.blob();
}

// The first sentence is voiced on its own so playback starts without waiting for the whole answer.
function speechParts(text) {
  const boundary = /[.!?…]+\s+(?=[A-ZÁÉÍÓÚÑ¿¡])/g;
  let match;
  while ((match = boundary.exec(text))) {
    const end = match.index + match[0].length;
    if (end >= 25 && text.length - end >= 15) return [text.slice(0, end).trim(), text.slice(end).trim()];
  }
  return [text];
}

function play(clip, signal) {
  return new Promise((resolve, reject) => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(clip); audio.src = audioUrl;
    const settle = (finish, value) => {
      audio.onended = audio.onerror = null;
      signal.removeEventListener('abort', aborted);
      finish(value);
    };
    const aborted = () => settle(resolve, false);
    audio.onended = () => settle(resolve, true);
    audio.onerror = () => settle(reject, new Error('No pude reproducir la voz'));
    signal.addEventListener('abort', aborted, { once: true });
    audio.play().catch(error => settle(reject, error));
  });
}

async function answer(blob, currentTurn) {
  const controller = new AbortController();
  pending = controller;
  const current = () => active && currentTurn === turn && !controller.signal.aborted;
  let reply = '';
  try {
    show('thinking', 'Un momento');
    const form = new FormData(); form.append('file', blob, 'consulta.wav');
    const transcript = await readJson('/api/transcribe', { method: 'POST', body: form }, controller.signal);
    if (!current()) return;
    const question = transcript.text?.trim();
    if (!question) { pending = null; resumable = null; show('listening', 'Te escucho'); return; }
    // The transcript is internal context only, never rendered on screen.
    const result = await readJson('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [...history, { role: 'user', content: question }].slice(-12) }),
    }, controller.signal);
    if (!current()) return;
    const clips = speechParts(result.message).map(part => fetchVoice(part, controller.signal));
    clips.forEach(clip => clip.catch(() => {}));
    for (const clip of clips) {
      const voice = await clip;
      if (!current()) return;
      if (!reply) {
        // From here the question is answered, so a later pause is a new turn and not a continuation.
        reply = result.message; resumable = null;
        history.push({ role: 'user', content: question });
        playback = { text: reply, turn: currentTurn };
      }
      if (!await play(voice, controller.signal) || !current()) return;
    }
    history.push({ role: 'assistant', content: reply });
    playback = null; pending = null; speaking = false;
    if (!capturing) show('listening', 'Te escucho');
  } catch (error) {
    if (!current()) return;
    if (reply) history.push({ role: 'assistant', content: reply });
    pending = null; playback = null; resumable = null; speaking = false;
    show('listening', error.name === 'NotAllowedError' ? 'Tocá para habilitar la voz' : 'No pude responder', error.name === 'NotAllowedError' ? '' : 'Podés intentar de nuevo');
  }
}

audio.onplaying = () => {
  if (priming || !active) return;
  speaking = true;
  if (!capturing) show('speaking', 'Podés interrumpirme hablando');
};

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
    priming = false;
    stop(); show('idle', error.name === 'NotAllowedError' ? 'Permití el micrófono para conversar' : 'No pude abrir el micrófono');
  }
});
window.addEventListener('pagehide', stop);
show('idle', 'Tocá para conversar');
