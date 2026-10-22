import axios, { AxiosInstance } from 'axios';
import http from 'node:http';
import https from 'node:https';
import { QuoteProvider } from '../ports';
import { Quote } from '../types';

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

const transientNetworkCodes = new Set([
  'ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_NETWORK'
]);

function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    code?: unknown;
    response?: { status?: unknown; data?: { status?: { error_code?: unknown } } };
    cmcErrorCode?: unknown;
  };
  const httpStatus = Number(candidate.response?.status);
  return transientNetworkCodes.has(String(candidate.code)) || httpStatus === 429 || httpStatus >= 500 ||
    Number(candidate.cmcErrorCode ?? candidate.response?.data?.status?.error_code) === 1008;
}

function retryDelay(error: unknown, baseDelayMs: number, attempt: number): number {
  if (error && typeof error === 'object') {
    const response = (error as { response?: { headers?: Record<string, unknown> & { get?: (name: string) => unknown } } }).response;
    const rawRetryAfter = response?.headers?.get?.('retry-after') ?? response?.headers?.['retry-after'];
    if (typeof rawRetryAfter === 'string' && rawRetryAfter.trim()) {
      const seconds = Number(rawRetryAfter);
      const dateDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(rawRetryAfter) - Date.now();
      if (Number.isFinite(dateDelay) && dateDelay >= 0) return Math.min(dateDelay, 30_000);
    }
  }
  return Math.min(baseDelayMs * (2 ** attempt), 10_000);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class CoinMarketCapClient implements QuoteProvider {
  private readonly http: AxiosInstance;
  private readonly httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10, maxFreeSockets: 2 });
  private readonly httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10, maxFreeSockets: 2 });
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;

  constructor(
    apiKey: string,
    baseURL = 'https://pro-api.coinmarketcap.com',
    timeoutMs = 5000,
    retryOptions: RetryOptions = {}
  ) {
    this.maxRetries = retryOptions.maxRetries ?? 2;
    this.baseDelayMs = retryOptions.baseDelayMs ?? 250;
    if (!Number.isSafeInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > 5) {
      throw new Error('maxRetries must be an integer between 0 and 5');
    }
    if (!Number.isSafeInteger(this.baseDelayMs) || this.baseDelayMs < 0 || this.baseDelayMs > 10_000) {
      throw new Error('baseDelayMs must be an integer between 0 and 10000');
    }
    this.http = axios.create({
      baseURL,
      timeout: timeoutMs,
      headers: { 'X-CMC_PRO_API_KEY': apiKey, Accept: 'application/json' },
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent
    });
  }

  close(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  async fetchQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return [];
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.http.get('/v1/cryptocurrency/quotes/latest', {
          params: { symbol: symbols.join(','), convert: 'USD' }
        });
        const status = response.data?.status;
        if (status?.error_code !== undefined && Number(status.error_code) !== 0) {
          const error = new Error(`CoinMarketCap returned error ${status.error_code}: ${status.error_message || 'unknown error'}`);
          Object.assign(error, { cmcErrorCode: Number(status.error_code) });
          throw error;
        }
        const data = response.data?.data;
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('CoinMarketCap returned an invalid response');
        return symbols.flatMap((symbol) => {
          const item = data[symbol];
          const quote = Array.isArray(item) ? item[0] : item;
          const price = quote?.quote?.USD?.price;
          if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) return [];
          return [{ symbol, price }];
        });
      } catch (error) {
        if (attempt >= this.maxRetries || !isRetryable(error)) throw error;
        await delay(retryDelay(error, this.baseDelayMs, attempt));
      }
    }
  }
}
