import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

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

async function routerVoice(text) {
  const response = await fetch(`${ROUTER_API_BASE}/audio/speech`, {
    method: 'POST', signal: AbortSignal.timeout(45000),
    headers: { Authorization: `Bearer ${ROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ROUTER_TTS_MODEL, input: text.replace(/\bGs\.?\s*/gi, 'guaraníes ') }),
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
};

let knowledge = "";
try {
  knowledge = readFileSync(KNOWLEDGE_PATH, "utf8");
} catch {
  knowledge = "No se pudo cargar la base de conocimiento local.";
}

const SYSTEM_PROMPT = `${knowledge}\n\nRecordá: respondé en español claro, con voseo paraguayo cuando corresponda. No inventes precios, saldos, cobertura, reclamos ni acciones realizadas. No pidas PIN, PUK, CVV, OTP, contraseñas ni códigos. Si la consulta requiere acceso a una cuenta o una gestión, explicá el límite y derivá al canal oficial. Esta es una demostración independiente: no afirmes ser Personal oficial.`;

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

async function handleChat(req, res) {
  try {
    const input = await readJson(req);
    const incoming = Array.isArray(input.messages) ? input.messages : [];
    const messages = incoming
      .filter((message) => ["user", "assistant"].includes(message?.role) && typeof message.content === "string")
      .slice(-12)
      .map((message) => ({ role: message.role, content: message.content.slice(0, 8000) }));

    if (!messages.some((message) => message.role === "user")) {
      return json(res, 400, { error: "Escribí un mensaje para comenzar." });
    }

    const voiceMessages = [{ role: 'system', content: `${SYSTEM_PROMPT}\nEsta interacción es por voz: respondé en una o dos frases naturales, sin Markdown ni listas. Hacé una sola pregunta por turno. No repitas saludos. Conservá las condiciones importantes y ofrecé ampliar cuando haga falta.` }, ...messages];
    const data = ROUTER_API_KEY ? await routerChat(voiceMessages) : await callNiro("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: voiceMessages }),
    });

    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("Niro no devolvió contenido de respuesta.");
    json(res, 200, { message: content, usage: data.usage || null });
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
    const data = await callNiro("/audio/transcriptions", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    });
    if (!data?.text) throw new Error("Niro no devolvió una transcripción.");
    json(res, 200, { text: data.text, seconds: data.seconds || null });
  } catch (error) {
    const status = error.code === "missing_key" ? 503 : error.status && error.status < 500 ? error.status : 502;
    json(res, status, { error: error.message || "No se pudo transcribir el audio." });
  }
}

async function serveStatic(urlPath, res) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) return json(res, 403, { error: "Ruta no permitida." });
  try {
    const body = await readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[extension] || "application/octet-stream", "Cache-Control": "no-store" });
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
      const speech = ROUTER_API_KEY && ROUTER_TTS_MODEL
        ? await routerVoice(input.text)
        : { audio: process.env.OPENAI_API_KEY ? await naturalVoice(input.text) : await synthesizeVoice(input.text), contentType: 'audio/wav' };
      const { audio, contentType } = speech;
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': audio.length, 'Cache-Control': 'no-store' });
      return res.end(audio);
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, { ok: true, niroConfigured: Boolean(NIRO_API_KEY), apiBase: NIRO_API_BASE, chatProvider: ROUTER_API_KEY ? 'router' : 'niro', chatModel: ROUTER_API_KEY ? ROUTER_CHAT_MODEL : 'auto', voiceProvider: ROUTER_API_KEY && ROUTER_TTS_MODEL ? 'router' : process.env.OPENAI_API_KEY ? 'openai' : 'windows', voiceModel: ROUTER_TTS_MODEL || null });
    }
    if (req.method === "POST" && url.pathname === "/api/chat") return await handleChat(req, res);
    if (req.method === "POST" && url.pathname === "/api/transcribe") return await handleTranscription(req, res);
    if (req.method === "GET") return await serveStatic(url.pathname, res);
    json(res, 405, { error: "Método no permitido." });
  } catch (error) {
    json(res, 500, { error: error.message || "Error interno." });
  }
});

server.listen(PORT, () => {
  console.log(`Personal Asistente disponible en http://localhost:${PORT}`);
  console.log(`Niro API: ${NIRO_API_BASE} · clave configurada: ${NIRO_API_KEY ? "sí" : "no"}`);
});
