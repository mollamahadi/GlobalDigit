const { AsyncLocalStorage } = require("async_hooks");
const { Pool } = require("pg");
const config = require("./config");

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
  max: Number(process.env.DATABASE_POOL_SIZE || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const transactionStore = new AsyncLocalStorage();

function postgresSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function client() {
  return transactionStore.getStore() || pool;
}

async function query(sql, params = []) {
  return client().query(postgresSql(sql), params);
}

function prepare(sql) {
  return {
    async get(...params) {
      const result = await query(sql, params);
      return result.rows[0];
    },
    async all(...params) {
      const result = await query(sql, params);
      return result.rows;
    },
    async run(...params) {
      let statement = sql;
      const isInsert = /^\s*INSERT\s+INTO\s+/i.test(statement);
      const skipReturning = /^\s*INSERT\s+INTO\s+(users|balance_logs|sheet_outbox)\b/i.test(statement);
      if (isInsert && !skipReturning && !/\bRETURNING\b/i.test(statement)) statement += " RETURNING id";
      const result = await query(statement, params);
      return {
        changes: result.rowCount,
        lastInsertRowid: result.rows[0]?.id ? Number(result.rows[0].id) : undefined
      };
    }
  };
}

function transaction(fn) {
  return async (...args) => {
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      const result = await transactionStore.run(connection, () => fn(...args));
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  };
}

async function initialize() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id TEXT PRIMARY KEY,
      username TEXT NOT NULL DEFAULT '',
      first_name TEXT NOT NULL DEFAULT 'User',
      balance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
      status TEXT NOT NULL DEFAULT 'active',
      terms_accepted BOOLEAN NOT NULL DEFAULT FALSE,
      channel_verified BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      name TEXT NOT NULL,
      price NUMERIC(14,2) NOT NULL CHECK (price >= 0),
      product_type TEXT NOT NULL DEFAULT 'normal',
      area_codes TEXT NOT NULL DEFAULT '',
      delivery_mode TEXT NOT NULL DEFAULT 'auto',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stocks (
      id BIGSERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      stock_data TEXT NOT NULL,
      area_code TEXT,
      status TEXT NOT NULL DEFAULT 'available',
      sold_to TEXT,
      sold_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS stocks_available_idx ON stocks(product_id, status, area_code, id);

    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      product_name TEXT NOT NULL,
      area_code TEXT,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,
      total_price NUMERIC(14,2) NOT NULL CHECK (total_price >= 0),
      delivery_mode TEXT NOT NULL DEFAULT 'auto',
      delivered_data TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      delivered_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      stock_id BIGINT REFERENCES stocks(id),
      telegram_id TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      area_code TEXT,
      delivered_data TEXT NOT NULL,
      delivery_mode TEXT NOT NULL,
      delivered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS fund_requests (
      id BIGSERIAL PRIMARY KEY,
      telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
      amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
      method TEXT NOT NULL,
      txid TEXT NOT NULL,
      screenshot_file_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS balance_logs (
      id BIGSERIAL PRIMARY KEY,
      telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
      type TEXT NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
      old_balance NUMERIC(14,2) NOT NULL,
      new_balance NUMERIC(14,2) NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sheet_outbox (
      id BIGSERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS sheet_outbox_pending_idx ON sheet_outbox(status, next_attempt_at, id);
  `);
}

async function enqueueSheetEvent(eventType, entityKey, payload) {
  if (!config.sheetSyncEnabled) return;
  await query(
    "INSERT INTO sheet_outbox(event_type,entity_key,payload) VALUES(?,?,?)",
    [eventType, String(entityKey), JSON.stringify(payload)]
  );
}

async function close() {
  await pool.end();
}

module.exports = { pool, query, prepare, transaction, initialize, enqueueSheetEvent, close };
