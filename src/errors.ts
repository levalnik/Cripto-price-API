export interface AppErrorOptions {
  context?: Record<string, unknown>;
  cause?: unknown;
}

/** Application-level error for the unique tracked-symbol constraint. */
export class DuplicateCryptoSymbolError extends Error {
  constructor() {
    super('A cryptocurrency with this symbol already exists');
    this.name = 'DuplicateCryptoSymbolError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A transient SQLite lock remained after the configured busy timeout. */
export class DatabaseBusyError extends Error {
  constructor(message = 'SQLite database is temporarily busy') {
    super(message);
    this.name = 'DatabaseBusyError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AppError extends Error {
  readonly timestamp = new Date().toISOString();
  readonly context?: Record<string, unknown>;
  readonly cause?: unknown;
  requestId?: string;

  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    options: AppErrorOptions = {}
  ) {
    super(message);
    this.name = 'AppError';
    this.context = options.context;
    this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toResponse(requestId: string): Record<string, unknown> {
    this.requestId = requestId;
    return {
      error: this.code,
      message: this.message,
      statusCode: this.statusCode,
      timestamp: this.timestamp,
      requestId,
      ...(this.context ? { context: this.context } : {})
    };
  }
}
