import { createApp } from './app';
import { readConfig, loadEnvFile } from './config';
import { AppError } from './errors';
import { CoinMarketCapClient } from './infrastructure/coinmarketcap-client';
import { CryptoRepository } from './infrastructure/sqlite-repository';
import { Logger } from './logger';
import { PriceSynchronizer } from './services/price-synchronizer';

export async function startServer() {
  loadEnvFile();
  const config = readConfig();
  const logger = new Logger(config.logLevel);

  // Composition root: concrete infrastructure adapters are wired to application ports here.
  const repository = await CryptoRepository.open(config.databasePath);
  const coinMarketCap = new CoinMarketCapClient(config.cmcApiKey, config.cmcBaseUrl, config.cmcTimeoutMs);
  const synchronizer = new PriceSynchronizer(repository, coinMarketCap);
  const app = createApp({ repository, synchronizer, apiKey: config.apiKey, readOnlyApiKey: config.readOnlyApiKey, logger });
  const server = app.listen(config.port, () => {
    logger.info('server.started', { port: config.port, database: config.databasePath });
  });

  synchronizer.start(
    config.syncIntervalMs,
    (error) => logger.error('background.sync.failed', errorFields(error)),
    (result) => logger.info('background.sync.succeeded', {
      syncedAt: result.syncedAt,
      updated: result.updated,
      failedSymbols: result.failedSymbols
    })
  );

  let shutdownOperation: Promise<void> | undefined;
  const shutdown = (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownOperation) return shutdownOperation;
    shutdownOperation = (async () => {
      logger.info('server.shutdown.started', { signal });
      const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      await synchronizer.stop();
      await serverClosed;
      coinMarketCap.close();
      await repository.close();
      logger.info('server.shutdown.completed', { signal });
    })();
    return shutdownOperation;
  };

  const handleSignal = (signal: NodeJS.Signals) => {
    void (async () => {
      try {
        await shutdown(signal);
      } catch (error) {
        logger.error('server.shutdown.failed', errorFields(error));
        process.exitCode = 1;
        await repository.close();
      }
    })();
  };
  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  return { app, server, repository, synchronizer, shutdown };
}

function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof AppError) {
    return {
      error: error.message,
      code: error.code,
      statusCode: error.statusCode,
      context: error.context,
      cause: error.cause instanceof Error ? error.cause.message : undefined,
      stack: error.stack
    };
  }
  if (error instanceof Error) return { error: error.message, stack: error.stack };
  return { error: String(error) };
}

if (require.main === module) {
  void startServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', event: 'server.start.failed', message }));
    process.exitCode = 1;
  });
}
