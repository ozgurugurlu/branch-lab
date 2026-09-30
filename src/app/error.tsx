"use client";

import Link from "next/link";
import { RotateCcw } from "lucide-react";

export default function WorkspaceError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className="recovery-page">
      <span className="eyebrow">BRANCHLAB / WORKSPACE RECOVERY</span>
      <h1>The workspace could not be displayed.</h1>
      <p>
        Refresh the view to recover the latest saved state. An operation already
        sent to the server may still finish; refreshing does not rerun it.
      </p>
      <div>
        <button className="button primary" onClick={() => retry()}>
          <RotateCcw size={15} /> Try loading again
        </button>
        <Link className="button secondary" href="/">
          Open laboratory
        </Link>
      </div>
    </main>
  );
}
