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
voiceSelect.addEventListener('change', () => {
  try { localStorage.setItem(liveVoice ? 'liveVoice' : 'voice', voiceSelect.value); } catch { /* not remembered */ }
  // A live conversation keeps its voice until it reconnects, so changing it reconnects at once.
  if (liveVoice) { if (call) { stop(); start(); } } else fetch(greetingUrl()).catch(() => {});
});
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

// Live transcription. Where the browser can recognise speech by itself (Chrome on a computer),
// the words are written while they are being said, so the turn is sent as text the moment the
// person stops and the separate transcription step (about a second and a half) disappears.
// Phones keep sending the recording: there the recogniser fights the microphone we already hold.
const LiveRecognition = !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) && (window.SpeechRecognition || window.webkitSpeechRecognition);
let live = null;
let liveOk = Boolean(LiveRecognition);
let liveFailures = 0;
let liveFinals = [];
let liveInterim = '';
let liveAt = 0;
let liveSince = 0;
let liveMark = 0;
let captureLive = false;
let settling = false;

function liveStart() {
  if (!liveOk || live) return;
  const recognizer = new LiveRecognition();
  recognizer.lang = 'es-PY'; recognizer.continuous = true; recognizer.interimResults = true;
  recognizer.onresult = event => {
    if (live !== recognizer) return;
    liveFinals = []; liveInterim = '';
    for (const result of event.results) { if (result.isFinal) liveFinals.push(result[0].transcript); else liveInterim += result[0].transcript; }
    liveAt = performance.now(); liveFailures = 0;
  };
  recognizer.onerror = event => {
    // Without permission or without the recognition service there is no point in retrying.
    if (['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(event.error) || (event.error === 'network' && ++liveFailures >= 2)) liveOk = false;
  };
  recognizer.onend = () => { if (live === recognizer) live = null; };
  // A recogniser that restarts in the middle of a sentence has lost its beginning.
  liveFinals = []; liveInterim = ''; liveMark = 0; captureLive = false;
  try { recognizer.start(); live = recognizer; liveSince = performance.now(); } catch { liveOk = false; }
}

function liveStop() {
  const recognizer = live;
  live = null;
  try { recognizer?.abort(); } catch { /* already stopped */ }
}

function liveText() {
  return [...liveFinals.slice(liveMark), liveInterim].join(' ').replace(/\s+/g, ' ').trim();
}

// It listens only while the assistant is silent, so it never transcribes the assistant's own voice.
setInterval(() => { if (active && !call && !speaking && (!pending || settling)) liveStart(); else liveStop(); }, 200);

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
  endCall();
  settling = false; liveStop();
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
    // Only trust the live transcript if the recogniser was already listening before these words.
    captureLive = Boolean(live) && !speaking && !pending && now - liveSince > 400; liveMark = liveFinals.length;
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
    answer(wavBytes(heard, context.sampleRate), turn, captureLive);
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

async function answer(recording, currentTurn, useLive = false) {
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
    let said = '';
    if (useLive) {
      // Give the recogniser a moment to write the last word, then take what it heard.
      settling = true;
      const since = performance.now();
      while (performance.now() - liveAt < 250 && performance.now() - since < 500) await new Promise(resolve => setTimeout(resolve, 50));
      said = liveText();
      settling = false;
      if (!current()) return;
    }
    // Transcription, answer and voice travel in one request; each clip plays as soon as it arrives.
    // With a live transcript the text goes instead of the recording and nothing is transcribed.
    const response = await request('/api/turn', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(said ? { text: said } : { audio: toBase64(recording) }), messages: history.slice(-12), voice: voiceSelect.value }),
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
    pending = null; playback = null; resumable = null; speaking = false; settling = false;
    show('listening', error.name === 'NotAllowedError' ? 'Tocá para habilitar la voz' : 'No pude responder', error.name === 'NotAllowedError' ? '' : 'Podés intentar de nuevo');
  }
}


// ───────── Live voice (speech-to-speech) ─────────
// When the server has a live voice model, the browser connects to it directly over WebRTC: the
// model hears the microphone, answers with its own voice and stops when interrupted, with no
// transcription or separate voice step in between. The turn-by-turn code above stays as the
// fallback for when live voice is not configured or fails to connect.
const LIVE_VOICES = { marin: 'Marin · mujer', cedar: 'Cedar · hombre', coral: 'Coral · mujer', sage: 'Sage · mujer', shimmer: 'Shimmer · mujer', ballad: 'Ballad · hombre', ash: 'Ash · hombre', verse: 'Verse · hombre', alloy: 'Alloy · neutra', echo: 'Echo · hombre' };
let liveVoice = false;       // the server offers live voice
let call = null;             // the open live connection, if any

function useLiveVoices(voices) {
  liveVoice = true;
  voiceSelect.innerHTML = '';
  for (const voice of voices) { const option = new Option(LIVE_VOICES[voice] || voice, voice); option.dataset.article = /hombre/.test(option.text) ? 'el' : 'la'; voiceSelect.add(option); }
  try { const saved = localStorage.getItem('liveVoice'); if (saved && voices.includes(saved)) voiceSelect.value = saved; } catch { /* default voice */ }
}

function endCall() {
  const open = call;
  call = null;
  if (!open) return;
  clearTimeout(open.idle); cancelAnimationFrame(open.frame);
  try { open.channel.close(); } catch { /* already closed */ }
  open.capture.getTracks().forEach(track => track.stop());
  open.meter?.close().catch(() => {});
  open.connection.close();
  open.player.srcObject = null;
}

// Returns true when the live conversation is up; false tells the caller to use the fallback.
async function startCall(currentSession) {
  const stillWanted = () => active && currentSession === session;
  let capture;
  try {
    capture = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  } catch (error) {
    if (stillWanted()) { stop(); show('idle', error.name === 'NotAllowedError' ? 'Permití el micrófono para conversar' : 'No pude abrir el micrófono', 'Después tocá el círculo'); }
    return true;
  }
  if (!stillWanted()) { capture.getTracks().forEach(track => track.stop()); return true; }
  const connection = new RTCPeerConnection();
  const player = new Audio();
  player.autoplay = true;
  const channel = connection.createDataChannel('oai-events');
  const open = call = { connection, channel, capture, player, idle: 0, frame: 0, meter: null, greeted: false };
  const send = event => { if (channel.readyState === 'open') channel.send(JSON.stringify(event)); };
  // A forgotten open tab must not keep a paid session running.
  const touch = () => { clearTimeout(open.idle); open.idle = setTimeout(() => { if (call === open) { stop(); show('idle', 'Tocá para conversar', 'Pausé la conversación por inactividad'); } }, 180000); };
  try {
    connection.ontrack = event => {
      player.srcObject = event.streams[0];
      player.play().catch(error => { if (error.name === 'NotAllowedError' && call === open) { stop(); show('idle', 'Tocá para conversar'); } });
    };
    // The microphone stays closed until the welcome has been said: otherwise the model hears its
    // own voice or the room through the speakers, takes it for an interruption and never greets.
    const greeting = !history.length;
    capture.getTracks().forEach(track => { track.enabled = !greeting; connection.addTrack(track, capture); });
    open.listen = () => capture.getTracks().forEach(track => { track.enabled = true; });
    if (greeting) setTimeout(() => open.listen(), 12000);
    const [credential] = await Promise.all([
      fetch('/api/realtime/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice: voiceSelect.value }) }).then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'sin sesión'); return data; }),
      connection.createOffer().then(offer => connection.setLocalDescription(offer)),
    ]);
    const answer = await fetch('https://api.openai.com/v1/realtime/calls', { method: 'POST', body: connection.localDescription.sdp, headers: { Authorization: `Bearer ${credential.value}`, 'Content-Type': 'application/sdp' } });
    if (!answer.ok) throw new Error(`El modelo de voz respondió ${answer.status}`);
    await connection.setRemoteDescription({ type: 'answer', sdp: await answer.text() });
    if (call !== open || !stillWanted()) { if (call === open) endCall(); return true; }
  } catch {
    if (call === open) endCall();
    return false;
  }

  channel.onopen = () => {
    // Coming back to the app continues the same talk: what was said before is handed to the new session.
    for (const message of history.slice(-10)) send({ type: 'conversation.item.create', item: { type: 'message', role: message.role, content: [{ type: message.role === 'user' ? 'input_text' : 'output_text', text: message.content }] } });
    if (!history.length) send({ type: 'response.create', response: { instructions: `Saludá diciendo exactamente esto, con calidez, y nada más: "${greetingText()}"` } });
    show(history.length ? 'listening' : 'thinking', history.length ? 'Te escucho' : 'Un momento');
    touch();
  };
  channel.onmessage = async message => {
    if (call !== open) return;
    const event = JSON.parse(message.data);
    if (event.type === 'input_audio_buffer.speech_started') { touch(); show('listening', 'Te escucho'); }
    else if (event.type === 'input_audio_buffer.speech_stopped') show('thinking', 'Un momento');
    else if (event.type === 'output_audio_buffer.started') { touch(); show('speaking', 'Podés interrumpirme hablando'); }
    else if (event.type === 'output_audio_buffer.stopped' || event.type === 'output_audio_buffer.cleared') { open.listen(); show('listening', 'Te escucho'); }
    else if (event.type === 'conversation.item.input_audio_transcription.completed' && event.transcript?.trim()) history.push({ role: 'user', content: event.transcript.trim() });
    else if (event.type === 'response.output_audio_transcript.done' && event.transcript?.trim()) history.push({ role: 'assistant', content: event.transcript.trim() });
    else if (event.type === 'response.done') {
      // The model asked to look something up: fetch it from our database and let it answer.
      const lookups = (event.response?.output || []).filter(item => item.type === 'function_call' && item.name === 'buscar_informacion');
      if (!lookups.length) return;
      for (const lookup of lookups) {
        let text = 'No se pudo consultar la información en este momento.';
        try {
          const question = JSON.parse(lookup.arguments || '{}').consulta || '';
          const response = await fetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, thread: history.slice(-4).map(entry => entry.content).join(' ') }) });
          const data = await response.json();
          if (response.ok && data.text) text = data.text;
        } catch { /* the model is told the lookup failed */ }
        send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: lookup.call_id, output: text } });
      }
      send({ type: 'response.create' });
    }
  };
  connection.onconnectionstatechange = () => {
    if (call === open && ['failed', 'closed', 'disconnected'].includes(connection.connectionState)) { stop(); show('idle', 'Tocá para conversar', 'Se cortó la conexión'); }
  };
  // The ring moves with the person's voice.
  try {
    open.meter = new AudioContext();
    const analyser = open.meter.createAnalyser(); analyser.fftSize = 1024;
    open.meter.createMediaStreamSource(capture).connect(analyser);
    const levels = new Float32Array(analyser.fftSize);
    const draw = () => {
      if (call !== open) return;
      analyser.getFloatTimeDomainData(levels);
      orb.style.setProperty('--voice-energy', Math.min(Math.sqrt(levels.reduce((total, value) => total + value * value, 0) / levels.length) * 6, .15));
      open.frame = requestAnimationFrame(draw);
    };
    draw();
  } catch { /* the conversation works without the animation */ }
  show('listening', 'Conectando');
  return true;
}

// The greeting is one of the prompts kept in the database; this text is only the fallback.
let greetingTemplate = 'Hola, {saludo}. Bienvenido, soy {articulo} asistente virtual de Personal. ¿En qué puedo ayudarte?';
const greetingLoaded = fetch('/api/config').then(response => response.json())
  .then(config => { if (config.greeting) greetingTemplate = config.greeting; if (config.realtime && window.RTCPeerConnection) useLiveVoices(config.realtimeVoices); }).catch(() => {});

function greetingText() {
  const hour = new Date().getHours();
  const timeOfDay = hour >= 5 && hour < 12 ? 'buenos días' : hour >= 12 && hour < 19 ? 'buenas tardes' : 'buenas noches';
  return greetingTemplate.replace('{saludo}', timeOfDay).replace('{articulo}', voiceSelect.selectedOptions[0].dataset.article);
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
  } catch (error) {
    // Opened without a tap, this browser refuses to play sound: one tap is needed after all.
    if (error.name === 'NotAllowedError' && current()) { stop(); show('idle', 'Tocá para conversar'); return; }
    /* Any other failure: without the greeting the conversation still works. */
  }
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

// Starts the conversation: opens the microphone, greets and listens. It runs by itself when the
// app opens and stops by itself when the app is closed or hidden, so nobody has to press anything.
// On those automatic starts the browser may still demand a tap; the page then asks for it.
async function start() {
  if (active) return;
  active = true; const currentSession = ++session;
  show('listening', 'Activando el micrófono');
  if (liveVoice && await startCall(currentSession)) return;
  if (!active || currentSession !== session) return;
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
    stream = capture; context = new AudioContext();
    // Without a tap some browsers keep audio suspended and never settle this promise.
    await Promise.race([context.resume(), new Promise(resolve => setTimeout(resolve, 1200))]);
    if (!active || currentSession !== session) return;
    if (context.state !== 'running') { stop(); show('idle', 'Tocá para conversar'); return; }
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
    stop(); show('idle', error.name === 'NotAllowedError' ? 'Permití el micrófono para conversar' : 'No pude abrir el micrófono', 'Después tocá el círculo');
  }
}

trigger.addEventListener('click', () => (active ? stop() : start()));
// Closing the app, switching to another one or locking the phone ends the listening at once;
// coming back picks the conversation up again.
window.addEventListener('pagehide', stop);
document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
greetingLoaded.then(() => { if (!document.hidden) start(); });

// Installable app: the service worker keeps the page, fonts and greeting on the device.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(() => greetingLoaded).then(() => { if (!liveVoice) fetch(greetingUrl()); }).catch(() => {});
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
show('idle', 'Abriendo el asistente');
