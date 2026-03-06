export class ClawChefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClawChefError";
  }
}
