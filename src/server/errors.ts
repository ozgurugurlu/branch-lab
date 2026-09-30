export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public retryable = false,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Provider SDK errors may contain request bodies and credentials. Never echo them. */
export function publicError(error: unknown) {
  if (error instanceof AppError) return error;
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return new AppError(
      "TIMEOUT",
      "The operation timed out. Your last completed round is saved; you can retry.",
      504,
      true,
    );
  }
  return new AppError(
    "OPERATION_FAILED",
    "This operation could not finish. Check provider configuration and database connectivity, then retry. The last saved state is unchanged.",
    500,
    true,
  );
}
