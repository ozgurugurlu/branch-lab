import type { Actor } from "./types";

export type CapabilityProfile = NonNullable<Actor["capabilityProfile"]>;

/** Client-safe catalog; execution permissions are enforced again in scoped tool closures. */
export const CAPABILITY_PROFILES = {
  community: {
    label: "Community liaison",
    description:
      "Reads connected voices, personal memory, and direct contacts.",
    tools: ["inspect_neighbor_events", "recall_own_memory", "inspect_contacts"],
  },
  research: {
    label: "Evidence researcher",
    description:
      "Reads assigned evidence and personal memory; may search the web with explicit consent.",
    tools: [
      "read_assigned_evidence",
      "recall_own_memory",
      "compare_observed_stances",
    ],
  },
  operations: {
    label: "Operations planner",
    description:
      "Examines scenario interventions, assigned evidence, and personal memory.",
    tools: [
      "inspect_interventions",
      "read_assigned_evidence",
      "recall_own_memory",
    ],
  },
  policy: {
    label: "Policy reviewer",
    description:
      "Examines direct contacts, interventions, and personal memory.",
    tools: ["inspect_contacts", "inspect_interventions", "recall_own_memory"],
  },
} as const;

/** Profiles are simulation assumptions inferred from fictional roles, never real-person permissions. */
export function capabilityProfileFor(
  actor: Pick<Actor, "id" | "role" | "goal" | "capabilityProfile">,
): CapabilityProfile {
  if (actor.capabilityProfile && actor.capabilityProfile in CAPABILITY_PROFILES)
    return actor.capabilityProfile;
  const role = `${actor.role} ${actor.goal}`.toLowerCase();
  if (/research|analyst|scientist|evidence|data|journalist|skeptic/.test(role))
    return "research";
  if (/policy|regulat|council|govern|legal|official/.test(role))
    return "policy";
  if (
    /operat|engineer|business|merchant|deliver|builder|vendor|manager/.test(
      role,
    )
  )
    return "operations";
  if (/community|resident|parent|student|advocat|organizer|worker/.test(role))
    return "community";
  const index = Number(actor.id.match(/(\d+)$/)?.[1] ?? 1) - 1;
  return (["community", "research", "operations", "policy"] as const)[
    Math.abs(index) % 4
  ];
}
