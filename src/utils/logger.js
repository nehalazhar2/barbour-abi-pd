import { config } from '../config.js';

const fmt = (level, args) => {
  const ts = new Date().toISOString();
  return [`[${ts}] [${level}]`, ...args];
};

const debugEnabled = config.logging.level === 'debug';

export const logger = {
  info: (...args) => console.log(...fmt('INFO', args)),
  warn: (...args) => console.warn(...fmt('WARN', args)),
  error: (...args) => console.error(...fmt('ERROR', args)),
  debug: (...args) => {
    if (debugEnabled) console.log(...fmt('DEBUG', args));
  },
};
