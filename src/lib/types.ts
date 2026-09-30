export type ProviderId = "demo" | "openai" | "google" | "ollama" | "lmstudio";
export interface ModelConfig {
  provider: ProviderId;
  model: string;
}
export interface Source {
  id: string;
  name: string;
  content: string;
  hash: string;
}
export interface Actor {
  id: string;
  name: string;
  role: string;
  description: string;
  goal: string;
  stance: number;
  influence: number;
  sourceIds: string[];
  memory: string[];
}
export interface Relationship {
  from: string;
  to: string;
  label: string;
  weight: number;
}
export interface World {
  summary: string;
  assumptions: string[];
  actors: Actor[];
  relationships: Relationship[];
}
export interface Action {
  actorId: string;
  kind: "advocate" | "oppose" | "question" | "adapt" | "observe";
  content: string;
  stance: number;
  targetId: string | null;
  sourceIds: string[];
}
export interface SimEvent extends Action {
  id: string;
  round: number;
}
export interface Metrics {
  support: number;
  polarization: number;
  activity: number;
}
export interface Round {
  number: number;
  summary: string;
  events: SimEvent[];
  metrics: Metrics;
  actors: Actor[];
  createdAt: string;
  modelCalls: number;
}
export interface Intervention {
  id: string;
  afterRound: number;
  content: string;
}
export interface Report {
  headline: string;
  summary: string;
  findings: { title: string; detail: string; eventIds: string[] }[];
  uncertainties: string[];
  sourceIds: string[];
}
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  actorId: string | null;
  createdAt: string;
  round: number;
}
export interface Simulation {
  id: string;
  title: string;
  question: string;
  context: string;
  model: ModelConfig;
  seed: number;
  maxRounds: number;
  initialWorld: World;
  world: World;
  sources: Source[];
  rounds: Round[];
  interventions: Intervention[];
  messages: ChatMessage[];
  report: Report | null;
  status: "ready" | "completed";
  createdAt: string;
  updatedAt: string;
  parentId: string | null;
  forkRound: number | null;
  version: number;
  usage: { modelCalls: number };
  manifest: { engineVersion: string; promptVersion: string };
}
export interface CreateSimulationInput {
  title: string;
  question: string;
  context: string;
  model: ModelConfig;
  seed: number;
  maxRounds: number;
  actorCount: number;
  sources: { name: string; content: string }[];
}
export interface SimulationSummary {
  id: string;
  title: string;
  question: string;
  status: Simulation["status"];
  roundCount: number;
  maxRounds: number;
  provider: ProviderId;
  updatedAt: string;
  parentId: string | null;
  metrics: Metrics | null;
}
export interface ProviderStatus {
  id: ProviderId;
  name: string;
  configured: boolean;
  reason?: string;
  models: {
    id: string;
    name: string;
    description: string;
    preview?: boolean;
  }[];
}
export interface AppConfig {
  providers: ProviderStatus[];
  authenticated: boolean;
  passwordRequired: boolean;
  liveEnabled: boolean;
  storage: "local" | "remote";
}
