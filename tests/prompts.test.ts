import { describe, expect, it } from "vitest";
import type { Simulation } from "@/lib/types";
import { reportSchema, validateReport } from "@/mastra/domain";

// These tests enforce report structure and provenance, not a model's behavioral quality.
function fixture(): Simulation {
  const actors = [1, 2].map((number) => ({
    id: `actor-${number}`,
    name: `Fictional stakeholder ${number}`,
    role: "Resident",
    description: "A fictional resident balancing benefits and constraints.",
    goal: "Preserve dependable daily care.",
    stance: 0,
    influence: 0.5,
    sourceIds: [],
    memory: [],
  }));
  const world = {
    summary: "Every person owns a household robot in this counterfactual.",
    assumptions: [
      "Ownership is universal; maintenance capacity is unspecified.",
    ],
    actors,
    relationships: [
      { from: "actor-1", to: "actor-2", label: "neighbors", weight: 0.5 },
    ],
  };
  return {
    id: "prompt-fixture",
    title: "Universal ownership",
    question: "If every person owns a robot, how could everyday life change?",
    context: "The counterfactual holds ownership universal.",
    model: { provider: "demo", model: "deterministic-v1" },
    seed: 1,
    maxRounds: 5,
    initialWorld: world,
    world,
    sources: [
      {
        id: "source-brief",
        name: "Scenario brief",
        content: "Robot maintenance requires spare parts.",
        hash: "a".repeat(64),
      },
    ],
    rounds: Array.from({ length: 5 }, (_, index) => ({
      number: index + 1,
      summary: "A stakeholder raised a maintenance concern.",
      events: [
        {
          id: `prompt-fixture-r${index + 1}-actor-1`,
          actorId: "actor-1",
          round: index + 1,
          kind: "question",
          content: "Who will maintain the robots?",
          stance: 0,
          targetId: null,
          sourceIds: [],
        },
      ],
      metrics: { support: 50, polarization: 0, activity: 1 },
      actors,
      createdAt: "2026-10-01T00:00:00.000Z",
      modelCalls: 0,
    })),
    interventions: [],
    messages: [],
    report: null,
    status: "completed",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    parentId: null,
    forkRound: null,
    version: 0,
    usage: { modelCalls: 0 },
    manifest: { engineVersion: "0.3.0", promptVersion: "2026-10-01.1" },
  };
}

function report() {
  return {
    headline: "Universal ownership could shift care work toward maintenance",
    answer:
      "Robot ownership could reduce routine chores while making dependable maintenance more important. A stakeholder raised that concern [prompt-fixture-r5-actor-1]; this does not establish that a shortage occurred. The brief mentions spare parts [source-brief].",
    summary: "The observed concern motivates a maintenance-capacity test.",
    findings: [
      {
        title: "Maintenance is a possible constraint",
        detail: "The stakeholder asked who would maintain the robots.",
        eventIds: ["prompt-fixture-r5-actor-1"],
      },
    ],
    uncertainties: [
      "The synthetic population cannot establish actual labor effects.",
    ],
    sourceIds: ["source-brief"],
  };
}

describe("scenario answer contract", () => {
  it("rejects model-authored coverage metadata reserved for the server", () => {
    expect(
      reportSchema.safeParse({
        ...report(),
        contextNotes: ["All evidence was considered."],
      }).success,
    ).toBe(false);
  });

  it("requires a substantive answer field for new outputs even when supporting fields exist", () => {
    const legacyShape: Record<string, unknown> = { ...report() };
    delete legacyShape.answer;
    expect(reportSchema.safeParse(legacyShape).success).toBe(false);
    expect(reportSchema.safeParse({ ...report(), answer: "  " }).success).toBe(
      false,
    );
    expect(
      reportSchema.safeParse({ ...report(), answer: "a".repeat(6001) }).success,
    ).toBe(false);
    expect(
      reportSchema.parse({
        ...report(),
        answer: "  A conditional consequence.  ",
      }).answer,
    ).toBe("A conditional consequence.");
  });

  it("accepts answer citations only when declared in supporting findings or sourceIds", () => {
    expect(validateReport(report(), fixture()).answer).toBe(report().answer);
    const eventNotUsedByFindings = {
      ...report(),
      answer: "A concern was voiced [prompt-fixture-r4-actor-1].",
    };
    expect(() => validateReport(eventNotUsedByFindings, fixture())).toThrow(
      /undeclared/,
    );
    expect(() =>
      validateReport({ ...report(), sourceIds: [] }, fixture()),
    ).toThrow(/undeclared/);
  });

  it.each([
    "An omitted old event [prompt-fixture-r1-actor-1].",
    "An invented event [prompt-fixture-r99-actor-1].",
    "An inaccessible document [source-secret].",
  ])("rejects inaccessible evidence in the main answer: %s", (answer) => {
    expect(() => validateReport({ ...report(), answer }, fixture())).toThrow(
      /citation/,
    );
  });

  it("allows uncited conditional answers and ordinary editorial brackets without inventing evidence", () => {
    const simulation = fixture();
    simulation.rounds = [];
    const output = {
      ...report(),
      answer:
        "[draft] Under the stated premise, maintenance could become a new household burden. No behavior has been observed.",
      findings: [
        {
          title: "A premise-based hypothesis",
          detail: "Maintenance capacity is unspecified.",
          eventIds: [],
        },
      ],
      sourceIds: [],
    };
    expect(validateReport(output, simulation).answer).toBe(output.answer);
  });
});
