export class Logger {
  constructor(private readonly verboseEnabled: boolean) {}

  info(message: string): void {
    process.stdout.write(`[INFO] ${message}\n`);
  }

  warn(message: string): void {
    process.stdout.write(`[WARN] ${message}\n`);
  }

  debug(message: string): void {
    if (this.verboseEnabled) {
      process.stdout.write(`[DEBUG] ${message}\n`);
    }
  }
}
