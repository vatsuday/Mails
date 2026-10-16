// PostgreSQL access. Production: Supabase via DATABASE_URL. Local dev/tests: embedded PGlite in data/pgdata.
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const PARSERS = {
  1082: (v) => v, // date -> 'YYYY-MM-DD'
  1184: (v) => new Date(v).toISOString(), // timestamptz -> ISO string
  20: (v) => Number(v), // bigint (COUNT/SUM)
  1700: (v) => Number(v), // numeric
};

export const schemaSql = () => fs.readFileSync(path.join(config.root, 'server', 'schema.sql'), 'utf8');

const txStore = new AsyncLocalStorage();
let driver;

async function connect() {
  if (config.databaseUrl) {
    const { default: pg } = await import('pg');
    for (const [oid, fn] of Object.entries(PARSERS)) pg.types.setTypeParser(Number(oid), fn);
    const url = new URL(config.databaseUrl);
    url.searchParams.delete('sslmode');
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    const pool = new pg.Pool({
      connectionString: url.toString(),
      ssl: local ? false : { rejectUnauthorized: false },
      max: config.pgPoolMax,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 15000,
    });
    pool.on('error', (err) => console.error('[db] idle client error:', err.message));
    // The schema only uses CREATE ... IF NOT EXISTS, so applying it on every cold start is safe.
    try {
      await pool.query(schemaSql());
    } catch (err) {
      pool.end().catch(() => {});
      throw err;
    }
    return {
      query: async (sql, params, client) => {
        const r = await (client || pool).query(sql, params);
        return { rows: r.rows, changes: r.rowCount ?? 0 };
      },
      exec: (sql) => pool.query(sql),
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn(client);
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
      end: () => pool.end(),
    };
  }

  // Local development: embedded Postgres, schema applied automatically.
  const pkg = '@electric-sql/pglite'; // variable import keeps it out of the Vercel bundle
  const { PGlite } = await import(pkg);
  const dir = path.join(config.dataDir, 'pgdata');
  fs.mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir, { parsers: PARSERS });
  await db.exec(schemaSql());
  return {
    query: async (sql, params, client) => {
      const r = await (client || db).query(sql, params);
      return { rows: r.rows, changes: r.affectedRows ?? 0 };
    },
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction(fn),
    end: () => db.close(),
  };
}

// A failed attempt is forgotten so the next request retries (a warm serverless instance would otherwise stay broken).
let pending = null;
function getDriver() {
  if (driver) return driver;
  pending ||= connect().then((d) => (driver = d), (err) => {
    pending = null;
    console.error('[db] connection setup failed:', err.message);
    throw err;
  });
  return pending;
}
getDriver().catch(() => {});

// Named parameters (:name) are converted to $1..$n; the same name reuses its number.
const converted = new Map();
function convert(sql) {
  let entry = converted.get(sql);
  if (!entry) {
    const names = [];
    const text = sql.replace(/(?<![\w:]):([A-Za-z_]\w*)/g, (_, name) => {
      let i = names.indexOf(name);
      if (i < 0) { names.push(name); i = names.length - 1; }
      return `$${i + 1}`;
    });
    entry = { text, names };
    if (converted.size > 1000) converted.clear();
    converted.set(sql, entry);
  }
  return entry;
}

async function exec(sql, params = {}) {
  const d = await getDriver();
  const { text, names } = convert(sql);
  const values = names.map((n) => (params[n] === undefined ? null : params[n]));
  return d.query(text, values, txStore.getStore());
}

export const all = async (sql, params) => (await exec(sql, params)).rows;
export const get = async (sql, params) => (await exec(sql, params)).rows[0];
export const run = (sql, params) => exec(sql, params);

/** Runs fn inside a transaction; queries made inside fn (even in nested calls) use it automatically. */
export async function tx(fn) {
  if (txStore.getStore()) return fn();
  const d = await getDriver();
  return d.transaction((client) => txStore.run(client, fn));
}

export async function rawExec(sql) {
  const d = await getDriver();
  return d.exec(sql);
}

export async function closeDb() {
  const d = await getDriver();
  await d.end();
}

export const isUniqueViolation = (err) => err?.code === '23505' || /duplicate key|unique constraint/i.test(err?.message || '');
