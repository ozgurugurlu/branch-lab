"use client";

export default function GlobalError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          padding: "12vh 8vw",
          background: "#f5f4ef",
          color: "#242720",
          fontFamily: "Arial, sans-serif",
        }}
      >
        <main style={{ maxWidth: 600 }}>
          <p style={{ fontSize: 12, letterSpacing: 2 }}>BRANCHLAB</p>
          <h1 style={{ fontWeight: 500, fontSize: 36 }}>
            The application could not load.
          </h1>
          <p style={{ lineHeight: 1.8 }}>
            Try loading the workspace again. Last completed checkpoints are
            stored on the server. Refreshing does not repeat model requests.
          </p>
          <button
            onClick={() => retry()}
            style={{
              padding: "12px 20px",
              background: "#dc5a34",
              color: "white",
              border: 0,
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Try loading again
          </button>
        </main>
      </body>
    </html>
  );
}
