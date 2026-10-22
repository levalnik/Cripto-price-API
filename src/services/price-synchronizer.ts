import { AppError } from '../errors';
import { CryptoStore, QuoteProvider } from '../ports';
import { Quote, SyncResult } from '../types';

export class PriceSynchronizer {
  private timer?: NodeJS.Timeout;
  private running?: Promise<SyncResult>;
  private started = false;
  private intervalMs = 0;
  private onBackgroundError: (error: unknown) => void = console.error;
  private onBackgroundSuccess: (result: SyncResult) => void = () => undefined;

  constructor(private readonly repository: CryptoStore, private readonly client: QuoteProvider) {}

  sync(): Promise<SyncResult> {
    if (this.running) return this.running;
    const operation = this.performSync();
    const trackedOperation = operation.finally(() => {
      if (this.running === trackedOperation) this.running = undefined;
    });
    this.running = trackedOperation;
    return trackedOperation;
  }

  private async performSync(): Promise<SyncResult> {
    const cryptos = await this.repository.listCryptos();
    if (cryptos.length === 0) return { updated: 0, failedSymbols: [], syncedAt: new Date().toISOString() };
    let quotes: Quote[];
    try {
      quotes = await this.client.fetchQuotes(cryptos.map((crypto) => crypto.symbol));
    } catch (cause) {
      throw new AppError('UpstreamError', 'CoinMarketCap request failed', 502, {
        cause,
        context: { provider: 'CoinMarketCap' }
      });
    }
    const syncedAt = new Date().toISOString();
    const bySymbol = new Map(quotes.map((quote) => [quote.symbol.toUpperCase(), quote.price]));
    // CRUD may run while the upstream request is in flight. Resolve against the
    // current DB state so a deleted or renamed coin never receives a stale quote.
    const currentlyTracked = await this.repository.listCryptos();
    const found = currentlyTracked.flatMap((crypto) => {
      const price = bySymbol.get(crypto.symbol.toUpperCase());
      return price === undefined ? [] : [{ cryptoId: crypto.id, symbol: crypto.symbol, name: crypto.name, price }];
    });
    await this.repository.saveQuotes(found, syncedAt);
    const foundIds = new Set(found.map((row) => row.cryptoId));
    return {
      updated: found.length,
      failedSymbols: currentlyTracked.filter((crypto) => !foundIds.has(crypto.id)).map((crypto) => crypto.symbol),
      syncedAt
    };
  }

  start(
    intervalMs: number,
    onError: (error: unknown) => void = console.error,
    onSuccess: (result: SyncResult) => void = () => undefined
  ): void {
    if (this.started) return;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) {
      throw new Error('Background sync interval must be an integer between 1 and 2147483647 ms');
    }
    this.started = true;
    this.intervalMs = intervalMs;
    this.onBackgroundError = onError;
    this.onBackgroundSuccess = onSuccess;
    void this.runBackgroundTask();
  }

  private async runBackgroundTask(): Promise<void> {
    try {
      const result = await this.sync();
      this.onBackgroundSuccess(result);
    } catch (error) {
      try {
        this.onBackgroundError(error);
      } catch (reportingError) {
        // A broken observer must not create an unhandled rejection or stop future runs.
        console.error('Background sync error handler failed', reportingError);
      }
    } finally {
      if (this.started) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.runBackgroundTask();
        }, this.intervalMs);
      }
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running) {
      try {
        await this.running;
      } catch {
        // The periodic runner already reported this failure; shutdown only drains it.
      }
    }
  }
}
