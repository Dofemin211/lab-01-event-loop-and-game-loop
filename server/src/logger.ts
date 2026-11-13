import type { ServerConfig } from './config.ts';

const LOG_PRIORITIES = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Infinity,
} as const;

type LogLevel = keyof typeof LOG_PRIORITIES;

export interface Logger {
  error(message?: unknown, ...details: unknown[]): void;
  event(name: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
  fatal(message?: unknown, ...details: unknown[]): void;
  flush(): Promise<void>;
  info(message?: unknown, ...details: unknown[]): void;
}

export function createLogger(level: ServerConfig['logLevel']): Logger {
  const write = (
    severity: Exclude<LogLevel, 'silent'>,
    message?: unknown,
    ...details: unknown[]
  ) => {
    if (LOG_PRIORITIES[severity] < LOG_PRIORITIES[level]) {
      return;
    }
    const record = {
      time: new Date().toISOString(),
      level: severity,
      message: message instanceof Error ? message.message : String(message ?? ''),
      ...(details.length > 0
        ? {
            details: details.map((detail) =>
              detail instanceof Error
                ? { message: detail.message, stack: detail.stack }
                : String(detail),
            ),
          }
        : {}),
    };
    const output = `${JSON.stringify(record)}\n`;
    if (severity === 'error' || severity === 'fatal') {
      process.stderr.write(output);
    } else {
      process.stdout.write(output);
    }
  };

  return {
    error: (message, ...details) => write('error', message, ...details),
    fatal: (message, ...details) => write('fatal', message, ...details),
    async flush() {
      await Promise.all([
        new Promise<void>((resolve) => process.stdout.write('', () => resolve())),
        new Promise<void>((resolve) => process.stderr.write('', () => resolve())),
      ]);
    },
    info: (message, ...details) => write('info', message, ...details),
    event(name, fields = {}) {
      if (LOG_PRIORITIES.info < LOG_PRIORITIES[level]) return;
      process.stdout.write(
        `${JSON.stringify({ time: new Date().toISOString(), level: 'info', event: name, ...fields })}\n`,
      );
    },
  };
}
