type LogFields = Record<string, string | number | boolean | null | undefined>;

function write(level: "info" | "warn" | "error", message: string, fields: LogFields): void {
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...fields })}\n`,
  );
}

export const log = {
  info(message: string, fields: LogFields = {}) {
    write("info", message, fields);
  },
  warn(message: string, fields: LogFields = {}) {
    write("warn", message, fields);
  },
  error(message: string, fields: LogFields = {}) {
    write("error", message, fields);
  },
};
