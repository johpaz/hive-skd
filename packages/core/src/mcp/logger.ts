export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogHandler = (level: LogLevel, context: string, message: string, data?: Record<string, unknown>) => void;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger {
  private context: string;
  // "debug" por defecto: antes `setLevel` guardaba el valor y nadie lo leía, así que
  // todo llegaba al handler; el default conserva eso hasta que alguien lo suba.
  private level: LogLevel = "debug";
  private handler: LogHandler | null = null;

  constructor(context: string, handler: LogHandler | null = null, level: LogLevel = "debug") {
    this.context = context;
    this.handler = handler;
    this.level = level;
  }

  setHandler(handler: LogHandler | null): void {
    this.handler = handler;
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    if (this.handler) {
      this.handler(level, this.context, message, data);
      return;
    }

    // Silent by default if no handler is set, to avoid standard console pollution.
    // The consumer (e.g., Hive Agent) should set a handler to bridge these logs.
  }

  debug(message: string, data?: Record<string, unknown>): void { this.log("debug", message, data); }
  info(message: string, data?: Record<string, unknown>): void { this.log("info", message, data); }
  warn(message: string, data?: Record<string, unknown>): void { this.log("warn", message, data); }
  error(message: string, data?: Record<string, unknown>): void { this.log("error", message, data); }

  child(context: string): Logger {
    return new Logger(`${this.context}:${context}`, this.handler, this.level);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }
}

export const logger = new Logger("mcp");
