const state = {
  messages: [],
  recording: false,
  speaking: true,
  mediaRecorder: null,
  audioChunks: [],
};

const $ = (selector) => document.querySelector(selector);
const conversation = $("#conversation");
const composer = $("#composer");
const input = $("#messageInput");
const orb = $("#orb");
const orbStatus = $("#orbStatus");
const voiceTitle = $("#voiceTitle");
const voiceSubtitle = $("#voiceSubtitle");
const connectionText = $("#connectionText");
const connectionPill = $("#connectionPill");
const micButton = $("#micButton");
const orbTrigger = $("#orbTrigger");
const speakerButton = $("#speakerButton");
const voiceModeLabel = $("#voiceModeLabel");
const voiceAudio = new Audio();
voiceAudio.controls = true;
voiceAudio.style.cssText = 'width:100%;height:36px;margin-top:12px';
document.querySelector('.voice-copy').appendChild(voiceAudio);
let speechGeneration = 0;
let voiceObjectUrl;
voiceAudio.onplaying = () => setStatus('speaking', 'Te estoy respondiendo', 'Podés detener o volver a escuchar el audio');
voiceAudio.onended = () => setStatus('idle', 'Tocá para hablar', 'Te escucho y te respondo en voz alta');

function setStatus(stateName, title, subtitle) {
  orb.dataset.state = stateName;
  orbStatus.textContent = stateName === "listening" ? "Escuchando" : stateName === "thinking" ? "Pensando" : stateName === "speaking" ? "Hablando" : "En espera";
  voiceTitle.textContent = title;
  voiceSubtitle.textContent = subtitle;
}

function escapeHtml(text) {
  return text.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

function addMessage(role, text) {
  state.messages.push({ role, content: text });
  const article = document.createElement("article");
  article.className = `message ${role === "user" ? "user-message" : "assistant-message"}`;
  article.innerHTML = `
    <div class="message-avatar">${role === "user" ? "T" : "P"}</div>
    <div class="message-body">
      <div class="message-meta">${role === "user" ? "Vos" : "Asistente"} <span>ahora</span></div>
      <p>${escapeHtml(text).replace(/\n/g, "<br />")}</p>
    </div>`;
  conversation.appendChild(article);
  if (role === 'assistant') {
    const replay = document.createElement('button');
    replay.textContent = '▶ Escuchar respuesta';
    replay.className = 'voice-mode-label';
    replay.style.marginTop = '8px';
    replay.addEventListener('click', () => { state.speaking = true; speak(text); });
    article.querySelector('.message-body').appendChild(replay);
  }
  conversation.scrollTop = conversation.scrollHeight;
  if (role === "user") $("#suggestions")?.classList.add("hidden");
}

function addTyping() {
  const article = document.createElement("article");
  article.className = "message assistant-message";
  article.id = "typingMessage";
  article.innerHTML = `<div class="message-avatar">P</div><div class="message-body"><div class="message-meta">Asistente <span>ahora</span></div><div class="typing-dots"><i></i><i></i><i></i></div></div>`;
  conversation.appendChild(article);
  conversation.scrollTop = conversation.scrollHeight;
}

function removeTyping() { $("#typingMessage")?.remove(); }

function autoResize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 110)}px`;
}

async function speak(text) {
  const generation = ++speechGeneration;
  voiceAudio.pause();
  if (!state.speaking) return;
  setStatus('thinking', 'Preparando la voz', 'Generando la respuesta en español');
  try {
    const response = await fetch('/api/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!response.ok) throw new Error('No se pudo generar el audio');
    const blob = await response.blob();
    if (generation !== speechGeneration || !state.speaking) return;
    if (voiceObjectUrl) URL.revokeObjectURL(voiceObjectUrl);
    voiceObjectUrl = URL.createObjectURL(blob);
    voiceAudio.src = voiceObjectUrl;
    try { await voiceAudio.play(); }
    catch { setStatus('idle', 'Respuesta lista para escuchar', 'Tocá ▶ en el reproductor para escuchar'); }
    return;
  } catch {
    setStatus('idle', 'No pude reproducir la voz', 'Intentá con Escuchar respuesta');
  }
  if (!state.speaking || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "es-PY";
  utterance.rate = 0.98;
  utterance.pitch = 1.02;
  utterance.onstart = () => setStatus("speaking", "Te estoy respondiendo", "Podés seguir la conversación por texto");
  utterance.onend = () => setStatus("idle", "Tocá para hablar", "Te escucho y te respondo en voz alta");
  utterance.onerror = () => setStatus("idle", "Tocá para hablar", "Te escucho y te respondo en voz alta");
  window.speechSynthesis.speak(utterance);
}

async function sendMessage(text) {
  const cleanText = text.trim();
  if (!cleanText) return;
  addMessage("user", cleanText);
  input.value = "";
  autoResize();
  setStatus("thinking", "Estoy pensando", "Buscando la mejor respuesta");
  addTyping();
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: state.messages }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No se pudo responder.");
    removeTyping();
    addMessage("assistant", data.message);
    setStatus("idle", "Tocá para hablar", "Te escucho y te respondo en voz alta");
    speak(data.message);
  } catch (error) {
    removeTyping();
    const message = error.message.includes("Falta NIRO_API_KEY")
      ? "La clave de Niro todavía no está configurada en el servidor. Revisá el archivo .env.local y volvé a iniciar la app."
      : `No pude conectar con Niro: ${error.message}`;
    addMessage("assistant", message);
    setStatus("idle", "Tocá para hablar", "Podés intentar de nuevo en un momento");
  }
}

async function startRecording() {
  ++speechGeneration;
  voiceAudio.pause();
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    addMessage("assistant", "Tu navegador no permite grabar audio desde esta página. Podés escribir tu consulta abajo.");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.audioChunks = [];
    state.mediaRecorder = new MediaRecorder(stream);
    state.mediaRecorder.ondataavailable = (event) => { if (event.data.size) state.audioChunks.push(event.data); };
    state.mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      const audio = new Blob(state.audioChunks, { type: state.mediaRecorder.mimeType || "audio/webm" });
      await transcribe(audio);
    };
    state.mediaRecorder.start();
    state.recording = true;
    micButton.classList.add("recording");
    micButton.setAttribute("aria-label", "Detener grabación");
    setStatus("listening", "Te escucho", "Tocá de nuevo cuando termines");
  } catch {
    addMessage("assistant", "No pude acceder al micrófono. Revisá el permiso del navegador o escribí tu consulta.");
    setStatus("idle", "Tocá para hablar", "Te escucho y te respondo en voz alta");
  }
}

async function stopRecording() {
  if (!state.mediaRecorder) return;
  state.recording = false;
  micButton.classList.remove("recording");
  micButton.setAttribute("aria-label", "Hablar con el asistente");
  setStatus("thinking", "Transcribiendo", "Un momento, estoy pasando tu voz a texto");
  state.mediaRecorder.stop();
}

async function transcribe(audio) {
  try {
    const form = new FormData();
    form.append("file", audio, "consulta.webm");
    const response = await fetch("/api/transcribe", { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No se pudo transcribir el audio.");
    if (data.text?.trim()) await sendMessage(data.text);
    else setStatus("idle", "Tocá para hablar", "No llegué a escuchar una consulta");
  } catch (error) {
    addMessage("assistant", `No pude transcribir el audio: ${error.message}`);
    setStatus("idle", "Tocá para hablar", "También podés escribir tu consulta");
  }
}

composer.addEventListener("submit", (event) => { event.preventDefault(); sendMessage(input.value); });
input.addEventListener("input", autoResize);
input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); composer.requestSubmit(); } });
micButton.addEventListener("click", () => state.recording ? stopRecording() : startRecording());
orbTrigger.addEventListener("click", () => state.recording ? stopRecording() : startRecording());
speakerButton.addEventListener("click", () => {
  state.speaking = !state.speaking;
  speakerButton.classList.toggle("active", state.speaking);
  voiceModeLabel.textContent = state.speaking ? "Voz activada" : "Voz desactivada";
  if (!state.speaking && "speechSynthesis" in window) window.speechSynthesis.cancel();
  if (!state.speaking) { ++speechGeneration; voiceAudio.pause(); }
});
$("#resetButton").addEventListener("click", () => {
  ++speechGeneration;
  voiceAudio.pause();
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  state.messages = [];
  conversation.innerHTML = `<article class="message assistant-message"><div class="message-avatar">P</div><div class="message-body"><div class="message-meta">Asistente <span>ahora</span></div><p>Conversación nueva. ¿En qué te ayudo?</p></div></article>`;
  $("#suggestions")?.classList.remove("hidden");
  setStatus("idle", "Tocá para hablar", "Te escucho y te respondo en voz alta");
});
document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => sendMessage(button.dataset.prompt)));

fetch("/api/health").then((response) => response.json()).then((data) => {
  connectionText.textContent = data.niroConfigured ? "Niro listo para conversar" : "Falta configurar Niro";
  connectionPill.classList.toggle("not-ready", !data.niroConfigured);
}).catch(() => {
  connectionText.textContent = "Servidor sin conexión";
  connectionPill.classList.add("not-ready");
});
