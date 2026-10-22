import express, { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError, DatabaseBusyError, DuplicateCryptoSymbolError } from './errors';
import { LoggerPort, CryptoStore, PriceSync } from './ports';
import { silentLogger } from './logger';

export interface AppDependencies {
  repository: CryptoStore;
  synchronizer: PriceSync;
  apiKey: string;
  readOnlyApiKey?: string;
  logger?: LoggerPort;
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText || 0);
  const offsetMinute = Number(offsetMinuteText || 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (daysInMonth[month - 1] || 0) &&
    hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59 &&
    !Number.isNaN(Date.parse(value));
}

function positiveId(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}

function hasRequestBody(req: Request): boolean {
  const contentLength = req.header('content-length');
  if (contentLength !== undefined) return Number(contentLength) > 0;
  return Boolean(req.header('transfer-encoding')) || req.body !== undefined;
}

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res, next).catch(next);
  };
}

function matchesApiKey(supplied: string, expected?: string): boolean {
  if (!expected) return false;
  const actualBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function validCryptoInput(body: unknown): body is { symbol: string; name: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  return Object.keys(record).every((key) => key === 'symbol' || key === 'name') &&
    typeof record.symbol === 'string' && /^[A-Za-z0-9]{2,12}$/.test(record.symbol) &&
    typeof record.name === 'string' && record.name.length <= 100 && record.name.trim().length >= 1;
}

function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof DuplicateCryptoSymbolError) {
    return new AppError('Conflict', error.message, 409, {
      context: { constraint: 'tracked_cryptocurrencies.symbol' },
      cause: error
    });
  }
  if (error instanceof DatabaseBusyError) {
    return new AppError('ServiceUnavailable', 'Database is temporarily unavailable', 503, {
      context: { dependency: 'sqlite' },
      cause: error
    });
  }
  const candidate = error as { type?: string; code?: string } | undefined;
  if (candidate?.type === 'entity.parse.failed') {
    return new AppError('ValidationError', 'Request body must be valid JSON', 400);
  }
  if (candidate?.type === 'entity.too.large') {
    return new AppError('PayloadTooLarge', 'Request body must not exceed 32 KB', 413);
  }
  if (candidate?.type === 'charset.unsupported' || candidate?.type === 'encoding.unsupported') {
    return new AppError('UnsupportedMediaType', 'Request body encoding is not supported', 415);
  }
  return new AppError('InternalError', 'An internal error occurred', 500, { cause: error });
}

export function createApp({ repository, synchronizer, apiKey, readOnlyApiKey, logger = silentLogger }: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = randomUUID();
    const startedAt = process.hrtime.bigint();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      logger.info('http.request', {
        requestId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100
      });
    });
    next();
  });

  const statusHandler = asyncHandler(async (_req, res, next) => {
    if (!await repository.healthCheck()) {
      return next(new AppError('ServiceUnavailable', 'Database is unavailable', 503, {
        context: { dependency: 'sqlite' }
      }));
    }
    return res.json({ status: 'ok' });
  });
  app.get('/health', statusHandler);
  app.get('/status', statusHandler);

  app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
    const header = req.header('authorization') || '';
    const match = /^Bearer (.+)$/i.exec(header);
    const supplied = match?.[1] || '';
    const isAdmin = Boolean(match && matchesApiKey(supplied, apiKey));
    const isReadOnly = Boolean(match && !isAdmin && matchesApiKey(supplied, readOnlyApiKey));
    if (!isAdmin && !isReadOnly) {
      return next(new AppError('Unauthorized', 'A valid Bearer API key is required', 401));
    }
    _res.locals.apiRole = isAdmin ? 'admin' : 'readOnly';
    return next();
  });

  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    const isWriteRequest = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (res.locals.apiRole === 'readOnly' && isWriteRequest) {
      return next(new AppError('Forbidden', 'This API key has read-only access', 403));
    }
    return next();
  });

  // Parse JSON after authentication so malformed unauthenticated requests still receive 401.
  app.use(express.json({ limit: '32kb', strict: true }));

  app.get('/api/cryptocurrencies', asyncHandler(async (_req, res) => res.json(await repository.listCryptos())));

  app.post('/api/cryptocurrencies', asyncHandler(async (req, res, next) => {
    if (!validCryptoInput(req.body)) {
      return next(new AppError('ValidationError', 'symbol must be 2-12 alphanumeric characters; name must be 1-100 characters', 400, {
        context: { fields: ['symbol', 'name'] }
      }));
    }
    return res.status(201).json(await repository.createCrypto(req.body.symbol.toUpperCase(), req.body.name.trim()));
  }));

  app.get('/api/cryptocurrencies/:id', asyncHandler(async (req, res, next) => {
    const id = positiveId(req.params.id);
    if (!id) return next(new AppError('ValidationError', 'id must be a positive integer', 400, { context: { field: 'id' } }));
    const crypto = await repository.getCrypto(id);
    return crypto ? res.json(crypto) : next(new AppError('NotFound', 'Cryptocurrency not found', 404, { context: { id } }));
  }));

  app.put('/api/cryptocurrencies/:id', asyncHandler(async (req, res, next) => {
    const id = positiveId(req.params.id);
    if (!id || !validCryptoInput(req.body)) {
      return next(new AppError('ValidationError', 'Provide a positive id, valid symbol and name', 400, {
        context: { fields: ['id', 'symbol', 'name'] }
      }));
    }
    const updated = await repository.updateCrypto(id, req.body.symbol.toUpperCase(), req.body.name.trim());
    return updated ? res.json(updated) : next(new AppError('NotFound', 'Cryptocurrency not found', 404, { context: { id } }));
  }));

  app.delete('/api/cryptocurrencies/:id', asyncHandler(async (req, res, next) => {
    const id = positiveId(req.params.id);
    if (!id) return next(new AppError('ValidationError', 'id must be a positive integer', 400, { context: { field: 'id' } }));
    return await repository.deleteCrypto(id)
      ? res.status(204).end()
      : next(new AppError('NotFound', 'Cryptocurrency not found', 404, { context: { id } }));
  }));

  app.get('/api/prices', asyncHandler(async (_req, res) => res.json({ currency: 'USD', data: await repository.getLatestPrices() })));

  app.get('/api/cryptocurrencies/:id/history', asyncHandler(async (req, res, next) => {
    const id = positiveId(req.params.id);
    const rawLimit = req.query.limit;
    const validRawLimit = rawLimit === undefined || (typeof rawLimit === 'string' && /^\d+$/.test(rawLimit));
    const limit = rawLimit === undefined ? 100 : validRawLimit ? Number(rawLimit) : NaN;
    const from = req.query.from;
    const to = req.query.to;
    const allowedQueryParameters = new Set(['limit', 'from', 'to']);
    const hasUnknownQueryParameter = Object.keys(req.query).some((key) => !allowedQueryParameters.has(key));
    if (!id || hasUnknownQueryParameter || !validRawLimit || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000 ||
        (from !== undefined && !validDate(from)) || (to !== undefined && !validDate(to)) ||
        (typeof from === 'string' && typeof to === 'string' && Date.parse(from) > Date.parse(to))) {
      return next(new AppError('ValidationError', 'Invalid id, limit or ISO 8601 date range', 400, {
        context: { fields: ['id', 'limit', 'from', 'to'], ...(hasUnknownQueryParameter ? { allowedQueryParameters: [...allowedQueryParameters] } : {}) }
      }));
    }
    if (!await repository.getCrypto(id)) return next(new AppError('NotFound', 'Cryptocurrency not found', 404, { context: { id } }));
    return res.json({
      currency: 'USD',
      data: await repository.getHistory(
        id,
        limit,
        typeof from === 'string' ? new Date(from).toISOString() : undefined,
        typeof to === 'string' ? new Date(to).toISOString() : undefined
      )
    });
  }));

  app.post('/api/sync', asyncHandler(async (req, res, next) => {
    if (hasRequestBody(req)) {
      return next(new AppError('ValidationError', 'This endpoint does not accept a request body', 400));
    }
    try {
      return res.json(await synchronizer.sync());
    } catch (error) {
      return next(error);
    }
  }));

  app.use((req: Request, _res: Response, next: NextFunction) => {
    return next(new AppError('NotFound', 'Endpoint not found', 404, { context: { path: req.path } }));
  });

  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const appError = normalizeError(error);
    const requestId = String(res.locals.requestId || 'unknown');
    const fields = {
      requestId,
      code: appError.code,
      statusCode: appError.statusCode,
      message: appError.message,
      ...(appError.context ? { context: appError.context } : {}),
      ...(appError.statusCode >= 500 && error instanceof Error ? { stack: error.stack } : {})
    };
    if (appError.statusCode >= 500) logger.error('request.failed', fields);
    else logger.warn('request.rejected', fields);
    return res.status(appError.statusCode).json(appError.toResponse(requestId));
  };
  app.use(errors);
  return app;
}
