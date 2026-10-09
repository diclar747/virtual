import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import * as db from "./db.mjs";

function synthesizeVoice(text) {
  if (process.platform !== 'win32') throw new Error('Configurá ROUTER_API_KEY y ROUTER_TTS_MODEL para generar voz en el servidor Linux.');
  const script = `Add-Type -AssemblyName System.Speech
  $voiceText = [Console]::In.ReadToEnd()
  $voiceSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voiceStream = New-Object System.IO.MemoryStream
  try {
    $spanishVoice = $voiceSynth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name.StartsWith('es') } | Select-Object -First 1
    if (!$spanishVoice) { throw 'No hay una voz en español instalada.' }
    $voiceSynth.SelectVoice($spanishVoice.VoiceInfo.Name)
    $voiceSynth.SetOutputToWaveStream($voiceStream)
    $voiceSynth.Speak($voiceText)
    [Console]::Out.Write([Convert]::ToBase64String($voiceStream.ToArray()))
  } finally { $voiceSynth.Dispose(); $voiceStream.Dispose() }`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    const chunks = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error('La voz tardó demasiado.')); }, 60000);
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      const audio = Buffer.from(Buffer.concat(chunks).toString().trim(), 'base64');
      if (code !== 0 || audio.subarray(0, 4).toString() !== 'RIFF') return reject(new Error('No se pudo generar la voz en español.'));
      resolve(audio);
    });
    child.stdin.end(text);
  });
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const KNOWLEDGE_PATH = path.join(ROOT, "knowledge", "personal-prompt.md");

function loadEnvFile(fileName) {
  try {
    const source = requireText(fileName);
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // A missing env file is fine when variables are already configured.
  }
}

function requireText(fileName) {
  return readFileSync(path.join(ROOT, fileName), "utf8");
}

loadEnvFile(".env.local");
loadEnvFile(".env");

const PORT = Number(process.env.PORT || 4173);
const NIRO_API_BASE = (process.env.NIRO_API_BASE || "https://niro.cnid.com.py/api/v1").replace(/\/$/, "");
const NIRO_API_KEY = process.env.NIRO_API_KEY || "";
const ROUTER_API_BASE = (process.env.ROUTER_API_BASE || 'https://router.cnid.com.py/v1').replace(/\/$/, '');
const ROUTER_API_KEY = process.env.ROUTER_API_KEY || '';
const ROUTER_CHAT_MODEL = process.env.ROUTER_CHAT_MODEL || 'cx/gpt-5.6-luna';
const ROUTER_TTS_MODEL = process.env.ROUTER_TTS_MODEL || '';

// Rewrites written shorthand into what a person would say aloud, so the voice does not spell symbols.
function speechText(text) {
  return text
    .replace(/\*(\d+)/g, 'asterisco $1')
    .replace(/[*_`#>|]+/g, ' ')
    .replace(/\bGs\.?\s*(\d+(?:\.\d{3})*)/gi, '$1 guaraníes')
    .replace(/\bGs\.?(?=\s|$)/gi, 'guaraníes')
    .replace(/(\d+)\s*\/\s*(\d+)\s*Mbps/gi, '$1 megas de bajada y $2 de subida')
    .replace(/\b1\s*Gbps\b/gi, 'un giga')
    .replace(/\bGbps\b/gi, 'gigas')
    .replace(/\bMbps\b/gi, 'megas')
    .replace(/\bKbps\b/gi, 'kilobits por segundo')
    .replace(/(\d)\s*GB\b/g, '$1 gigas')
    .replace(/(\d)\s*h\b/g, '$1 horas')
    .replace(/Wi[‑-]?Fi/gi, 'wifi')
    .replace(/\s*[;:]\s+/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Voices the visitor may pick on screen; anything else falls back to the configured default.
const VOICES = ['es-PY-TaniaNeural', 'es-PY-MarioNeural', 'es-AR-ElenaNeural', 'es-US-PalomaNeural', 'es-ES-XimenaMultilingualNeural', 'en-US-AvaMultilingualNeural'];

async function routerVoice(text, voice) {
  const response = await fetch(`${ROUTER_API_BASE}/audio/speech`, {
    method: 'POST', signal: AbortSignal.timeout(45000),
    headers: { Authorization: `Bearer ${ROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: VOICES.includes(voice) ? `edge-tts/${voice}` : ROUTER_TTS_MODEL, input: speechText(text) }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error?.message || 'No se pudo generar la voz del router.');
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('audio/')) throw new Error('El router no devolvió audio reproducible.');
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) throw new Error('El router devolvió un audio vacío.');
  return { audio, contentType };
}

async function routerChat(messages) {
  const response = await fetch(`${ROUTER_API_BASE}/chat/completions`, {
    method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${ROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ROUTER_CHAT_MODEL, messages, stream: false }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'El router no pudo responder.');
  return data;
}

async function naturalVoice(text) {
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: process.env.OPENAI_TTS_VOICE || 'marin',
      input: text,
      response_format: 'wav',
      instructions: 'Hablá en español latinoamericano con voseo paraguayo natural. Usá un tono cálido, cercano y tranquilo, ritmo conversacional, pausas breves y entonación expresiva pero sutil. Leé guaraníes en lugar de Gs. Evitá sonar como un anuncio, recitar o exagerar las emociones.',
    }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || 'No se pudo generar la voz natural.');
  }
  return Buffer.from(await response.arrayBuffer());
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

let knowledge = "";
try {
  knowledge = readFileSync(KNOWLEDGE_PATH, "utf8");
} catch {
  knowledge = "No se pudo cargar la base de conocimiento local.";
}

const RULES = `Recordá siempre: no inventes datos que no estén en la información publicada, no pidas claves ni datos de tarjeta, y no afirmes haber hecho gestiones, pedidos ni consultas de cuenta.`;

const VOICE_STYLE = `## Cómo hablar (esto manda sobre todo lo anterior)

Estás en una llamada: todo lo que escribas se lee en voz alta tal cual, y la persona te puede interrumpir.

- Hablá como una paraguaya amable y resuelta, de vos, con oraciones completas y naturales. Nunca en estilo telegrama ni como lista.
- Breve: una o dos oraciones, unas treinta y cinco palabras como máximo. Lo importante va primero, por si te interrumpen.
- Arrancá con una reacción corta y humana cuando venga al caso ("Dale", "Claro", "Uy, qué macana"), sin repetir siempre la misma.
- Ya saludaste y te presentaste al empezar: no vuelvas a saludar ni a presentarte.
- Sin símbolos, paréntesis, barras, listas ni abreviaturas. Escribí "guaraníes", "megas", "gigas".
- Los precios y cuotas van en palabras, como se dicen: "ochocientos setenta y nueve mil guaraníes", "veinticuatro cuotas de treinta y seis mil seiscientos guaraníes". Redondeá los decimales.
- Los modelos decilos como se nombran: "Galaxy A dieciséis", "Edge sesenta".
- De una ficha técnica contá solo lo que preguntaron o lo que ayuda a decidir.
- Nombrá como mucho dos o tres opciones y ofrecé seguir.
- El asterisco ciento once escribilo "*111". Si das otro teléfono, uno solo.
- Cerrá con una sola pregunta corta, salvo que ya te hayan dicho que no necesitan nada más: ahí despedite en pocas palabras.

Ejemplos de tono.
Persona: "¿Cuánto sale el Samsung A dieciséis?" Vos: "El Galaxy A dieciséis de ciento veintiocho gigas sale ochocientos setenta y nueve mil guaraníes al contado. ¿Lo querés pagar de una o en cuotas?"
Persona: "¿Y en cuotas?" Vos: "Con tarjeta de crédito lo podés llevar hasta en veinticuatro cuotas de treinta y seis mil seiscientos guaraníes. ¿Con qué banco es tu tarjeta?"
Persona: "No me anda internet en casa." Vos: "Uy, qué macana. ¿Te pasa en todos los aparatos o solamente en uno?"`;

const GREETING = "Soy {articulo} asistente de Personal, ¿en qué le ayudo?";

// The prompts are stored in the database (table "prompts") so they can be edited without a
// release; these texts are only the first-time defaults and the fallback when it is unreachable.
const DEFAULT_PROMPTS = {
  system: { content: knowledge, description: "Quién es el asistente, sus reglas y el resumen base de servicios." },
  rules: { content: RULES, description: "Límites de seguridad que se repiten en cada respuesta." },
  voice_style: { content: VOICE_STYLE, description: "Cómo debe hablar en la llamada de voz." },
  greeting: { content: GREETING, description: "Saludo inicial. {articulo} se reemplaza por la/el según la voz." },
};
let prompts = Object.fromEntries(Object.entries(DEFAULT_PROMPTS).map(([key, value]) => [key, value.content]));

// Whisper invents these captions when it receives silence or background noise.
const TRANSCRIPT_NOISE = /subt[ií]tulos|amara\.org|gracias por ver|suscr[ií]b/i;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error("El archivo o mensaje supera el límite permitido."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const body = await readBody(req, 512 * 1024);
  return JSON.parse(body.toString("utf8"));
}

async function callNiro(endpoint, options = {}) {
  if (!NIRO_API_KEY) {
    const error = new Error("Falta NIRO_API_KEY en el servidor.");
    error.code = "missing_key";
    throw error;
  }

  const response = await fetch(`${NIRO_API_BASE}${endpoint}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(45000),
    headers: {
      Authorization: `Bearer ${NIRO_API_KEY}`,
      ...(options.headers || {}),
    },
  });
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw };
  }

  if (!response.ok) {
    const message = data?.error?.message || data?.message || data?.raw || `Niro respondió con estado ${response.status}.`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

function cleanMessages(incoming) {
  return (Array.isArray(incoming) ? incoming : [])
    .filter((message) => ["user", "assistant"].includes(message?.role) && typeof message.content === "string")
    .slice(-12)
    .map((message) => ({ role: message.role, content: message.content.slice(0, 8000) }));
}

// Repeated work is answered from memory: the same sentence in the same voice, or the same
// question at the same point of a conversation, skips its provider call entirely.
function remember(cache, limit, lifetime, key, produce) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < lifetime) return hit.value;
  const value = produce();
  cache.delete(key);
  cache.set(key, { at: Date.now(), value });
  value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
  if (cache.size > limit) cache.delete(cache.keys().next().value);
  return value;
}
const speechCache = new Map();
const answerCache = new Map();
const HOUR = 60 * 60 * 1000;

function complete(messages) {
  const key = JSON.stringify(messages.map((message) => [message.role, message.content.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()]));
  return remember(answerCache, 500, 6 * HOUR, key, () => completeFresh(messages));
}

async function completeFresh(messages) {
  // The passages of personal.com.py closest to what was just asked travel with the question.
  // The system message must stay identical between calls: the provider takes about three
  // seconds longer whenever it changes, so nothing variable may be added to it.
  // The search follows the thread: a bare "¿y en cuotas?" still needs the product named a turn
  // earlier, so the previous question and the previous answer are searched along with the new one.
  const thread = messages.slice(-3).map((message) => message.content.replace(/\[El usuario interrumpió[^\]]*\]/g, "")).join(" ");
  const earlier = messages.slice(-8).map((message) => message.content.replace(/\[El usuario interrumpió[^\]]*\]/g, "")).join(" ");
  const found = await db.search(messages.at(-1)?.content || "", thread, earlier);
  const last = messages.at(-1);
  const grounded = found.length && last?.role === "user"
    ? [...messages.slice(0, -1), { role: "user", content: `[Información publicada por Personal en su web y su tienda, buscada para esta consulta. Usá solo lo que sirva; si no alcanza para responder, decilo.]\n${found.map((passage) => `(${passage.title}${passage.heading ? ` › ${passage.heading}` : ""})\n${(passage.whole ? passage.content : passage.content.slice(0, 1500))}`).join("\n\n")}\n\n[Lo que dijo el cliente]\n${last.content}` }]
    : messages;
  const voiceMessages = [{ role: 'system', content: `${prompts.system}\n\n${prompts.rules}\n\n${prompts.voice_style}` }, ...grounded];
  const data = ROUTER_API_KEY ? await routerChat(voiceMessages) : await callNiro("/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: voiceMessages }),
  });
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Niro no devolvió contenido de respuesta.");
  return { content, usage: data.usage || null };
}

function speak(text, voice) {
  return remember(speechCache, 300, 24 * HOUR, `${voice}|${text}`, () => speakFresh(text, voice));
}

async function speakFresh(text, voice) {
  if (ROUTER_API_KEY && ROUTER_TTS_MODEL) return routerVoice(text, voice);
  return { audio: process.env.OPENAI_API_KEY ? await naturalVoice(text) : await synthesizeVoice(text), contentType: 'audio/wav' };
}

async function transcribe(body, contentType) {
  const data = await callNiro("/audio/transcriptions", { method: "POST", headers: contentType ? { "Content-Type": contentType } : {}, body });
  if (typeof data?.text !== "string") throw new Error("Niro no devolvió una transcripción.");
  return { text: TRANSCRIPT_NOISE.test(data.text) ? "" : data.text.trim(), seconds: data.seconds || null };
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

// The first answer after a quiet period takes several seconds upstream. Opening the conversation
// triggers a throwaway request so that delay is spent before the user finishes speaking.
let warmedAt = 0;
function warmUp() {
  if (Date.now() - warmedAt < 120000) return;
  warmedAt = Date.now();
  completeFresh([{ role: "user", content: "Hola" }]).catch(() => { warmedAt = 0; });
}

// One request per spoken turn: every extra round trip from the phone adds audible delay.
// Results are streamed as JSON lines so the browser can start playing the first sentence at once.
async function handleTurn(req, res) {
  let streaming = false;
  const send = (item) => res.write(`${JSON.stringify(item)}\n`);
  try {
    const input = JSON.parse((await readBody(req, 3 * 1024 * 1024)).toString("utf8"));
    const audio = Buffer.from(typeof input.audio === "string" ? input.audio : "", "base64");
    if (!audio.length) return json(res, 400, { error: "Falta el audio de la consulta." });
    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/wav" }), "consulta.wav");
    const { text: question } = await transcribe(form);
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" });
    streaming = true;
    send({ type: "transcript", text: question });
    if (!question) return res.end();
    const { content } = await complete([...cleanMessages(input.messages), { role: "user", content: question }].slice(-12));
    send({ type: "reply", text: content });
    const clips = speechParts(content).map((part) => speak(part, input.voice));
    clips.forEach((clip) => clip.catch(() => {}));
    for (const clip of clips) {
      const voice = await clip;
      send({ type: "audio", mime: voice.contentType, data: voice.audio.toString("base64") });
    }
    send({ type: "done" });
    res.end();
  } catch (error) {
    const message = error.message || "No se pudo completar la consulta.";
    if (!streaming) return json(res, error.code === "missing_key" ? 503 : 502, { error: message });
    send({ type: "error", message });
    res.end();
  }
}

async function handleChat(req, res) {
  try {
    const input = await readJson(req);
    const messages = cleanMessages(input.messages);

    if (!messages.some((message) => message.role === "user")) {
      return json(res, 400, { error: "Escribí un mensaje para comenzar." });
    }

    const { content, usage } = await complete(messages);
    json(res, 200, { message: content, usage });
  } catch (error) {
    const status = error.code === "missing_key" ? 503 : error.status && error.status < 500 ? error.status : 502;
    json(res, status, { error: error.message || "No se pudo completar la consulta." });
  }
}

async function handleTranscription(req, res) {
  try {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      return json(res, 400, { error: "El audio debe enviarse como multipart/form-data." });
    }
    const body = await readBody(req);
    json(res, 200, await transcribe(body, contentType));
  } catch (error) {
    const status = error.code === "missing_key" ? 503 : error.status && error.status < 500 ? error.status : 502;
    json(res, status, { error: error.message || "No se pudo transcribir el audio." });
  }
}

async function serveStatic(urlPath, res, versioned = false) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) return json(res, 403, { error: "Ruta no permitida." });
  try {
    const body = await readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    // Files requested with ?v= never change under that address, so devices may keep them for good.
    // Everything else stays uncached: the CDN would otherwise hold sw.js and delay every release.
    res.writeHead(200, { "Content-Type": MIME_TYPES[extension] || "application/octet-stream", "Cache-Control": versioned ? "public, max-age=31536000, immutable" : "no-store" });
    res.end(body);
  } catch {
    json(res, 404, { error: "No encontrado." });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "POST" && url.pathname === "/api/speak") {
      const input = await readJson(req);
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 8000) return json(res, 400, { error: 'Texto de voz inválido.' });
      const speech = await speak(input.text, input.voice);
      const { audio, contentType } = speech;
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': audio.length, 'Cache-Control': 'no-store' });
      return res.end(audio);
    }
    if (req.method === "GET" && url.pathname === "/api/config") return json(res, 200, { greeting: prompts.greeting });
    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, { ok: true, niroConfigured: Boolean(NIRO_API_KEY), apiBase: NIRO_API_BASE, chatProvider: ROUTER_API_KEY ? 'router' : 'niro', chatModel: ROUTER_API_KEY ? ROUTER_CHAT_MODEL : 'auto', voiceProvider: ROUTER_API_KEY && ROUTER_TTS_MODEL ? 'router' : process.env.OPENAI_API_KEY ? 'openai' : 'windows', voiceModel: ROUTER_TTS_MODEL || null, database: await db.status().catch(() => ({ connected: false })) });
    }
    if (req.method === "POST" && url.pathname === "/api/chat") return await handleChat(req, res);
    if (req.method === "POST" && url.pathname === "/api/turn") return await handleTurn(req, res);
    if (req.method === "POST" && url.pathname === "/api/warm") { warmUp(); return json(res, 202, { ok: true }); }
    if (req.method === "POST" && url.pathname === "/api/transcribe") return await handleTranscription(req, res);
    if (req.method === "GET" && url.pathname === "/api/speak") {
      const text = url.searchParams.get("text") || "";
      if (!text.trim() || text.length > 300) return json(res, 400, { error: "Texto de voz inválido." });
      const { audio, contentType } = await speak(text, url.searchParams.get("voice"));
      res.writeHead(200, { "Content-Type": contentType, "Content-Length": audio.length, "Cache-Control": "public, max-age=604800" });
      return res.end(audio);
    }
    if (req.method === "GET") return await serveStatic(url.pathname, res, url.searchParams.has("v"));
    json(res, 405, { error: "Método no permitido." });
  } catch (error) {
    json(res, 500, { error: error.message || "Error interno." });
  }
});

// Keeps prompts and site content current: reconnects if the database was down, picks up edited
// prompts within a minute, and re-reads personal.com.py once a day.
async function refreshKnowledge() {
  if (!db.enabled()) return;
  try {
    if (!db.isReady() && !await db.connect(DEFAULT_PROMPTS)) return;
    const next = { ...prompts, ...await db.loadPrompts() };
    if (JSON.stringify(next) !== JSON.stringify(prompts)) { prompts = next; answerCache.clear(); speechCache.clear(); }
    const synced = await db.syncIfStale((line) => console.log(line));
    if (synced) { answerCache.clear(); console.log(`Sitio actualizado: ${synced.pages} páginas, ${synced.passages} pasajes.`); }
  } catch (error) {
    console.log(`Base de datos no disponible: ${error.message}`);
  }
}
refreshKnowledge();
setInterval(refreshKnowledge, 60000).unref();

server.listen(PORT, () => {
  console.log(`Personal Asistente disponible en http://localhost:${PORT}`);
  console.log(`Base de datos: ${db.enabled() ? "configurada" : "sin configurar (se usan los archivos locales)"}`);
  console.log(`Niro API: ${NIRO_API_BASE} · clave configurada: ${NIRO_API_KEY ? "sí" : "no"}`);
});
