import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CryptoRepository } from '../src/infrastructure/sqlite-repository';

it('adds symbol and name snapshots when opening a database created by the earlier schema', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crypto-price-migration-'));
  const databasePath = path.join(directory, 'legacy.sqlite');
  const legacy = new Database(databasePath);
  try {
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE tracked_cryptocurrencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_updated_at TEXT
      );
      CREATE TABLE price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crypto_id INTEGER NOT NULL REFERENCES tracked_cryptocurrencies(id) ON DELETE CASCADE,
        price REAL NOT NULL CHECK(price >= 0),
        currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency = 'USD'),
        obtained_at TEXT NOT NULL
      );
      INSERT INTO tracked_cryptocurrencies(symbol, name, created_at) VALUES ('BTC', 'Bitcoin', '2025-01-01T00:00:00.000Z');
      INSERT INTO price_history(crypto_id, price, currency, obtained_at) VALUES (1, 50000, 'USD', '2025-01-02T00:00:00.000Z');
    `);
  } finally {
    legacy.close();
  }

  const repository = await CryptoRepository.open(databasePath);
  try {
    expect(await repository.getHistory(1, 10)).toEqual([expect.objectContaining({
      crypto_id: 1,
      symbol: 'BTC',
      name: 'Bitcoin',
      price: 50000
    })]);
  } finally {
    await repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
