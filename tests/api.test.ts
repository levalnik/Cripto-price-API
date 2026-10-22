import request from 'supertest';
import { createApp } from '../src/app';
import { CryptoRepository } from '../src/infrastructure/sqlite-repository';
import { PriceSynchronizer } from '../src/services/price-synchronizer';
import { DatabaseBusyError } from '../src/errors';
import { CryptoStore } from '../src/ports';

const API_KEY = 'test-api-key-that-is-long-enough';
const READ_API_KEY = 'read-only-api-key-that-is-long';
const quoteFetcher = { fetchQuotes: jest.fn(async (symbols: string[]) => symbols.map((symbol) => ({ symbol, price: symbol === 'BTC' ? 65000 : 100 }))) };

describe('REST API', () => {
  let repository: CryptoRepository;
  let synchronizer: PriceSynchronizer;
  let app: ReturnType<typeof createApp>;
  let auth: Record<string, string>;

  beforeEach(async () => {
    repository = await CryptoRepository.open(':memory:');
    quoteFetcher.fetchQuotes.mockClear();
    synchronizer = new PriceSynchronizer(repository, quoteFetcher);
    app = createApp({ repository, synchronizer, apiKey: API_KEY });
    auth = { Authorization: `Bearer ${API_KEY}` };
  });
  afterEach(async () => repository.close());

  it('serves health and status without authentication', async () => {
    await request(app).get('/health').expect(200, { status: 'ok' });
    await request(app).get('/status').expect(200, { status: 'ok' });
  });
  it('writes structured request logs with the response correlation id', async () => {
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const loggedApp = createApp({ repository, synchronizer, apiKey: API_KEY, logger });
    const response = await request(loggedApp).get('/health').expect(200);
    expect(logger.info).toHaveBeenCalledWith('http.request', expect.objectContaining({
      requestId: response.headers['x-request-id'],
      path: '/health',
      statusCode: 200
    }));
  });
  it('reports database unavailability from the health endpoint', async () => {
    await repository.close();
    await request(app).get('/health').expect(503).expect(({ headers, body }) => {
      expect(body).toMatchObject({
        error: 'ServiceUnavailable',
        statusCode: 503,
        requestId: headers['x-request-id'],
        context: { dependency: 'sqlite' }
      });
      expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
    });
    await request(app).get('/status').expect(503);
  });
  it('returns service unavailable when SQLite remains locked after waiting', async () => {
    jest.spyOn(repository, 'listCryptos').mockRejectedValue(new DatabaseBusyError());
    await request(app).get('/api/cryptocurrencies').set(auth).expect(503)
      .expect(({ body }) => expect(body).toMatchObject({
        error: 'ServiceUnavailable',
        statusCode: 503,
        context: { dependency: 'sqlite' }
      }));
  });
  it('rejects unknown routes under API auth boundary without a key', async () => {
    await request(app).get('/api/cryptocurrencies').expect(401).expect(({ headers, body }) => {
      expect(headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/i);
      expect(body).toMatchObject({ error: 'Unauthorized', statusCode: 401, requestId: headers['x-request-id'] });
      expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
    });
  });
  it('returns a structured not-found error for an authenticated unknown route', async () => {
    await request(app).get('/api/no-such-endpoint').set(auth).expect(404).expect(({ headers, body }) => {
      expect(body).toMatchObject({
        error: 'NotFound',
        statusCode: 404,
        requestId: headers['x-request-id'],
        context: { path: '/api/no-such-endpoint' }
      });
      expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
    });
  });
  it('checks API authorization before parsing a request body', async () => {
    await request(app).post('/api/cryptocurrencies').set('Content-Type', 'application/json').send('{').expect(401);
    await request(app).post('/api/cryptocurrencies').set(auth).set('Content-Type', 'application/json').send('{').expect(400);
  });

  it('allows a read-only key to read and denies write operations', async () => {
    await repository.createCrypto('BTC', 'Bitcoin');
    const readOnlyApp = createApp({ repository, synchronizer, apiKey: API_KEY, readOnlyApiKey: READ_API_KEY });
    await request(readOnlyApp).get('/api/cryptocurrencies').set('Authorization', `Bearer ${READ_API_KEY}`).expect(200);
    await request(readOnlyApp).post('/api/sync').set('Authorization', `Bearer ${READ_API_KEY}`).expect(403)
      .expect(({ body }) => expect(body).toMatchObject({ error: 'Forbidden', statusCode: 403 }));
    await request(readOnlyApp).post('/api/cryptocurrencies').set('Authorization', `Bearer ${READ_API_KEY}`)
      .send({ symbol: 'ETH', name: 'Ethereum' }).expect(403);
    await request(readOnlyApp).post('/api/cryptocurrencies').set(auth).send({ symbol: 'ETH', name: 'Ethereum' }).expect(201);
  });

  it('lists tracked cryptocurrencies and authenticates the endpoint', async () => {
    await repository.createCrypto('BTC', 'Bitcoin');
    await request(app).get('/api/cryptocurrencies').set(auth).expect(200).expect(({ body }) => expect(body).toHaveLength(1));
    await request(app).get('/api/cryptocurrencies').set('Authorization', 'Bearer wrong').expect(401);
  });

  it('creates a cryptocurrency and rejects invalid input or duplicate symbols', async () => {
    await request(app).post('/api/cryptocurrencies').set(auth).send({ symbol: 'eth', name: 'Ethereum' }).expect(201)
      .expect(({ body }) => { expect(body.symbol).toBe('ETH'); expect(body.name).toBe('Ethereum'); });
    await request(app).post('/api/cryptocurrencies').set(auth).send({ symbol: '!', name: '' }).expect(400);
    await request(app).post('/api/cryptocurrencies').set(auth).send({ symbol: 'BTC', name: 'Bitcoin', extra: true }).expect(400);
    await request(app).post('/api/cryptocurrencies').set(auth).send({ symbol: 'ETH', name: 'Duplicate' }).expect(409);
  });

  it('gets a cryptocurrency and validates or reports missing ids', async () => {
    const coin = await repository.createCrypto('BTC', 'Bitcoin');
    await request(app).get(`/api/cryptocurrencies/${coin.id}`).set(auth).expect(200).expect(({ body }) => expect(body.symbol).toBe('BTC'));
    await request(app).get('/api/cryptocurrencies/0').set(auth).expect(400);
    await request(app).get('/api/cryptocurrencies/1e0').set(auth).expect(400);
    await request(app).get('/api/cryptocurrencies/999').set(auth).expect(404);
  });

  it('updates a cryptocurrency and rejects invalid or missing records', async () => {
    const coin = await repository.createCrypto('BTC', 'Bitcoin');
    await request(app).put(`/api/cryptocurrencies/${coin.id}`).set(auth).send({ symbol: 'XBT', name: 'Bitcoin' }).expect(200)
      .expect(({ body }) => expect(body.symbol).toBe('XBT'));
    await request(app).put(`/api/cryptocurrencies/${coin.id}`).set(auth).send({ symbol: 'bad!', name: 'Bitcoin' }).expect(400);
    await request(app).put('/api/cryptocurrencies/999').set(auth).send({ symbol: 'BTC', name: 'Bitcoin' }).expect(404);
  });

  it('deletes a cryptocurrency and rejects invalid or missing ids', async () => {
    const coin = await repository.createCrypto('BTC', 'Bitcoin');
    await request(app).delete(`/api/cryptocurrencies/${coin.id}`).set(auth).expect(204);
    await request(app).delete('/api/cryptocurrencies/0').set(auth).expect(400);
    await request(app).delete('/api/cryptocurrencies/999').set(auth).expect(404);
  });

  it('returns latest prices after a successful sync and validates auth', async () => {
    await repository.createCrypto('BTC', 'Bitcoin');
    await synchronizer.sync();
    await request(app).get('/api/prices').set(auth).expect(200).expect(({ body }) => {
      expect(body.currency).toBe('USD'); expect(body.data[0].price).toBe(65000);
    });
    await request(app).get('/api/prices').expect(401);
  });

  it('returns history and rejects invalid dates, limits and missing coins', async () => {
    const coin = await repository.createCrypto('BTC', 'Bitcoin');
    await synchronizer.sync();
    await request(app).get(`/api/cryptocurrencies/${coin.id}/history`).set(auth).expect(200)
      .expect(({ body }) => { expect(body.currency).toBe('USD'); expect(body.data).toHaveLength(1); });
    await request(app).get(`/api/cryptocurrencies/${coin.id}/history?limit=0`).set(auth).expect(400);
    await request(app).get(`/api/cryptocurrencies/${coin.id}/history?limit=1e2`).set(auth).expect(400);
    await request(app).get(`/api/cryptocurrencies/${coin.id}/history?from=tomorrow`).set(auth).expect(400);
    await request(app).get(`/api/cryptocurrencies/${coin.id}/history?unexpected=true`).set(auth).expect(400);
    await request(app).get(`/api/cryptocurrencies/${coin.id}/history?from=2025-02-30T00%3A00%3A00Z`).set(auth).expect(400);
    await request(app).get('/api/cryptocurrencies/999/history').set(auth).expect(404);
  });

  it('keeps the original symbol and name in historical price records after a coin update', async () => {
    const coin = await repository.createCrypto('BTC', 'Bitcoin');
    await synchronizer.sync();
    await request(app).put(`/api/cryptocurrencies/${coin.id}`).set(auth).send({ symbol: 'XBT', name: 'Updated Bitcoin' }).expect(200);

    await request(app).get(`/api/cryptocurrencies/${coin.id}/history`).set(auth).expect(200).expect(({ body }) => {
      expect(body.data[0]).toMatchObject({ symbol: 'BTC', name: 'Bitcoin' });
    });
    await request(app).get('/api/prices').set(auth).expect(200).expect(({ body }) => expect(body.data).toHaveLength(0));
  });

  it('runs manual synchronization and reports upstream failures', async () => {
    await repository.createCrypto('BTC', 'Bitcoin');
    await request(app).post('/api/sync').set(auth).send({ unexpected: true }).expect(400);
    await request(app).post('/api/sync').set(auth).expect(200).expect(({ body }) => expect(body.updated).toBe(1));
    quoteFetcher.fetchQuotes.mockRejectedValueOnce(new Error('timeout'));
    await request(app).post('/api/sync').set(auth).expect(502);
    expect(await repository.getLatestPrices()).toHaveLength(1);
    await request(app).post('/api/sync').expect(401);
  });
});

describe('background synchronization', () => {
  it('starts an immediate periodic sync, handles external errors and stops cleanly', async () => {
    const repository = await CryptoRepository.open(':memory:');
    await repository.createCrypto('BTC', 'Bitcoin');
    let reportError!: () => void;
    let secondSyncStarted!: () => void;
    let syncSucceeded!: () => void;
    const initialFailureReported = new Promise<void>((resolve) => { reportError = resolve; });
    const nextAttemptStarted = new Promise<void>((resolve) => { secondSyncStarted = resolve; });
    const successfulSyncReported = new Promise<void>((resolve) => { syncSucceeded = resolve; });
    const fetchQuotes = jest.fn().mockRejectedValueOnce(new Error('external failure'))
      .mockImplementation(async () => {
        secondSyncStarted();
        return [{ symbol: 'BTC', price: 5 }];
      });
    const synchronizer = new PriceSynchronizer(repository, { fetchQuotes });
    const onError = jest.fn(reportError);
    const onSuccess = jest.fn(syncSucceeded);
    synchronizer.start(25, onError, onSuccess);
    try {
      await initialFailureReported;
      expect(onError).toHaveBeenCalledTimes(1);
      await nextAttemptStarted;
      await successfulSyncReported;
      await synchronizer.stop();
      expect(await repository.getLatestPrices()).toHaveLength(1);
      expect(fetchQuotes).toHaveBeenCalledTimes(2);
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ updated: 1 }));
    } finally {
      await synchronizer.stop();
      await repository.close();
    }
  });

  it('does not save a quote for a coin deleted while the CMC request is in flight', async () => {
    const repository = await CryptoRepository.open(':memory:');
    const coin = await repository.createCrypto('BTC', 'Bitcoin');
    const fetchQuotes = jest.fn(async () => {
      await repository.deleteCrypto(coin.id);
      return [{ symbol: 'BTC', price: 65000 }];
    });
    const synchronizer = new PriceSynchronizer(repository, { fetchQuotes });

    await expect(synchronizer.sync()).resolves.toMatchObject({ updated: 0, failedSymbols: [] });
    expect(await repository.getLatestPrices()).toEqual([]);
    await repository.close();
  });

  it('does not queue interval ticks while a background sync is still running', async () => {
    const repository = {
      listCryptos: jest.fn(async () => [{ id: 1, symbol: 'BTC', name: 'Bitcoin', created_at: '', last_updated_at: null }]),
      saveQuotes: jest.fn(async () => undefined)
    } as unknown as CryptoStore;
    let releaseFetch!: () => void;
    let fetchStarted!: () => void;
    let syncReported!: () => void;
    const blockedFetch = new Promise<Array<{ symbol: string; price: number }>>((resolve) => {
      releaseFetch = () => resolve([{ symbol: 'BTC', price: 10 }]);
    });
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    const reported = new Promise<void>((resolve) => { syncReported = resolve; });
    const fetchQuotes = jest.fn(() => {
      fetchStarted();
      return blockedFetch;
    });
    const synchronizer = new PriceSynchronizer(repository, { fetchQuotes });
    const onError = jest.fn();
    const onSuccess = jest.fn(syncReported);
    synchronizer.start(10, onError, onSuccess);

    try {
      await started;
      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(fetchQuotes).toHaveBeenCalledTimes(1);
      releaseFetch();
      await reported;
      await synchronizer.stop();
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      expect(fetchQuotes).toHaveBeenCalledTimes(1);
    } finally {
      releaseFetch();
      await synchronizer.stop();
    }
  });
});

describe('strict route input validation', () => {
  const key = 'strict-validation-api-key-long-enough';
  const synchronizer = { sync: jest.fn(async () => ({ updated: 0, failedSymbols: [], syncedAt: '2026-10-13T00:00:00.000Z' })) };
  const app = createApp({ repository: {} as CryptoStore, synchronizer, apiKey: key });
  const auth = { Authorization: `Bearer ${key}` };

  it('rejects unsupported query parameters on price history', async () => {
    await request(app).get('/api/cryptocurrencies/1/history?unexpected=true').set(auth).expect(400);
  });

  it('accepts a bodyless manual sync and rejects a supplied body', async () => {
    await request(app).post('/api/sync').set(auth).expect(200, {
      updated: 0,
      failedSymbols: [],
      syncedAt: '2026-10-13T00:00:00.000Z'
    });
    await request(app).post('/api/sync').set(auth).send({ unexpected: true }).expect(400);
    expect(synchronizer.sync).toHaveBeenCalledTimes(1);
  });
});
