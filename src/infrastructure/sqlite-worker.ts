import Database from 'better-sqlite3';
import { parentPort, workerData } from 'node:worker_threads';
import { PriceSnapshot } from '../types';

interface WorkerInput {
  databasePath: string;
}

interface WorkerRequest {
  id: number;
  operation: string;
  payload?: Record<string, unknown>;
}

const port = parentPort;
if (!port) throw new Error('SQLite worker must run inside a worker thread');

function errorRecord(error: unknown): { name: string; message: string; code?: string } {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  const code = (error as Error & { code?: unknown }).code;
  return { name: error.name, message: error.message, ...(typeof code === 'string' ? { code } : {}) };
}

let database: Database.Database;

function initialize(databasePath: string): void {
  database = new Database(databasePath);
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('journal_mode = WAL');
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS tracked_cryptocurrencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crypto_id INTEGER NOT NULL REFERENCES tracked_cryptocurrencies(id) ON DELETE CASCADE,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        price REAL NOT NULL CHECK(price >= 0),
        currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency = 'USD'),
        obtained_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_price_history_crypto_time ON price_history(crypto_id, obtained_at DESC);
    `);

    // Add snapshot columns to databases created by an earlier build of this service.
    const columns = new Set(
      (database.pragma('table_info(price_history)') as Array<{ name: string }>).map(({ name }) => name)
    );
    if (!columns.has('symbol')) database.exec("ALTER TABLE price_history ADD COLUMN symbol TEXT NOT NULL DEFAULT ''");
    if (!columns.has('name')) database.exec("ALTER TABLE price_history ADD COLUMN name TEXT NOT NULL DEFAULT ''");
    database.exec(`
      UPDATE price_history SET
        symbol = COALESCE(NULLIF(symbol, ''), (SELECT symbol FROM tracked_cryptocurrencies WHERE id = crypto_id)),
        name = COALESCE(NULLIF(name, ''), (SELECT name FROM tracked_cryptocurrencies WHERE id = crypto_id))
      WHERE symbol = '' OR name = '';
    `);
  })();
}

function execute(request: WorkerRequest): unknown {
  const payload = request.payload || {};
  switch (request.operation) {
    case 'listCryptos':
      return database.prepare('SELECT * FROM tracked_cryptocurrencies ORDER BY symbol').all();
    case 'getCrypto':
      return database.prepare('SELECT * FROM tracked_cryptocurrencies WHERE id = ?').get(payload.id);
    case 'createCrypto': {
      const result = database.prepare('INSERT INTO tracked_cryptocurrencies(symbol, name, created_at) VALUES (?, ?, ?)')
        .run(payload.symbol, payload.name, new Date().toISOString());
      return database.prepare('SELECT * FROM tracked_cryptocurrencies WHERE id = ?').get(Number(result.lastInsertRowid));
    }
    case 'updateCrypto': {
      const result = database.prepare('UPDATE tracked_cryptocurrencies SET symbol = ?, name = ? WHERE id = ?')
        .run(payload.symbol, payload.name, payload.id);
      return result.changes
        ? database.prepare('SELECT * FROM tracked_cryptocurrencies WHERE id = ?').get(payload.id)
        : undefined;
    }
    case 'deleteCrypto':
      return database.prepare('DELETE FROM tracked_cryptocurrencies WHERE id = ?').run(payload.id).changes > 0;
    case 'getLatestPrices':
      return database.prepare(`
        SELECT p.id, c.id AS crypto_id, c.symbol, c.name, p.price, p.currency, p.obtained_at
        FROM price_history p
        JOIN tracked_cryptocurrencies c ON c.id = p.crypto_id AND c.symbol = p.symbol
        JOIN (SELECT crypto_id, MAX(id) AS latest_id FROM price_history GROUP BY crypto_id) latest
          ON latest.latest_id = p.id
        ORDER BY c.symbol
      `).all();
    case 'getHistory': {
      const clauses = ['p.crypto_id = ?'];
      const params: (number | string)[] = [payload.cryptoId as number];
      if (typeof payload.from === 'string') { clauses.push('p.obtained_at >= ?'); params.push(payload.from); }
      if (typeof payload.to === 'string') { clauses.push('p.obtained_at <= ?'); params.push(payload.to); }
      params.push(payload.limit as number);
      return database.prepare(`
        SELECT p.id, p.crypto_id, p.symbol, p.name, p.price, p.currency, p.obtained_at
        FROM price_history p
        WHERE ${clauses.join(' AND ')} ORDER BY p.obtained_at DESC, p.id DESC LIMIT ?
      `).all(...params);
    }
    case 'healthCheck':
      database.prepare('SELECT 1').get();
      return true;
    case 'saveQuotes': {
      const quotes = payload.quotes as PriceSnapshot[];
      const obtainedAt = payload.obtainedAt as string;
      const insert = database.prepare("INSERT INTO price_history(crypto_id, symbol, name, price, currency, obtained_at) VALUES (?, ?, ?, ?, 'USD', ?)");
      const update = database.prepare('UPDATE tracked_cryptocurrencies SET last_updated_at = ? WHERE id = ?');
      database.transaction(() => {
        for (const quote of quotes) {
          insert.run(quote.cryptoId, quote.symbol, quote.name, quote.price, obtainedAt);
          update.run(obtainedAt, quote.cryptoId);
        }
      })();
      return undefined;
    }
    case 'close':
      database.close();
      return undefined;
    default:
      throw new Error(`Unknown SQLite worker operation: ${request.operation}`);
  }
}

port.on('message', (request: WorkerRequest) => {
  try {
    port.postMessage({ id: request.id, result: execute(request) });
  } catch (error) {
    port.postMessage({ id: request.id, error: errorRecord(error) });
  }
});

try {
  initialize((workerData as WorkerInput).databasePath);
  port.postMessage({ type: 'ready' });
} catch (error) {
  port.postMessage({ type: 'initError', error: errorRecord(error) });
}
