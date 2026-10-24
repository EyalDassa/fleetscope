// Errors shared by the push modules (push.ts re-exports them, so existing imports keep working).
export class PushError extends Error {
  override name = "PushError";
}

export class GrafanaApiError extends PushError {
  override name = "GrafanaApiError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
