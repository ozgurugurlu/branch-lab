import type {
  Action,
  CreateSimulationInput,
  Report,
  Simulation,
  Source,
  World,
} from "@/lib/types";
import { clamp, seededValue } from "@/lib/simulation-math";
import type { ActorObservation } from "./domain";

type Archetype = [name: string, role: string, goal: string, stance: number];
const profiles: Record<string, Archetype[]> = {
  urban: [
    [
      "Maya Chen",
      "Neighborhood organizer",
      "Protect affordable access and make residents part of the decision",
      -0.38,
    ],
    [
      "Jonas Reed",
      "Local business owner",
      "Keep the district accessible to customers without raising operating costs",
      -0.56,
    ],
    [
      "Lena Ortiz",
      "City policy lead",
      "Deliver a workable public policy with visible community benefits",
      0.64,
    ],
    [
      "Idris Cole",
      "Daily commuter",
      "Keep everyday journeys reliable and affordable",
      -0.16,
    ],
    [
      "Nora Vale",
      "Mobility researcher",
      "Ask for measured outcomes and a reversible pilot",
      0.42,
    ],
    [
      "Eli Park",
      "Public space advocate",
      "Create safer streets and share the benefits fairly",
      0.7,
    ],
    [
      "Ada Wells",
      "Accessibility advisor",
      "Keep essential trips possible for people with limited alternatives",
      -0.22,
    ],
    [
      "Theo Brooks",
      "Delivery cooperative lead",
      "Maintain reliable last-mile access",
      -0.44,
    ],
  ],
  product: [
    [
      "Maya Chen",
      "Longtime customer",
      "Preserve the value and predictability of the product",
      -0.4,
    ],
    [
      "Jonas Reed",
      "Independent creator",
      "Protect margins and the flexibility to work independently",
      -0.6,
    ],
    [
      "Lena Ortiz",
      "Product strategist",
      "Make a sustainable change customers can understand",
      0.64,
    ],
    [
      "Idris Cole",
      "Prospective customer",
      "Compare the proposal against affordable alternatives",
      -0.1,
    ],
    [
      "Nora Vale",
      "Customer researcher",
      "Separate stated enthusiasm from demonstrated demand",
      0.25,
    ],
    [
      "Eli Park",
      "Power user",
      "Gain useful improvements without losing established workflows",
      0.55,
    ],
    [
      "Ada Wells",
      "Community moderator",
      "Preserve trust and respond to overlooked objections",
      -0.2,
    ],
    [
      "Theo Brooks",
      "Small team buyer",
      "Get predictable costs and a clear return for the team",
      -0.45,
    ],
  ],
  technology: [
    [
      "Maya Chen",
      "Employee representative",
      "Protect autonomy, fair treatment, and understandable decisions",
      -0.55,
    ],
    [
      "Jonas Reed",
      "Team manager",
      "Improve delivery without disrupting the team",
      0.22,
    ],
    [
      "Lena Ortiz",
      "Technology sponsor",
      "Demonstrate a practical benefit with accountable ownership",
      0.67,
    ],
    [
      "Idris Cole",
      "Frontline specialist",
      "Keep useful skills and avoid extra administrative work",
      -0.28,
    ],
    [
      "Nora Vale",
      "Independent evaluator",
      "Require evidence, reversibility, and a clear comparison",
      0.2,
    ],
    [
      "Eli Park",
      "Early adopter",
      "Explore useful capabilities and share what works",
      0.7,
    ],
    [
      "Ada Wells",
      "Data steward",
      "Limit unnecessary data collection and preserve clear access controls",
      -0.4,
    ],
    [
      "Theo Brooks",
      "Operations lead",
      "Make the change reliable within existing budgets",
      0.1,
    ],
  ],
  community: [
    [
      "Maya Chen",
      "Community organizer",
      "Make sure the people affected have a meaningful voice",
      -0.3,
    ],
    [
      "Jonas Reed",
      "Resource-constrained participant",
      "Avoid costs that would exclude smaller participants",
      -0.55,
    ],
    [
      "Lena Ortiz",
      "Proposal sponsor",
      "Build support for a workable and transparent change",
      0.65,
    ],
    [
      "Idris Cole",
      "Undecided participant",
      "Understand personal consequences before committing",
      -0.05,
    ],
    [
      "Nora Vale",
      "Independent researcher",
      "Check assumptions and track unintended consequences",
      0.2,
    ],
    [
      "Eli Park",
      "Early supporter",
      "Help the proposal demonstrate value through a small pilot",
      0.6,
    ],
    [
      "Ada Wells",
      "Accountability advocate",
      "Make responsibility, appeals, and access explicit",
      -0.25,
    ],
    [
      "Theo Brooks",
      "Implementation lead",
      "Keep the plan deliverable and its costs visible",
      0.12,
    ],
  ],
};

function scenarioKind(text: string): keyof typeof profiles {
  if (
    /street|city|urban|traffic|transport|parking|neighbou?r|district/i.test(
      text,
    )
  )
    return "urban";
  if (/price|pricing|subscription|customer|product|premium|launch/i.test(text))
    return "product";
  if (/\bai\b|automation|technology|employee|workforce|robot/i.test(text))
    return "technology";
  return "community";
}

function excerpt(text: string, limit: number) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

export function buildDemoWorld(
  input: CreateSimulationInput,
  sources: Source[],
): World {
  const kind = scenarioKind(`${input.question} ${input.context}`);
  const archetypes = profiles[kind];
  const actors = Array.from({ length: input.actorCount }, (_, index) => {
    const [name, role, goal, stance] = archetypes[index % archetypes.length];
    const actorId = `actor-${index + 1}`;
    const assignedSources = sources.filter(
      (_, sourceIndex) => (sourceIndex + index) % 3 !== 1,
    );
    return {
      id: actorId,
      name:
        index < archetypes.length ? name : `${name.split(" ")[0]} ${index + 1}`,
      role,
      goal,
      description: `A fictional ${role.toLowerCase()} considering: ${excerpt(input.question, 180)}`,
      stance:
        Math.round(
          clamp(
            stance +
              (seededValue(input.seed, `${actorId}:${input.question}`) - 0.5) *
                0.18,
          ) * 1000,
        ) / 1000,
      influence:
        Math.round(
          (0.35 + seededValue(input.seed, `influence:${actorId}`) * 0.55) *
            1000,
        ) / 1000,
      sourceIds: assignedSources.map((source) => source.id),
      memory: [
        `Initial synthetic priority: ${goal}. Scenario: ${excerpt(input.question, 140)}`,
      ],
    };
  });
  const relationships: World["relationships"] = [];
  const pairs = new Set<string>();
  const add = (from: number, to: number, label: string) => {
    const key = [from, to].sort((a, b) => a - b).join(":");
    if (from === to || pairs.has(key)) return;
    pairs.add(key);
    relationships.push({
      from: actors[from].id,
      to: actors[to].id,
      label,
      weight:
        Math.round(
          (0.35 + seededValue(input.seed, `edge:${key}`) * 0.5) * 1000,
        ) / 1000,
    });
  };
  for (let index = 0; index < actors.length; index++)
    add(
      index,
      (index + 1) % actors.length,
      index % 2 ? "working contact" : "community contact",
    );
  for (let index = 0; index + 3 < actors.length; index += 3)
    add(index, index + 3, "cross-group contact");
  return {
    summary: `A synthetic ${kind === "urban" ? "city policy" : kind} scenario exploring: ${excerpt(input.question, 350)}${input.context ? ` Context: ${excerpt(input.context, 250)}` : ""}`,
    assumptions: [
      "Demo uses deterministic rules and fictional archetypes. It does not call a language model or predict real people.",
      "Stance ranges from opposition (-1) to support (+1); influence and relationships are illustrative assumptions.",
      "Actors see only their assigned source documents, their own memory, and connected actors’ recent public actions.",
      sources.length
        ? "Imported documents are available as source context; the demo does not verify or semantically extract their claims."
        : "No external evidence was supplied. Initial positions are synthetic assumptions.",
    ],
    actors,
    relationships,
  };
}

/** Transparent toy policy: social exposure, seeded variation, and explicit intervention signals. */
export function demoDecision(
  observation: ActorObservation,
  seed: number,
): Action {
  const { actor, round } = observation;
  const latestByActor = new Map<string, { stance: number; weight: number }>();
  for (const event of observation.publicEvents) {
    const neighbor = observation.neighbors.find(
      (candidate) => candidate.id === event.actorId,
    );
    if (neighbor)
      latestByActor.set(event.actorId, {
        stance: event.stance,
        weight: neighbor.weight,
      });
  }
  const exposures = [...latestByActor.values()];
  const weight = exposures.reduce((sum, exposure) => sum + exposure.weight, 0);
  const neighborStance = weight
    ? exposures.reduce(
        (sum, exposure) => sum + exposure.stance * exposure.weight,
        0,
      ) / weight
    : actor.stance;
  let interventionShift = 0;
  for (const intervention of observation.interventions) {
    const content = intervention.content.toLowerCase();
    const positive =
      /subsid|discount|free|pilot|consult|transparen|safeguard|funding|grant|lower|reduce|affordab/.test(
        content,
      );
    const negative =
      /increase|cost|fee|ban|delay|breach|crisis|mandatory|layoff|cut|raise/.test(
        content,
      );
    const semanticShift = (positive ? 0.13 : 0) - (negative ? 0.13 : 0);
    const sensitivity =
      0.55 + seededValue(seed, `sensitivity:${actor.id}`) * 0.9;
    const differentiated =
      (seededValue(seed, `${actor.id}:${intervention.content}`) - 0.5) * 0.1;
    const elapsed = Math.max(0, round - intervention.afterRound - 1);
    interventionShift +=
      (semanticShift * sensitivity + differentiated) / (1 + elapsed * 0.45);
  }
  const variation =
    (seededValue(seed, `${actor.id}:${round}:${observation.question}`) - 0.5) *
    0.09;
  const updated =
    Math.round(
      clamp(
        actor.stance +
          (neighborStance - actor.stance) * 0.2 +
          interventionShift +
          variation,
      ) * 1000,
    ) / 1000;
  const delta = updated - actor.stance;
  const selector = seededValue(seed, `action:${actor.id}:${round}`);
  const kind: Action["kind"] =
    Math.abs(delta) > 0.095
      ? "adapt"
      : selector < 0.12
        ? "observe"
        : selector < 0.34
          ? "question"
          : updated >= 0
            ? "advocate"
            : "oppose";
  const neighbor =
    observation.neighbors[
      Math.floor(
        seededValue(seed, `target:${actor.id}:${round}`) *
          observation.neighbors.length,
      )
    ];
  const opening: Record<Action["kind"], string> = {
    advocate: "I support testing this proposal",
    oppose: "I remain concerned about this proposal",
    question: "I want clearer evidence before committing",
    adapt:
      delta > 0
        ? "I am becoming more open to the proposal"
        : "I am revising my support downward",
    observe: "I am watching the discussion before taking a new position",
  };
  const intervention = observation.interventions.at(-1);
  const source = observation.sources[0];
  const content = [
    `${opening[kind]}. My priority is to ${actor.goal.charAt(0).toLowerCase()}${actor.goal.slice(1)}.`,
    `On “${excerpt(observation.question, 120)}”, ${exposures.length ? `${exposures.length} connected voices inform my position` : "I am starting from my initial assumptions"}.`,
    intervention
      ? `I am responding to the intervention: “${excerpt(intervention.content, 140)}”.`
      : "",
    source
      ? `My available context includes “${excerpt(source.name, 60)}”; this demo does not verify its claims.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    actorId: actor.id,
    kind,
    content,
    stance: updated,
    targetId: kind === "question" && neighbor ? neighbor.id : null,
    sourceIds: source ? [source.id] : [],
  };
}

export function demoReport(simulation: Simulation): Report {
  const latest = simulation.rounds.at(-1);
  if (!latest)
    return {
      headline: "The world is ready; no rounds have been observed",
      answer: `The scenario asks: “${simulation.question}”. This deterministic demo has no recorded actions yet, so it cannot draw an outcome from the run. Its fictional participants and assumptions are a starting point for exploring that question.`,
      summary: `The scenario “${simulation.title}” contains ${simulation.world.actors.length} synthetic actors. Run a round to produce behavioral evidence.`,
      findings: [
        {
          title: "Initial assumptions only",
          detail: simulation.world.summary,
          eventIds: [],
        },
      ],
      uncertainties: [
        "No simulated events exist yet.",
        "Fictional actor positions cannot establish a real-world forecast.",
      ],
      sourceIds: [],
    };
  const sorted = [...latest.events].sort((a, b) => a.stance - b.stance);
  const lowest = sorted[0];
  const highest = sorted.at(-1)!;
  const first = simulation.rounds[0];
  const change =
    Math.round((latest.metrics.support - first.metrics.support) * 100) / 100;
  const name = (actorId: string) =>
    simulation.world.actors.find((actor) => actor.id === actorId)?.name ??
    actorId;
  return {
    headline: `Round ${latest.number}: ${latest.metrics.support.toFixed(1)} support index, ${latest.metrics.polarization.toFixed(1)} polarization`,
    answer: `For “${simulation.question}”, this deterministic example illustrates a conditional outcome: support for the proposed change coexists with unresolved objections. ${name(highest.actorId)} focuses on ${simulation.world.actors.find((actor) => actor.id === highest.actorId)?.goal.toLowerCase() ?? "the change’s potential benefits"}, while ${name(lowest.actorId)} prioritizes ${simulation.world.actors.find((actor) => actor.id === lowest.actorId)?.goal.toLowerCase() ?? "remaining risks"}. A useful next branch would test a change that addresses the latter priority while preserving the former.\n\nThese are interpretations of template-generated actor actions, not modeled changes to jobs, income, health or everyday life. Demo mode cannot supply a tailored world-outcome narrative; a live-model run can explore those consequences as conditional hypotheses.`,
    summary: `Across ${simulation.rounds.length} recorded rounds, the synthetic support index ${change >= 0 ? "rose" : "fell"} ${Math.abs(change).toFixed(1)} points from the first round. ${latest.metrics.activity} of ${latest.events.length} actors took an active step in the last round. This describes the generated trajectory for “${simulation.question}”; it is not a probability of a real-world outcome.`,
    findings: [
      {
        title: "Most supportive recorded voice",
        detail: `${name(highest.actorId)} recorded stance ${highest.stance.toFixed(2)}: ${excerpt(highest.content, 550)}`,
        eventIds: [highest.id],
      },
      {
        title: "Strongest remaining objection",
        detail: `${name(lowest.actorId)} recorded stance ${lowest.stance.toFixed(2)}: ${excerpt(lowest.content, 550)}`,
        eventIds: [lowest.id],
      },
      {
        title: "Observed trajectory",
        detail: `Support moved from ${first.metrics.support.toFixed(1)} to ${latest.metrics.support.toFixed(1)}. Polarization moved from ${first.metrics.polarization.toFixed(1)} to ${latest.metrics.polarization.toFixed(1)}. These indices summarize fictional actor stances.`,
        eventIds: latest.events.map((event) => event.id),
      },
    ],
    uncertainties: [
      "Deterministic demo rules have not been calibrated against real populations or outcomes.",
      "Results depend on synthetic starting positions, network contacts, intervention wording, and the seed.",
      "Source documents provide context, not verification; causal effects cannot be established from this run.",
    ],
    sourceIds: [
      ...new Set(
        simulation.rounds.flatMap((round) =>
          round.events.flatMap((event) => event.sourceIds),
        ),
      ),
    ],
  };
}

export function demoAnswer(
  simulation: Simulation,
  question: string,
  observation?: ActorObservation,
): string {
  if (observation) {
    const { actor } = observation;
    const ownEvent = observation.publicEvents
      .filter((event) => event.actorId === actor.id)
      .at(-1);
    const keywords = /change|convince|shift|what if/i.test(question);
    return `[Deterministic demo · ${actor.name}]\n\n${keywords ? `A change would need to address my priority: ${actor.goal}.` : `As ${actor.role.toLowerCase()}, my priority is to ${actor.goal.charAt(0).toLowerCase()}${actor.goal.slice(1)}.`} My current synthetic stance is ${actor.stance.toFixed(2)} on “${observation.question}”.\n\n${ownEvent ? `My latest recorded action: “${ownEvent.content}” [${ownEvent.id}]` : "I have not acted in a round yet; this is an initial fictional position."}\n\nI can observe ${observation.neighbors.length} connected actors and ${observation.sources.length} assigned source documents. I cannot infer other actors’ private memories or unseen discussions.`;
  }
  const latest = simulation.rounds.at(-1);
  if (!latest)
    return `[Deterministic demo · analyst]\n\nThis world has ${simulation.world.actors.length} fictional actors and ${simulation.world.relationships.length} relationships. No rounds have run yet, so there are no behavioral observations to use when answering “${excerpt(question, 180)}”. Run a round, then inspect the timeline or generate a report.`;
  const polarized = /oppos|risk|polar|against|disagree/i.test(question);
  const ranked = [...latest.events].sort((a, b) =>
    polarized ? a.stance - b.stance : b.stance - a.stance,
  );
  const event = ranked[0];
  const actor = simulation.world.actors.find(
    (candidate) => candidate.id === event.actorId,
  )!;
  return `[Deterministic demo · analyst]\n\nAt round ${latest.number}, support is ${latest.metrics.support.toFixed(1)}/100 and polarization is ${latest.metrics.polarization.toFixed(1)}/100. ${latest.metrics.activity} actors took an active step.\n\n${polarized ? "The lowest recorded stance" : "The highest recorded stance"} belongs to ${actor.name} (${event.stance.toFixed(2)}): “${event.content}” [${event.id}]\n\n${simulation.interventions.length ? `${simulation.interventions.length} intervention(s) are present. Compare branches to inspect how generated trajectories differ.` : "A branch with an explicit intervention can help explore an alternative trajectory."} These observations come from the recorded demo run; they cannot establish what real people will do.`;
}
