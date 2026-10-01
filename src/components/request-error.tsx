"use client";

import { recoveryHint, requestError, type RecoveryContext } from "./client-api";

export function InlineRequestError({
  error,
  context = "simulation",
}: {
  error: unknown;
  context?: RecoveryContext;
}) {
  if (!error) return null;
  const failure = requestError(error);
  return (
    <div className="inline-error" role="alert">
      <p>{failure.message}</p>
      <small>{recoveryHint(failure, context)}</small>
      {failure.requestId && (
        <small className="error-request-id">
          Request ID <code>{failure.requestId}</code>
        </small>
      )}
    </div>
  );
}
