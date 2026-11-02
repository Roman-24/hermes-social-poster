import pino, { type Logger as PinoLogger } from 'pino';

/** Keys whose values are redacted wherever they appear in a log object. */
const REDACT_PATHS = [
  'authorization',
  'cookie',
  'token',
  'nsec',
  'secret',
  'password',
  'apiKey',
  'appPassword',
  'accessToken',
  'refreshToken',
  'sk',
  '*.authorization',
  '*.cookie',
  '*.token',
  '*.nsec',
  '*.secret',
  '*.password',
  '*.apiKey',
  '*.appPassword',
  '*.accessToken',
  '*.refreshToken',
  '*.sk',
  'req.headers.authorization',
  'req.headers.cookie',
  'secrets',
  '*.secrets',
];

export type Logger = PinoLogger;

export function createLogger(level = 'info', pretty = false): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: 'social-poster' },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss',
              ignore: 'pid,hostname,service',
            },
          },
        }
      : {}),
  });
}

/** Silent logger for tests. */
export function nullLogger(): Logger {
  return pino({ level: 'silent' });
}
