import fs from 'node:fs';

export interface AppConfig {
  port: number;
  apiKey: string;
  readOnlyApiKey?: string;
  cmcApiKey: string;
  cmcBaseUrl?: string;
  cmcTimeoutMs: number;
  syncIntervalMs: number;
  databasePath: string;
  logLevel: 'error' | 'warn' | 'info';
}

export function loadEnvFile(filePath = '.env'): void {
  if (!fs.existsSync(filePath)) return;
  const contents = fs.readFileSync(filePath, 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    const key = match?.[1];
    let value = match?.[2];
    if (!key || value === undefined || process.env[key] !== undefined) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    process.env[key] = value;
  }
}

function positiveInteger(value: string | undefined, fallback: number, name: string, maximum = 2_147_483_647): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

export function readConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const apiKey = environment.API_KEY;
  const readOnlyApiKey = environment.READ_API_KEY || undefined;
  const cmcApiKey = environment.CMC_API_KEY;
  if (!apiKey || apiKey.length < 16) throw new Error('API_KEY must be set and contain at least 16 characters');
  if (readOnlyApiKey && readOnlyApiKey.length < 16) throw new Error('READ_API_KEY must contain at least 16 characters');
  if (readOnlyApiKey && readOnlyApiKey === apiKey) throw new Error('READ_API_KEY must differ from API_KEY');
  if (!cmcApiKey) throw new Error('CMC_API_KEY must be set');
  const logLevel = environment.LOG_LEVEL || 'info';
  if (!['error', 'warn', 'info'].includes(logLevel)) throw new Error('LOG_LEVEL must be error, warn or info');
  const databasePath = environment.DATABASE_PATH || './data/prices.sqlite';
  if (!databasePath.trim() || databasePath === ':memory:') {
    throw new Error('DATABASE_PATH must point to a persistent SQLite file');
  }

  return {
    port: positiveInteger(environment.PORT, 3000, 'PORT', 65535),
    apiKey,
    readOnlyApiKey,
    cmcApiKey,
    cmcBaseUrl: environment.CMC_BASE_URL,
    cmcTimeoutMs: positiveInteger(environment.CMC_TIMEOUT_MS, 5000, 'CMC_TIMEOUT_MS'),
    syncIntervalMs: positiveInteger(environment.SYNC_INTERVAL_MS, 60000, 'SYNC_INTERVAL_MS'),
    databasePath,
    logLevel: logLevel as AppConfig['logLevel']
  };
}
