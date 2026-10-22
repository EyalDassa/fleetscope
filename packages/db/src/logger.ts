import { type Logger, pino } from "pino";

export type { Logger };

/** JSON logger (pino). `level` comes from LOG_LEVEL. */
export function createLogger(name: string, level = "info"): Logger {
  return pino({ name, level });
}
