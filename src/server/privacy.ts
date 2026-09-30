import type { PrivacyInfo } from "@/lib/types";
import { database, storageMode } from "./db";
import { requiresPassword, type Session } from "./security";

export async function privacyInfo(session: Session): Promise<PrivacyInfo> {
  const db = await database();
  const result = await db.execute({
    sql: `SELECT (SELECT COUNT(*) FROM simulations WHERE owner = $1) AS runs,
      (SELECT COUNT(*) FROM operations WHERE owner = $2 AND status = 'running' AND expires_at > $3) AS active,
      (SELECT expires_at FROM sessions WHERE id = $4) AS expiry`,
    args: [session.id, session.id, Date.now(), session.id],
  });
  return {
    storage: storageMode(),
    sessionExpiresAt: new Date(Number(result.rows[0].expiry)).toISOString(),
    simulationCount: Number(result.rows[0].runs),
    activeOperations: Number(result.rows[0].active),
    retentionDays: 30,
    providerDataPolicy:
      "Scenario text, permitted source excerpts and conversation context are sent to the run's configured inference provider. Demo runs make no model calls. Local providers use the operator's configured endpoint, which may be remote. Separately enabled web search sends model-authored queries to Brave; source text can influence these queries. Search result titles and URLs are saved in execution history. Provider retention is governed by your provider account. This server stores complete source text and saved outputs; workspace owners can inspect and export them. Expired workspaces are removed when application traffic triggers cleanup; operator backups and provider records are outside this deletion.",
    instanceProtected: requiresPassword(),
  };
}

/** Revocation and deletion commit together; late model responses cannot recreate erased records. */
export async function eraseWorkspace(owner: string) {
  const db = await database();
  await db.batch(
    [
      {
        sql: "INSERT INTO revoked_sessions (id, revoked_at) VALUES ($1, $2) ON CONFLICT(id) DO UPDATE SET revoked_at = excluded.revoked_at",
        args: [owner, Date.now()],
      },
      { sql: "DELETE FROM simulations WHERE owner = $1", args: [owner] },
      { sql: "DELETE FROM trace_events WHERE owner = $1", args: [owner] },
      { sql: "DELETE FROM operations WHERE owner = $1", args: [owner] },
      {
        sql: "DELETE FROM rate_limits WHERE key IN ($1, $2, $3, $4, $5)",
        args: [
          `requests:${owner}`,
          `create:${owner}`,
          `model-calls:${owner}`,
          `login:${owner}`,
          `web-search:${owner}`,
        ],
      },
      { sql: "DELETE FROM sessions WHERE id = $1", args: [owner] },
    ],
    "write",
  );
}
