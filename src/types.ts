export interface TrackedCrypto {
  id: number;
  symbol: string;
  name: string;
  created_at: string;
  last_updated_at: string | null;
}

export interface PriceRecord {
  id: number;
  crypto_id: number;
  symbol: string;
  name: string;
  price: number;
  currency: 'USD';
  obtained_at: string;
}

export interface Quote {
  symbol: string;
  price: number;
}

export interface PriceSnapshot {
  cryptoId: number;
  symbol: string;
  name: string;
  price: number;
}

export interface SyncResult {
  updated: number;
  failedSymbols: string[];
  syncedAt: string;
}
