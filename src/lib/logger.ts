import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  // Never log secrets or auth material
  redact: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.passwordHash', '*.token'],
  ...(isProd ? {} : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }),
});
