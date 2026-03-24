export class Logger {
  constructor(private readonly verboseEnabled: boolean) {}

  private timestamp(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const seconds = String(now.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  info(message: string): void {
    process.stdout.write(`[${this.timestamp()}] [INFO] ${message}\n`);
  }

  warn(message: string): void {
    process.stdout.write(`[${this.timestamp()}] [WARN] ${message}\n`);
  }

  debug(message: string): void {
    if (this.verboseEnabled) {
      process.stdout.write(`[${this.timestamp()}] [DEBUG] ${message}\n`);
    }
  }
}
