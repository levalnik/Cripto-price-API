import { CryptoRepository } from '../src/infrastructure/sqlite-repository';

it('keeps the API event loop responsive while SQLite work runs in its worker', async () => {
  const repository = await CryptoRepository.open(':memory:');
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  try {
    await Promise.all(Array.from({ length: 200 }, (_, index) =>
      repository.createCrypto(`C${index.toString().padStart(3, '0')}`, `Coin ${index}`)
    ));
    expect(ticks).toBeGreaterThan(0);
  } finally {
    clearInterval(timer);
    await repository.close();
  }
});

it('rolls back the full quote batch when one insert violates a database constraint', async () => {
  const repository = await CryptoRepository.open(':memory:');
  const first = await repository.createCrypto('BTC', 'Bitcoin');
  const second = await repository.createCrypto('ETH', 'Ethereum');
  try {
    await expect(repository.saveQuotes([
      { cryptoId: first.id, symbol: first.symbol, name: first.name, price: 65000 },
      { cryptoId: second.id, symbol: second.symbol, name: second.name, price: -1 }
    ], '2026-10-12T00:00:00.000Z')).rejects.toThrow();

    expect(await repository.getLatestPrices()).toEqual([]);
    expect(await repository.getCrypto(first.id)).toMatchObject({ last_updated_at: null });
    expect(await repository.getCrypto(second.id)).toMatchObject({ last_updated_at: null });
  } finally {
    await repository.close();
  }
});
