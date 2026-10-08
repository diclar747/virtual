const orb = document.querySelector('#orb');
const trigger = document.querySelector('#orbTrigger');
const title = document.querySelector('#voiceTitle');
const subtitle = document.querySelector('#voiceSubtitle');
const audio = new Audio();
const messages = [];
let active = false, generation = 0, recorder, stream, context, frame, audioUrl;
let starting = false;
function status(mode, text, detail = '') {
  orb.dataset.state = mode; title.textContent = text; subtitle.textContent = detail;
  trigger.setAttribute('aria-label', active ? 'Terminar conversación' : 'Comenzar conversación');
  trigger.setAttribute('aria-pressed', String(active));
}
function stopCapture() {
  clearInterval(frame);
  if (recorder?.state === 'recording') recorder.stop();
  stream?.getTracks().forEach(t => t.stop());
  if (context) { context.close().catch(() => {}); context = null; }
}
function end() { active = false; ++generation; audio.pause(); stopCapture(); status('idle', 'Tocá para conversar'); }
function fail(text) { end(); status('idle', text, 'Tocá la esfera para intentar de nuevo'); }
async function listen() {
  if (!active || starting || recorder?.state === 'recording') return;
  starting = true;
  const turn = generation;
  try {
    const capture = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (!active || turn !== generation) { capture.getTracks().forEach(t => t.stop()); starting = false; return; }
    stream = capture; context = new AudioContext(); await context.resume();
    const meter = context.createAnalyser(); meter.fftSize = 2048;
    context.createMediaStreamSource(stream).connect(meter);
    const chunks = []; const current = recorder = new MediaRecorder(stream);
    current.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    current.onstop = () => { if (active && turn === generation && chunks.length) respond(new Blob(chunks, { type: current.mimeType }), turn); };
    current.start(); starting = false; status('listening', 'Te escucho', 'Tocá la esfera para terminar');
    const samples = new Float32Array(meter.fftSize);
    let heard = false, soundFrames = 0, lastSound = performance.now(); const started = lastSound;
    status('listening', 'Te escucho', 'Hablá y hacé una pausa al terminar');
    function detect(now) {
      if (!active || turn !== generation || current.state !== 'recording') return;
      meter.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
      orb.style.setProperty('--voice-energy', Math.min(rms * 8, .15));
      if (rms > .006) { if (++soundFrames >= 2) heard = true; lastSound = now; } else soundFrames = 0;
      if (heard && (now - lastSound > 1500 || now - started > 20000)) return stopCapture();
      if (!heard && now - started > 12000) {
        fail('No estoy recibiendo tu voz');
        subtitle.textContent = 'Revisá el micrófono seleccionado y tocá para reintentar';
      }
    }
    frame = setInterval(() => detect(performance.now()), 80);
  } catch (error) {
    starting = false;
    fail(error.name === 'NotAllowedError' ? 'Permití el micrófono para conversar' : 'No pude acceder al micrófono');
  }
}
async function json(path, options) {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(60000) }); const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'No pude completar la consulta'); return data;
}
async function respond(blob, turn) {
  try {
    status('thinking', 'Te estoy entendiendo');
    const form = new FormData(); form.append('file', blob, blob.type.includes('mp4') ? 'consulta.m4a' : 'consulta.webm');
    const transcript = await json('/api/transcribe', { method: 'POST', body: form });
    if (!active || turn !== generation) return;
    if (!transcript.text?.trim()) return listen();
    status('thinking', 'Estoy preparando tu respuesta', `Escuché: ${transcript.text}`);
    messages.push({ role: 'user', content: transcript.text });
    const result = await json('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: messages.slice(-12) }) });
    if (!active || turn !== generation) return;
    messages.push({ role: 'assistant', content: result.message });
    status('thinking', 'Preparando la voz');
    const response = await fetch('/api/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: result.message }), signal: AbortSignal.timeout(45000) });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'No pude generar la voz');
    }
    const voice = await response.blob(); if (!active || turn !== generation) return;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(voice); audio.src = audioUrl; await audio.play();
  } catch (error) { if (active && turn === generation) fail(error.name === 'NotAllowedError' ? 'Tocá para habilitar la voz' : error.message); }
}
audio.onplaying = () => status('speaking', 'Te estoy hablando', 'Tocá la esfera para terminar');
const resumeListening = () => { if (active) listen(); };
audio.onended = resumeListening;
audio.onerror = () => { if (active) fail('No pude reproducir la voz'); };
trigger.addEventListener('click', async () => {
  if (active) return end(); active = true; ++generation;
  status('listening', 'Activando el micrófono');
  listen();
});
window.addEventListener('pagehide', end);
status('idle', 'Tocá para conversar');
