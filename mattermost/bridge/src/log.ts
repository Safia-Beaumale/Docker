const debugEnabled = process.env.BRIDGE_DEBUG === 'true';

type Level = 'debug' | 'info' | 'warn' | 'error';

function write(level: Level, args: unknown[]): void {
  const line = [new Date().toISOString(), level.toUpperCase().padEnd(5), ...args];
  if (level === 'error' || level === 'warn') console.error(...line);
  else console.log(...line);
}

export const log = {
  debug: (...args: unknown[]) => debugEnabled && write('debug', args),
  info: (...args: unknown[]) => write('info', args),
  warn: (...args: unknown[]) => write('warn', args),
  error: (...args: unknown[]) => write('error', args),
};
