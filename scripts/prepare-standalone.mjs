import { cp, mkdir } from "node:fs/promises";

// Next's standalone output omits static assets by design; ship a complete runnable artifact.
await mkdir(".next/standalone/.next", { recursive: true });
await cp(".next/static", ".next/standalone/.next/static", { recursive: true });
await cp("public", ".next/standalone/public", { recursive: true });
