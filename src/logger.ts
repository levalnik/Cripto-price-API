import { LoggerPort } from './ports';

export type LogLevel = 'error' | 'warn' | 'info';

const priority: Record<LogLevel, number> = { error: 0, warn: 1, info: 2 };

export class Logger implements LoggerPort {
  private readonly minimumLevel: LogLevel;

  constructor(level: string = 'info') {
    this.minimumLevel = Object.prototype.hasOwnProperty.call(priority, level) ? level as LogLevel : 'info';
  }

  info(event: string, fields: Record<string, unknown> = {}): void { this.write('info', event, fields); }
  warn(event: string, fields: Record<string, unknown> = {}): void { this.write('warn', event, fields); }
  error(event: string, fields: Record<string, unknown> = {}): void { this.write('error', event, fields); }

  private write(level: LogLevel, event: string, fields: Record<string, unknown>): void {
    if (priority[level] > priority[this.minimumLevel]) return;
    const line = JSON.stringify({ ...fields, timestamp: new Date().toISOString(), level, event });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}

export const silentLogger: LoggerPort = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};
