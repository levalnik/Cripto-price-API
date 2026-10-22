import http from 'node:http';
import { AddressInfo } from 'node:net';
import { CoinMarketCapClient } from '../src/infrastructure/coinmarketcap-client';

async function withServer(handler: http.RequestListener, run: (baseURL: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeIdleConnections?.();
    await closed;
  }
}

describe('CoinMarketCapClient', () => {
  it('sends the API key and USD conversion and parses quotes', async () => {
    let requestUrl = '';
    let apiKeyHeader = '';
    await withServer((req, res) => {
      requestUrl = req.url || '';
      apiKeyHeader = String(req.headers['x-cmc_pro_api_key'] || '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: { error_code: 0 },
        data: {
          BTC: { quote: { USD: { price: 65000 } } },
          ETH: { quote: { USD: { price: 3000 } } }
        }
      }));
    }, async (baseURL) => {
      const client = new CoinMarketCapClient('cmc-test-secret', baseURL, 1000);
      await expect(client.fetchQuotes(['BTC', 'ETH'])).resolves.toEqual([
        { symbol: 'BTC', price: 65000 },
        { symbol: 'ETH', price: 3000 }
      ]);
      const parsedUrl = new URL(requestUrl, baseURL);
      expect(parsedUrl.pathname).toBe('/v1/cryptocurrency/quotes/latest');
      expect(parsedUrl.searchParams.get('symbol')).toBe('BTC,ETH');
      expect(parsedUrl.searchParams.get('convert')).toBe('USD');
      expect(apiKeyHeader).toBe('cmc-test-secret');
    });
  });

  it('rejects an upstream API error response', async () => {
    let requests = 0;
    await withServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: { error_code: 1006, error_message: 'Invalid API key' }, data: {} }));
    }, async (baseURL) => {
      const client = new CoinMarketCapClient('cmc-test-secret', baseURL, 1000);
      await expect(client.fetchQuotes(['BTC'])).rejects.toThrow('CoinMarketCap returned error 1006');
      expect(requests).toBe(1);
    });
  });

  it('retries a transient upstream failure with a bounded delay', async () => {
    let requests = 0;
    await withServer((_req, res) => {
      requests += 1;
      if (requests === 1) {
        res.writeHead(503);
        res.end('temporarily unavailable');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: { error_code: 0 }, data: { BTC: { quote: { USD: { price: 42 } } } } }));
    }, async (baseURL) => {
      const client = new CoinMarketCapClient('cmc-test-secret', baseURL, 1000, { maxRetries: 1, baseDelayMs: 1 });
      await expect(client.fetchQuotes(['BTC'])).resolves.toEqual([{ symbol: 'BTC', price: 42 }]);
      expect(requests).toBe(2);
    });
  });

  it('applies the configured timeout', async () => {
    await withServer((_req, _res) => undefined, async (baseURL) => {
      const client = new CoinMarketCapClient('cmc-test-secret', baseURL, 20, { maxRetries: 0 });
      await expect(client.fetchQuotes(['BTC'])).rejects.toMatchObject({ code: 'ECONNABORTED' });
    });
  });
});
