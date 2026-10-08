// Everything the assistant knows lives in PostgreSQL: its prompts (table `prompts`) and the
// text of personal.com.py (tables `pages` and `passages`). Without a reachable database the
// server keeps working from the files in ./knowledge and simply has no site search.
import pg from 'pg';
import { crawl } from './scripts/crawl.mjs';

const DATABASE_URL = process.env.DATABASE_URL || '';
const DAY = 24 * 60 * 60 * 1000;
let pool = null;
let ready = false;
let syncing = false;

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

const STOPWORDS = new Set('a al algo algun alguna como con cual cuales cuando cuanto cuanta cuantos de del donde el ella en es esa ese eso esta este esto hay la las le lo los me mi mis muy necesito no o para pero por que quiero quisiera saber se si sin sobre su sus te tengo tiene tienen tu un una uno unos y ya yo hola buenas buenos dias tardes gracias favor puedo podes pueden sale salen cuesta cuestan'.split(' '));

// Full-text search over the site. Words are OR-ed so a spoken, imprecise question still matches.
export async function search(question, limit = 6) {
  if (!ready) return [];
  const words = [...new Set(question.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9ñ]{2,}/g) || [])].filter((word) => !STOPWORDS.has(word)).slice(0, 12);
  if (!words.length) return [];
  try {
    const { rows } = await pool.query(
      `select url, title, heading, content, ts_rank_cd(search, query, 32) as rank
       from passages, to_tsquery('spanish', $1) query
       where search @@ query order by rank desc limit $2`,
      [words.join(' | '), limit]);
    return rows;
  } catch { return []; }
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
      await client.query('insert into pages (url, title, description, content) values ($1, $2, $3, $4)', [page.url, page.title, page.description, page.content]);
      for (const passage of page.chunks) {
        await client.query('insert into passages (url, title, heading, content) values ($1, $2, $3, $4)', [page.url, page.title, passage.heading, passage.content]);
        passages += 1;
      }
    }
    await client.query('insert into sync_runs (pages, passages) values ($1, $2)', [pages.length, passages]);
    await client.query('commit');
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
