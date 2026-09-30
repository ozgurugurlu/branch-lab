"use client";

import { recoveryHint, requestError } from "./client-api";

export function InlineRequestError({ error }: { error: unknown }) {
  if (!error) return null;
  const failure = requestError(error);
  return (
    <div className="inline-error" role="alert">
      <p>{failure.message}</p>
      <small>{recoveryHint(failure)}</small>
      {failure.requestId && (
        <small className="error-request-id">
          Request ID <code>{failure.requestId}</code>
        </small>
      )}
    </div>
  );
}
