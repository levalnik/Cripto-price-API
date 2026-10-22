import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseBusyError, DuplicateCryptoSymbolError } from '../errors';
import { CryptoStore } from '../ports';
import { PriceRecord, PriceSnapshot, TrackedCrypto } from '../types';

interface RemoteError {
  name: string;
  message: string;
  code?: string;
}

interface WorkerMessage {
  type?: 'ready' | 'initError';
  id?: number;
  result?: unknown;
  error?: RemoteError;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function restoreError(record: RemoteError): Error {
  if (record.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
      /UNIQUE constraint failed: tracked_cryptocurrencies\.symbol/i.test(record.message)) {
    return new DuplicateCryptoSymbolError();
  }
  if (record.code === 'SQLITE_BUSY' || record.code === 'SQLITE_LOCKED') {
    return new DatabaseBusyError(record.message);
  }
  const error = new Error(record.message);
  error.name = record.name;
  if (record.code) Object.assign(error, { code: record.code });
  return error;
}

function workerScriptPath(): string {
  const besideCompiledModule = path.join(__dirname, 'sqlite-worker.js');
  if (fs.existsSync(besideCompiledModule)) return besideCompiledModule;
  return path.resolve(__dirname, '../../dist/src/infrastructure/sqlite-worker.js');
}

/** SQLite adapter. Synchronous SQLite work runs in a worker so HTTP stays non-blocking. */
export class CryptoRepository implements CryptoStore {
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private closed = false;
  private closing = false;
  private closeOperation?: Promise<void>;

  private constructor(databasePath: string) {
    if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });

    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    this.worker = new Worker(workerScriptPath(), { workerData: { databasePath } });
    this.worker.on('message', (message: WorkerMessage) => {
      if (message.type === 'ready') { resolveReady(); return; }
      if (message.type === 'initError') { rejectReady(restoreError(message.error || { name: 'Error', message: 'SQLite initialization failed' })); return; }
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(restoreError(message.error));
      else pending.resolve(message.result);
    });
    this.worker.on('error', (error) => {
      this.closing = true;
      this.closed = true;
      rejectReady(error);
      this.rejectPending(error);
    });
    this.worker.on('exit', (code) => {
      if (!this.closed) {
        this.closing = true;
        this.closed = true;
        const error = new Error(`SQLite worker exited unexpectedly with code ${code}`);
        rejectReady(error);
        this.rejectPending(error);
      }
    });
  }

  static async open(databasePath: string): Promise<CryptoRepository> {
    const repository = new CryptoRepository(databasePath);
    try {
      await repository.ready;
      return repository;
    } catch (error) {
      await repository.terminateWorker();
      throw error;
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private async request<T>(operation: string, payload?: Record<string, unknown>): Promise<T> {
    await this.ready;
    if (this.closed || (this.closing && operation !== 'close')) throw new Error('SQLite worker is closed');
    const retrySafe = ['listCryptos', 'getCrypto', 'getLatestPrices', 'getHistory', 'healthCheck'].includes(operation);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.sendRequest<T>(operation, payload);
      } catch (error) {
        if (!retrySafe || !(error instanceof DatabaseBusyError) || attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * (2 ** attempt)));
      }
    }
  }

  private sendRequest<T>(operation: string, payload?: Record<string, unknown>): Promise<T> {
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        this.worker.postMessage({ id, operation, payload });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  listCryptos(): Promise<TrackedCrypto[]> {
    return this.request('listCryptos');
  }

  getCrypto(id: number): Promise<TrackedCrypto | undefined> {
    return this.request('getCrypto', { id });
  }

  createCrypto(symbol: string, name: string): Promise<TrackedCrypto> {
    return this.request('createCrypto', { symbol, name });
  }

  updateCrypto(id: number, symbol: string, name: string): Promise<TrackedCrypto | undefined> {
    return this.request('updateCrypto', { id, symbol, name });
  }

  deleteCrypto(id: number): Promise<boolean> {
    return this.request('deleteCrypto', { id });
  }

  getLatestPrices(): Promise<PriceRecord[]> {
    return this.request('getLatestPrices');
  }

  getHistory(cryptoId: number, limit: number, from?: string, to?: string): Promise<PriceRecord[]> {
    return this.request('getHistory', { cryptoId, limit, from, to });
  }

  async healthCheck(): Promise<boolean> {
    try {
      return await this.request<boolean>('healthCheck');
    } catch {
      return false;
    }
  }

  saveQuotes(quotes: PriceSnapshot[], obtainedAt: string): Promise<void> {
    return this.request('saveQuotes', { quotes, obtainedAt });
  }

  close(): Promise<void> {
    if (this.closeOperation) return this.closeOperation;
    this.closing = true;
    this.closeOperation = (async () => {
      if (this.closed) return;
      try {
        await this.request<void>('close');
      } finally {
        await this.terminateWorker();
      }
    })();
    return this.closeOperation;
  }

  private async terminateWorker(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    this.closed = true;
    await this.worker.terminate();
  }
}
