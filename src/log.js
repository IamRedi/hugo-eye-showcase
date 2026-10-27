import { maskSecrets } from './config.js'

function line(level, args) {
  const ts = new Date().toISOString()
  const masked = args.map(a => maskSecrets(typeof a === 'string' ? a : JSON.stringify(a)))
  const out = `[${ts}] [hugo-eye] [${level}] ${masked.join(' ')}`
  if (level === 'error') console.error(out)
  else if (level === 'warn') console.warn(out)
  else console.log(out)
}

export const log = {
  info: (...args) => line('info', args),
  warn: (...args) => line('warn', args),
  error: (...args) => line('error', args),
}
