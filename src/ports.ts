import { PriceRecord, PriceSnapshot, Quote, SyncResult, TrackedCrypto } from './types';

/** Application-facing ports; infrastructure adapters implement these contracts. */
export interface CryptoStore {
  listCryptos(): Promise<TrackedCrypto[]>;
  getCrypto(id: number): Promise<TrackedCrypto | undefined>;
  createCrypto(symbol: string, name: string): Promise<TrackedCrypto>;
  updateCrypto(id: number, symbol: string, name: string): Promise<TrackedCrypto | undefined>;
  deleteCrypto(id: number): Promise<boolean>;
  getLatestPrices(): Promise<PriceRecord[]>;
  getHistory(cryptoId: number, limit: number, from?: string, to?: string): Promise<PriceRecord[]>;
  saveQuotes(quotes: PriceSnapshot[], obtainedAt: string): Promise<void>;
  healthCheck(): Promise<boolean>;
  close(): Promise<void>;
}

export interface QuoteProvider {
  fetchQuotes(symbols: string[]): Promise<Quote[]>;
}

export interface PriceSync {
  sync(): Promise<SyncResult>;
}

export interface LoggerPort {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}
