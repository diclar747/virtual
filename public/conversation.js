const orb = document.querySelector('#orb');
const trigger = document.querySelector('#orbTrigger');
const title = document.querySelector('#voiceTitle');
const subtitle = document.querySelector('#voiceSubtitle');
const audio = new Audio();
const history = [];
const UPLOAD_RATE = 16000;
const voiceSelect = document.querySelector('#voiceSelect');
// Storage can be blocked (private windows); the selector then simply starts on the default voice.
try {
  const savedVoice = localStorage.getItem('voice');
  if (savedVoice && [...voiceSelect.options].some(option => option.value === savedVoice)) voiceSelect.value = savedVoice;
} catch { /* keep the default */ }
voiceSelect.addEventListener('change', () => { try { localStorage.setItem('voice', voiceSelect.value); } catch { /* not remembered */ } });
voiceSelect.addEventListener('change', () => fetch(greetingUrl()).catch(() => {}));
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
let echo = 0;
let capturePeak = 0;
let speakingSince = 0;
let lastLoud = 0;

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

function wavBytes(chunks, inputRate) {
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
  return buffer;
}

function wav(chunks, inputRate) {
  return new Blob([wavBytes(chunks, inputRate)], { type: 'audio/wav' });
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function fromBase64(data, type) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
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
  // While the assistant talks the microphone also hears it. Its loudest recent echo is learned
  // continuously, so a voice only slightly above that echo is enough to interrupt.
  const settling = speaking && now - speakingSince < 300;
  const threshold = speaking ? Math.max(.012, noise * 3, echo * 1.6) : Math.max(.008, noise * 3);
  const voiced = !settling && rms > threshold;
  if (!capturing) {
    preRoll.push(chunk);
    while (preRoll.length > 6) preRoll.shift();
    if (voiced) { speechFrames += 1; lastLoud = now; }
    // Over the assistant's voice the user is heard in bursts, so loud frames need not be consecutive,
    // and what follows a loud frame is not learned as echo because it is probably the user.
    else if (!speaking || now - lastLoud > 250) speechFrames = 0;
    if (!voiced && speaking && now - lastLoud > 250) echo = Math.max(rms, echo * .99);
    if (!voiced && !speaking) noise = Math.max(.0005, Math.min(.02, noise * .98 + rms * .02));
    if (speechFrames < 2) return;
    capturing = true; confirmed = false; samples = preRoll.slice(); preRoll = [];
    voicedMs = speechFrames * frameMs; capturePeak = rms;
    utteranceStart = lastVoice = now;
    if (!speaking && !pending) show('listening', 'Te escucho');
    return;
  }
  samples.push(chunk);
  if (voiced) { lastVoice = now; voicedMs += frameMs; capturePeak = Math.max(capturePeak, rms); }
  // A cough, a click or a burst of echo must not cancel an answer: only sustained speech does.
  if (!confirmed && voicedMs >= (speaking || pending ? 240 : 160)) {
    confirmed = true;
    // The user paused and kept talking before the answer arrived: treat both parts as one question.
    if (pending && !speaking && resumable) samples = resumable.concat(samples);
    cancelResponse();
    show('listening', 'Te escucho');
  }
  // The question is sent after a short silence; if it was only a pause, the next words are merged in.
  if (now - lastVoice > (confirmed ? 350 : 600) || now - utteranceStart > 25000) {
    const heard = samples;
    samples = []; capturing = false; speechFrames = 0; preRoll = [];
    if (!confirmed) {
      // It was not the user after all, so it was the assistant's own voice leaking in.
      if (speaking) echo = Math.max(echo, capturePeak);
      return;
    }
    confirmed = false;
    resumable = heard;
    answer(wavBytes(heard, context.sampleRate), turn);
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

async function answer(recording, currentTurn) {
  const controller = new AbortController();
  pending = controller;
  const current = () => active && currentTurn === turn && !controller.signal.aborted;
  let question = '', reply = '', buffer = '';
  let playing = Promise.resolve(true);
  const handle = item => {
    if (item.type === 'transcript') question = item.text;
    else if (item.type === 'reply') reply = item.text;
    else if (item.type === 'error') throw new Error(item.message);
    else if (item.type === 'audio') {
      const clip = fromBase64(item.data, item.mime);
      playing = playing.then(ok => {
        if (!ok || !current()) return false;
        if (!playback) {
          // From here the question is answered, so a later pause is a new turn and not a continuation.
          resumable = null;
          history.push({ role: 'user', content: question });
          playback = { text: reply, turn: currentTurn };
        }
        return play(clip, controller.signal);
      });
      playing.catch(() => {});
    }
  };
  try {
    show('thinking', 'Un momento');
    // Transcription, answer and voice travel in one request; each clip plays as soon as it arrives.
    const response = await request('/api/turn', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: toBase64(recording), messages: history.slice(-12), voice: voiceSelect.value }),
    }, controller.signal);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'No pude responder en este momento');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line) handle(JSON.parse(line));
      }
      if (done) break;
    }
    if (!current()) return;
    // The transcript is internal context only, never rendered on screen.
    if (!question) { pending = null; resumable = null; show('listening', 'Te escucho'); return; }
    if (!await playing || !current()) return;
    if (!playback) throw new Error('No recibí la voz de la respuesta');
    history.push({ role: 'assistant', content: reply });
    playback = null; pending = null; speaking = false;
    if (!capturing) show('listening', 'Te escucho');
  } catch (error) {
    if (!current()) return;
    if (playback) history.push({ role: 'assistant', content: reply });
    pending = null; playback = null; resumable = null; speaking = false;
    show('listening', error.name === 'NotAllowedError' ? 'Tocá para habilitar la voz' : 'No pude responder', error.name === 'NotAllowedError' ? '' : 'Podés intentar de nuevo');
  }
}

function greetingText() {
  return `Soy ${voiceSelect.selectedOptions[0].dataset.article} asistente de Personal, ¿en qué le ayudo?`;
}

// A plain GET lets the service worker keep the greeting, so it plays without waiting for the network.
function greetingUrl() {
  return `/api/speak?voice=${encodeURIComponent(voiceSelect.value)}&text=${encodeURIComponent(greetingText())}`;
}

// The call opens with a fixed greeting, so the model never has to introduce itself.
async function greet() {
  const controller = new AbortController();
  pending = controller;
  const currentTurn = turn;
  const current = () => active && currentTurn === turn && !controller.signal.aborted;
  const text = greetingText();
  try {
    const response = await request(greetingUrl(), {}, controller.signal);
    if (!response.ok) throw new Error('No pude generar la voz');
    const clip = await response.blob();
    if (!current()) return;
    playback = { text, turn: currentTurn };
    if (!await play(clip, controller.signal) || !current()) return;
    history.push({ role: 'assistant', content: text });
  } catch { /* Without the greeting the conversation still works. */ }
  if (!current()) return;
  playback = null; pending = null; speaking = false;
  if (!capturing) show('listening', 'Te escucho');
}

audio.onplaying = () => {
  if (priming || !active) return;
  if (!speaking) { speakingSince = performance.now(); echo = 0; }
  speaking = true;
  if (!capturing) show('speaking', 'Podés interrumpirme hablando');
};

trigger.addEventListener('click', async () => {
  if (active) return stop();
  active = true; const currentSession = ++session;
  show('listening', 'Activando el micrófono');
  fetch('/api/warm', { method: 'POST' }).catch(() => {});
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
    if (!history.length) greet();
  } catch (error) {
    if (currentSession !== session) return;
    priming = false;
    stop(); show('idle', error.name === 'NotAllowedError' ? 'Permití el micrófono para conversar' : 'No pude abrir el micrófono');
  }
});
window.addEventListener('pagehide', stop);

// Installable app: the service worker keeps the page, fonts and greeting on the device.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(() => fetch(greetingUrl())).catch(() => {});
}
const installButton = document.querySelector('#installButton');
let installPrompt;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  installButton.hidden = false;
});
installButton.addEventListener('click', async () => {
  installButton.hidden = true;
  await installPrompt?.prompt();
  installPrompt = null;
});
window.addEventListener('appinstalled', () => { installButton.hidden = true; });
show('idle', 'Tocá para conversar');
