# Research notes: an inspectable scenario laboratory

Research date: 2026-09-30. This document separates findings from our design decisions. Repository descriptions and papers establish what their authors implement or report; they are not independent validation of every claim.

## The question

How can a small, deployable application turn a scenario and its sources into an inspectable multi-agent simulation that users can discuss, interrupt and branch?

The useful unit is a **world with recorded events**, rather than a group chat transcript. Actors need distinct perspectives and limited observations. An environment must determine what their actions change. The application should preserve its assumptions and explain where its findings came from.

## Related systems

| System                                                                     | Findings from primary sources                                                                                                                                                                                                                                                                                | Design lesson for Branchlab                                                                                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [OASIS](https://github.com/camel-ai/oasis)                                 | Python/CAMEL social-media simulator with dynamic networks, recommendation systems and 23 action types. The repository describes scaling up to one million agents. Apache-2.0.                                                                                                                                | Explicit action types and a changing environment make a simulation different from unconstrained conversation. Population scale is a separate engineering objective. |
| [Generative Agents](https://github.com/joonspk-research/generative_agents) | Research prototype with a Python simulation server and Django environment. Stores experiences, retrieves memories, reflects and plans. Supports saved simulation replay. Apache-2.0.                                                                                                                         | Maintain actor-specific experiences and preserve the history needed for interviews and replay.                                                                      |
| [Concordia](https://github.com/google-deepmind/concordia)                  | Python library built around entities, reusable components and an engine. Actors describe intended actions; a Game Master resolves their effects in the environment. Apache-2.0.                                                                                                                              | Separate proposed behavior from the rules that apply it to the world.                                                                                               |
| [AgentSociety 2](https://github.com/tsinghua-fib-lab/AgentSociety)         | Current recommended package separates researcher agents from simulated participants. Its runtime uses Ray Tasks, workspace-bound stateless agent records, shared service access, traces and JSONL/DuckDB replay. The main repository is Apache-2.0 with an exception for `packages/agentsociety/commercial`. | Keep experiment coordination distinct from actors. Treat state, interventions and replay as explicit artifacts.                                                     |
| [TinyTroupe](https://github.com/microsoft/TinyTroupe)                      | Experimental Python library for persona/world simulation, population profiling, agent conversation and cost tracking. MIT. Ollama support is described as partial and experimental.                                                                                                                          | Small, inspectable casts are useful for exploring hypotheses. Expose model configuration and operational limits.                                                    |

These licenses describe the inspected repositories, not a legal determination about every bundled asset or dependency. Branchlab uses its own implementation and does not incorporate code from these projects.

## Simulation is not automatically forecasting

The [Generative Agents paper](https://arxiv.org/abs/2304.03442) evaluates believable individual and social behavior in a 25-agent environment. The [OASIS paper](https://arxiv.org/abs/2411.11581) studies patterns including information spread, polarization and herd behavior. These are valuable research targets; reproducing a plausible pattern does not establish accuracy for arbitrary future events.

The [study of interview-grounded simulations of 1,052 people](https://arxiv.org/abs/2411.10109) reports matching General Social Survey answers at 85% of participants' own test–retest accuracy. This is a task-specific comparison with a human reliability baseline, not an assertion of 85% universal predictive accuracy.

A [methodological paper on synthetic social agents](https://arxiv.org/abs/2509.26080) distinguishes plausible model outputs from calibrated probabilistic inference. It recommends empirical baselines, subgroup evaluation, independent sampling and checks on variance. Repeated LLM samples are not automatically independent samples from a human population.

[ForecastBench](https://forecastbench.org/docs/) instead evaluates forecasts registered before outcomes are known, with explicit resolution and Brier-based scoring. That is a useful reference for a future forecasting module. Branchlab currently has no outcome-resolution dataset or calibration study.

Therefore the interface reports **simulated support** and **disagreement**. These measurements summarize the current artificial actors. They are not polling estimates, probabilities of real-world outcomes or established causal effects. A branch comparison describes two simulated trajectories under the recorded assumptions.

## Our architecture decisions

The following are engineering judgments for this application, rather than conclusions established by the papers above:

1. **Bounded casts and rounds.** Begin with 4–12 actors. A complete round is an atomic checkpoint; the browser schedules the next request. This supports ordinary Node/serverless deployments without claiming a continuously running simulation worker.
2. **A frozen round view.** Actors receive the previous completed state, their own memories, connected actors' public events and source excerpts. Concurrent completion order must not leak another actor's same-round answer into the input.
3. **Typed actions and deterministic reduction.** Mastra agents generate proposed actions. Zod validates their shape and references. TypeScript derives metrics and applies state transitions.
4. **Separate evidence from assumptions.** Source IDs and hashes survive storage and export. Generated persona details and assumptions remain distinct from the supplied source text.
5. **Bounded model context.** The full imported text remains stored and exportable. Model prompts use bounded excerpts, not an assertion that every document was read exhaustively. The interface states those bounds.
6. **Branch from a saved world.** Preserve previous history and append an intervention plus future rounds. Keep the baseline available; identify differing comparison horizons.
7. **Explain through records.** Analyst reports refer to event and source IDs. Actor interviews use the selected actor's perspective. Reports are generated artifacts, not independent evidence for the simulation's correctness.
8. **Explicit provider behavior.** Native cloud providers and server-configured local endpoints share validated application types. A deterministic demo has its own visible identity. Provider errors do not silently become demo results.
9. **Replay and rerun are different.** Recorded events can be replayed exactly. Calling a live model again may produce different outputs even when application seeds and settings match.
10. **Server-held configuration.** Provider keys and local service URLs belong in environment variables. A cloud-hosted application cannot reach a user's laptop through `localhost`.

## Limits and useful next experiments

The application is an exploratory prototype, not an empirically validated model of a population. The next research steps would be a preregistered set of narrow questions, consented human baselines, held-out evaluation, prompt-order sensitivity checks, repeated runs across providers and subgroup-level error analysis. A real forecasting mode would additionally require forecast timestamps, unambiguous resolution criteria, observed outcomes and proper scoring rules.

Operational validation can establish that checkpoints, branches, evidence references and error recovery work. It cannot establish behavioral realism. Those two forms of validation should stay separate in future contributions.
