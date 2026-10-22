import { readConfig } from '../src/config';

const validEnvironment = {
  API_KEY: 'test-api-key-that-is-long-enough',
  CMC_API_KEY: 'cmc-test-key'
};

describe('readConfig', () => {
  it('reads valid configuration and defaults to persistent SQLite storage', () => {
    expect(readConfig(validEnvironment)).toMatchObject({
      port: 3000,
      databasePath: './data/prices.sqlite',
      logLevel: 'info',
      cmcTimeoutMs: 5000,
      syncIntervalMs: 60000
    });
  });

  it('rejects non-persistent database paths and unsupported log levels', () => {
    expect(() => readConfig({ ...validEnvironment, DATABASE_PATH: ':memory:' })).toThrow('persistent SQLite file');
    expect(() => readConfig({ ...validEnvironment, LOG_LEVEL: 'verbose' })).toThrow('LOG_LEVEL');
  });

  it('accepts a distinct optional read-only key and validates its length', () => {
    expect(readConfig({ ...validEnvironment, READ_API_KEY: 'read-key-that-is-long-enough' }).readOnlyApiKey)
      .toBe('read-key-that-is-long-enough');
    expect(() => readConfig({ ...validEnvironment, READ_API_KEY: 'short' })).toThrow('READ_API_KEY');
    expect(() => readConfig({ ...validEnvironment, READ_API_KEY: validEnvironment.API_KEY })).toThrow('must differ');
  });
});
