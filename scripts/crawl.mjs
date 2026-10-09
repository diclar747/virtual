// Reads every public page of personal.com.py and returns its text, split into passages.
// Used by scripts/sync.mjs to fill the database the assistant searches.
const ORIGIN = 'https://www.personal.com.py';
const HOSTS = new Set(['www.personal.com.py', 'personal.com.py']);
const SKIP = /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|json|xml|zip|apk|mp4|mp3|woff2?|ttf)$/i;
const MAX_PAGES = 600;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalize(href, base) {
  try {
    const url = new URL(href.replace(/&amp;/g, '&'), base);
    if (!HOSTS.has(url.hostname) || !/^https?:$/.test(url.protocol) || SKIP.test(url.pathname)) return null;
    let pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/index\.html?$/i, '/');
    return `${ORIGIN}${pathname}`;
  } catch { return null; }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', uuml: 'ü', iquest: '¿', iexcl: '¡', ordm: 'º', ordf: 'ª', deg: '°', hellip: '…', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', reg: '®', copy: '©', trade: '™' };
function decode(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name] ?? match);
}

// Turns a page into plain lines; headings are kept as "## " so passages can carry their section.
function extract(html) {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim());
  const description = decode(html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1] || '').trim();
  const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] || html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|select|form|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<h[1-4][^>]*>/gi, '\n## ')
    .replace(/<\/(h[1-6]|p|div|li|tr|section|article|ul|ol|table|header|footer|nav|br)>|<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
  const lines = decode(body).split('\n').map((line) => line.replace(/[ \t ]+/g, ' ').replace(/(\s*\|\s*)+$/, '').trim())
    .filter((line) => line.replace(/^##\s*/, '').length > 1 && !/^(-->|toggle navigation)$/i.test(line));
  const links = [...html.matchAll(/<a\b[^>]*\bhref=["']([^"'#]+)/gi)].map((match) => match[1]);
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']*dinamico[^"']*)/gi)].map((match) => match[1]);
  return { title, description, lines, links, scripts };
}

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (asistente-demo)' };
const IGNORED_KEYS = /^(wowDelay|ctaHref|ctaText|href|link|url|img|image|icon|class|id|dataType|color|target|classes|category|type|expanded|delay|labelledby|controls|parent)$|Class\d*$|DataTitle$|Id$|^collapse|^aria|^clase|^comentario$/i;

// Plans, packs and prices are not in the HTML: small loader scripts fill them from JSON files.
// This finds the files a page uses and turns them into readable lines.
async function dynamicLines(pageUrl, scripts) {
  const lines = [];
  const file = new URL(pageUrl).pathname.split('/').pop() || 'index.html';
  for (const src of scripts) {
    try {
      const loader = await (await fetch(new URL(src, pageUrl.endsWith('/') ? `${pageUrl}index.html` : pageUrl), { headers: HEADERS, signal: AbortSignal.timeout(20000) })).text();
      const base = loader.match(/DATA_PATH\s*=\s*['"]([^'"]+)['"]/)?.[1] || '';
      const targets = new Set([...loader.matchAll(/['"](\/[^'"]+\.json)['"]/g)].map((match) => match[1]));
      for (const [, page, json] of loader.matchAll(/['"]([^'"]+\.html)['"]\s*:\s*['"]([^'"]+\.json)['"]/g)) if (page === file || page.endsWith(`/${file}`)) targets.add(base + json);
      for (const target of targets) {
        const response = await fetch(new URL(target, ORIGIN), { headers: HEADERS, signal: AbortSignal.timeout(20000) });
        if (response.ok) flatten(await response.json(), lines);
      }
    } catch { /* a page without readable data still keeps its own text */ }
  }
  return lines;
}

function flatten(value, lines, label = '') {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') { const start = lines.length; flatten(item, lines); if (lines.length > start) lines.push('—'); }
      else flatten(item, lines, label);
    }
  } else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) if (!IGNORED_KEYS.test(key)) flatten(inner, lines, key);
  } else if (typeof value === 'string' || typeof value === 'number') {
    const text = decode(String(value).replace(/<li[^>]*>/gi, ' · ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (text.length > 1 && !/^(#|\.{0,2}\/|https?:)/.test(text)) lines.push(label && !/HTML$/.test(label) ? `${label}: ${text}` : text);
  }
}

export async function crawl(log = () => {}) {
  const queue = [`${ORIGIN}/`, `${ORIGIN}/tienda/bancos/`];
  const seen = new Set(queue);
  const pages = [];
  try {
    const sitemap = await (await fetch(`${ORIGIN}/sitemap.xml`, { headers: { 'User-Agent': 'Mozilla/5.0 (asistente-demo)' } })).text();
    for (const [, loc] of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) { const url = normalize(loc, ORIGIN); if (url && !seen.has(url)) { seen.add(url); queue.push(url); } }
  } catch { /* the home page links are enough to start */ }
  while (queue.length && pages.length < MAX_PAGES) {
    const url = queue.shift();
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (asistente-demo)' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
      const type = response.headers.get('content-type') || '';
      if (!response.ok || !type.includes('text/html')) { log(`  ${response.status} ${url}`); continue; }
      const final = normalize(response.url, ORIGIN);
      if (!final) continue;                       // redirected to another site
      const page = extract(await response.text());
      for (const href of page.links) { const next = normalize(href, response.url); if (next && !seen.has(next)) { seen.add(next); queue.push(next); } }
      if (final !== url && pages.some((existing) => existing.url === final)) continue;
      const data = await dynamicLines(final, page.scripts);
      pages.push({ url: final, title: page.title, description: page.description, lines: page.lines, data });
      log(`  ${pages.length} ${final} (${page.lines.length} líneas${data.length ? ` + ${data.length} de datos` : ''})`);
    } catch (error) { log(`  error ${url}: ${error.message}`); }
    await sleep(250);
  }
  // Menus and footers repeat on almost every page; dropping them leaves each page's own content.
  const frequency = new Map();
  for (const page of pages) for (const line of new Set(page.lines)) frequency.set(line, (frequency.get(line) || 0) + 1);
  const common = Math.max(4, pages.length * 0.3);
  for (const page of pages) {
    page.lines = page.lines.filter((line) => frequency.get(line) < common && !/CARGADO POR/.test(line));
    if (page.data.length) page.lines.push('## Planes, packs y precios publicados', ...page.data);
  }
  const byContent = new Map();
  for (const page of pages) { const key = page.lines.join('\n'); if (key.length > 80 && !byContent.has(key)) byContent.set(key, page); }
  return [...byContent.values()].map((page) => ({ ...page, content: page.lines.join('\n'), chunks: chunk(page) }));
}

// Passages of roughly 900 characters, each starting at a heading when possible.
function chunk(page) {
  const chunks = [];
  let heading = '', current = [];
  const flush = () => { const content = current.join('\n').trim(); if (content.length > 40) chunks.push({ heading, content }); current = []; };
  for (const line of page.lines) {
    if (line === '—') { if (current.join('\n').length > 500) flush(); continue; }
    if (line.startsWith('## ')) { if (current.join('\n').length > 300) flush(); heading = line.slice(3); current.push(heading); continue; }
    current.push(line);
    if (current.join('\n').length > 900) flush();
  }
  flush();
  return chunks;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pages = await crawl(console.log);
  const out = process.argv[2];
  if (out) (await import('node:fs')).writeFileSync(out, JSON.stringify(pages, null, 1));
  console.log(`${pages.length} páginas, ${pages.reduce((n, p) => n + p.chunks.length, 0)} pasajes, ${pages.reduce((n, p) => n + p.content.length, 0)} caracteres`);
}
