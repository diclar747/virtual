// Everything the assistant knows lives in PostgreSQL: its prompts (table `prompts`) and the
// text of personal.com.py (tables `pages` and `passages`). Without a reachable database the
// server keeps working from the files in ./knowledge and simply has no site search.
import pg from 'pg';
import { crawl } from './scripts/crawl.mjs';
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
  const { rows: [counts] } = await pool.query('select (select count(*)::int from pages) as pages, (select count(*)::int from passages) as passages, (select max(finished_at) from sync_runs) as synced_at');
  return { connected: true, ...counts };
}

// The passages are few, so they are kept in memory and ranked there (see search.mjs).
async function loadIndex() {
  const { rows } = await pool.query('select p.url, p.title, p.heading, p.content, g.topic from passages p join pages g using (url) order by p.id');
  index = buildIndex(rows);
}

export async function search(question, limit = 6) {
  return ready ? searchIndex(index, question, limit) : [];
}

// Reads the whole site again and replaces the stored copy in one transaction.
export async function sync(log = () => {}) {
  if (!ready || syncing) return null;
  syncing = true;
  const client = await pool.connect();
  try {
    const pages = await crawl(log);
    if (pages.length < 10) throw new Error(`El sitio devolvió solo ${pages.length} páginas; se conserva la copia anterior.`);
    await client.query('begin');
    await client.query('delete from pages');
    let passages = 0;
    for (const page of pages) {
      // The topic is what the page is about: its title, description, address and section headings.
      const topic = [page.title.replace(/\|.*$/, ''), page.description, new URL(page.url).pathname.replace(/\.html?$/, '').replace(/[^a-z0-9]+/gi, ' '), ...page.lines.filter((line) => line.startsWith('## ') && !line.startsWith('## Planes, packs y precios')).map((line) => line.slice(3))].join(' ');
      await client.query('insert into pages (url, title, description, content, topic) values ($1, $2, $3, $4, $5)', [page.url, page.title, page.description, page.content, topic]);
      for (const passage of page.chunks) {
        await client.query('insert into passages (url, title, heading, content) values ($1, $2, $3, $4)', [page.url, page.title, passage.heading, passage.content]);
        passages += 1;
      }
    }
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
