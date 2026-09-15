export class ChannelConnectionError extends Error {
  readonly code: string;
  readonly status: number;
  readonly technical?: Record<string, unknown>;

  constructor(code: string, status: number, technical?: Record<string, unknown>) {
    super(code);
    this.name = "ChannelConnectionError";
    this.code = code;
    this.status = status;
    this.technical = technical;
  }
}
