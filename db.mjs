// Everything the assistant knows lives in PostgreSQL: its prompts (table `prompts`) and the
// text of personal.com.py (tables `pages` and `passages`). Without a reachable database the
// server keeps working from the files in ./knowledge and simply has no site search.
import pg from 'pg';
import { crawl } from './scripts/crawl.mjs';
import { store } from './scripts/store.mjs';
import { buildIndex, searchIndex } from './search.mjs';

const DATABASE_URL = process.env.DATABASE_URL || '';
const DAY = 24 * 60 * 60 * 1000;
let pool = null;
let ready = false;
let syncing = false;
let index = null;

const SCHEMA = `
create table if not exists prompts (
  key text primary key,
  content text not null,
  description text not null default '',
  updated_at timestamptz not null default now()
);
create table if not exists pages (
  url text primary key,
  title text not null default '',
  description text not null default '',
  content text not null,
  fetched_at timestamptz not null default now()
);
alter table pages add column if not exists topic text not null default '';
create table if not exists passages (
  id bigserial primary key,
  url text not null references pages(url) on delete cascade,
  title text not null default '',
  heading text not null default '',
  content text not null,
  search tsvector generated always as (
    setweight(to_tsvector('spanish', title || ' ' || heading), 'A') || setweight(to_tsvector('spanish', content), 'B')
  ) stored
);
create index if not exists passages_search on passages using gin (search);
create table if not exists products (
  url text primary key,
  name text not null,
  brand text not null default '',
  category text not null default '',
  price numeric,
  list_price numeric,
  available boolean not null default false,
  details jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
create table if not exists answer_cache (
  key text primary key,
  question text not null,
  reply text not null,
  hits integer not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists speech_cache (
  key text primary key,
  mime text not null,
  audio bytea not null,
  hits integer not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists sync_runs (
  id bigserial primary key,
  finished_at timestamptz not null default now(),
  pages integer not null,
  passages integer not null
);`;

export function enabled() { return Boolean(DATABASE_URL); }
export function isReady() { return ready; }

// Connects, creates the tables and stores the default prompts the first time. Safe to call again.
export async function connect(defaults) {
  if (!DATABASE_URL) return false;
  try {
    pool ??= new pg.Pool({ connectionString: DATABASE_URL, max: 4, connectionTimeoutMillis: 4000, idleTimeoutMillis: 30000 });
    pool.removeAllListeners('error');
    pool.on('error', () => { ready = false; });
    await pool.query(SCHEMA);
    for (const [key, { content, description }] of Object.entries(defaults)) {
      await pool.query('insert into prompts (key, content, description) values ($1, $2, $3) on conflict (key) do nothing', [key, content, description]);
    }
    await loadIndex();
    ready = true;
  } catch { ready = false; }
  return ready;
}

export async function loadPrompts() {
  try {
    const { rows } = await pool.query('select key, content from prompts');
    return Object.fromEntries(rows.map((row) => [row.key, row.content]));
  } catch (error) {
    ready = false;   // reconnect on the next refresh
    throw error;
  }
}

export async function status() {
  if (!ready) return { connected: false };
  const { rows: [counts] } = await pool.query('select (select count(*)::int from pages) as pages, (select count(*)::int from products) as products, (select count(*)::int from passages) as passages, (select count(*)::int from answer_cache) as cached_answers, (select count(*)::int from speech_cache) as cached_audio, (select max(finished_at) from sync_runs) as synced_at');
  return { connected: true, ...counts };
}

// Persistent cache. Answers to a conversation's opening question and every voiced sentence are
// kept in the database, so a repeated question is served without the model or the voice provider,
// and that survives restarts. A cache failure never breaks a turn: it just counts as a miss.
export async function cachedAnswer(key) {
  if (!ready) return null;
  try {
    const { rows } = await pool.query('update answer_cache set hits = hits + 1 where key = $1 returning reply', [key]);
    return rows[0]?.reply ?? null;
  } catch { return null; }
}

export function storeAnswer(key, question, reply) {
  if (ready) pool.query('insert into answer_cache (key, question, reply) values ($1, $2, $3) on conflict (key) do nothing', [key, question, reply]).catch(() => {});
}

export function clearAnswers() {
  if (ready) pool.query('delete from answer_cache').catch(() => {});
}

export async function cachedSpeech(key) {
  if (!ready) return null;
  try {
    const { rows } = await pool.query('update speech_cache set hits = hits + 1 where key = $1 returning mime, audio', [key]);
    return rows[0] ? { contentType: rows[0].mime, audio: rows[0].audio } : null;
  } catch { return null; }
}

export function storeSpeech(key, contentType, audio) {
  if (!ready) return;
  pool.query('insert into speech_cache (key, mime, audio) values ($1, $2, $3) on conflict (key) do nothing', [key, contentType, audio])
    // Keeps the table bounded: the least used, oldest sentences go first.
    .then(() => pool.query('delete from speech_cache where key in (select key from speech_cache order by hits desc, created_at desc offset 4000)'))
    .catch(() => {});
}

// The passages are few, so they are kept in memory and ranked there (see search.mjs).
async function loadIndex() {
  const { rows } = await pool.query('select p.url, p.title, p.heading, p.content, g.topic from passages p join pages g using (url) order by p.id');
  index = buildIndex(rows);
}

const PHONE_TALK = /celu|tel[eé]fono|smartphone|equipo|samsung|galaxy|motorola|moto |xiaomi|redmi|honor|iphone/i;

// Three searches are merged: the new question on its own, so a change of subject is found; the
// question with the turn before it, so "¿y en cuotas?" still finds the product being discussed;
// and a longer stretch of the talk, so that product is not lost after a few side questions. While the talk is about phones the full price list rides along, which is what lets
// the assistant recommend by budget or name the cheapest one.
// The price lists of the store and the home fibre plans, as one text. The live voice model keeps
// it in its instructions so the most common questions need no lookup at all.
export function overview() {
  if (!ready || !index) return '';
  // The per-brand phone lists repeat the cheapest-first list, and a price that appears twice is
  // one more chance for the model to mix rows up, so those are left out.
  const wanted = index.passages.filter((passage) => /#telefonos-por-precio$/.test(passage.url) || (/#lista-/.test(passage.url) && !/#lista-equipos-/.test(passage.url)) || (/\/hogar\/internet\.html$/.test(passage.url) && /velocidad:/.test(passage.content)));
  return [...new Map(wanted.map((passage) => [passage.content, passage])).values()].map((passage) => passage.content).join('\n\n');
}

export async function search(question, thread = question, earlier = thread) {
  if (!ready) return [];
  const results = [...searchIndex(index, question, 4)];
  const add = (found, room) => { for (const passage of found) if (results.length < room && !results.some((known) => known.url === passage.url && known.content === passage.content)) results.push(passage); };
  add(searchIndex(index, thread, 4), 7);
  add(searchIndex(index, earlier, 3), 8);
  if (PHONE_TALK.test(thread)) {
    const list = index.passages.find((passage) => passage.url.endsWith('#telefonos-por-precio'));
    if (list && !results.some((known) => known.url === list.url)) results.unshift({ ...list, whole: true });
    else results.forEach((known) => { if (known.url === list?.url) known.whole = true; });
  }
  return results;
}

// Reads the whole site again and replaces the stored copy in one transaction.
export async function sync(log = () => {}) {
  if (!ready || syncing) return null;
  syncing = true;
  const client = await pool.connect();
  try {
    const site = await crawl(log);
    if (site.length < 10) throw new Error(`El sitio devolvió solo ${site.length} páginas; se conserva la copia anterior.`);
    const shop = await store(log);
    const pages = [...site, ...shop];
    await client.query('begin');
    await client.query('delete from pages');
    await client.query('delete from products');
    let passages = 0;
    for (const page of pages) {
      // The topic is what the page is about: its title, description, address and section headings.
      const topic = page.topic || [page.title.replace(/\|.*$/, ''), page.description, new URL(page.url).pathname.replace(/\.html?$/, '').replace(/[^a-z0-9]+/gi, ' '), ...page.lines.filter((line) => line.startsWith('## ') && !line.startsWith('## Planes, packs y precios')).map((line) => line.slice(3))].join(' ');
      await client.query('insert into pages (url, title, description, content, topic) values ($1, $2, $3, $4, $5)', [page.url, page.title, page.description, page.content, topic]);
      if (page.product) {
        await client.query('insert into products (url, name, brand, category, price, list_price, available, details) values ($1, $2, $3, $4, $5, $6, $7, $8)',
          [page.url, page.product.name, page.product.brand, page.product.category, page.product.price, page.product.listPrice, page.product.available, JSON.stringify(page.product.details)]);
      }
      for (const passage of page.chunks) {
        await client.query('insert into passages (url, title, heading, content) values ($1, $2, $3, $4)', [page.url, page.title, passage.heading, passage.content]);
        passages += 1;
      }
    }
    // Prices may have changed, so answers given from the previous copy are dropped.
    await client.query('delete from answer_cache');
    await client.query('insert into sync_runs (pages, passages) values ($1, $2)', [pages.length, passages]);
    await client.query('commit');
    await loadIndex();
    return { pages: pages.length, passages };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    log(`No se pudo actualizar la copia del sitio: ${error.message}`);
    return null;
  } finally {
    client.release();
    syncing = false;
  }
}

// Fills the database when it is empty and refreshes it once a day.
export async function syncIfStale(log) {
  if (!ready) return;
  const { rows: [{ last }] } = await pool.query('select max(finished_at) as last from sync_runs');
  if (!last || Date.now() - new Date(last).getTime() > DAY) return sync(log);
}
