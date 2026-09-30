import type { CreateSimulationInput } from "./types";

export interface ScenarioTemplate {
  id: string;
  label: string;
  category: string;
  description: string;
  input: Omit<
    CreateSimulationInput,
    "model" | "seed" | "actorCount" | "maxRounds"
  >;
}

export const TEMPLATES: ScenarioTemplate[] = [
  {
    id: "four-day-week",
    label: "The four-day experiment",
    category: "WORK & CULTURE",
    description:
      "A shorter week. Different expectations. Follow the conversation.",
    input: {
      title: "The four-day experiment",
      question:
        "How might a 120-person design company respond to a four-day workweek pilot, and what would make adoption succeed?",
      context:
        "A fictional design company is considering a 12-week pilot. Salaries stay unchanged. Clients still expect Monday–Friday coverage. Explore employee, management, operations and client perspectives. Simulated actors represent different interests, not a representative sample of real employees.",
      sources: [
        {
          name: "Pilot brief · fictional scenario",
          content:
            "This is a fictional scenario, not empirical evidence. The company has 120 employees in product, design, operations and customer support. The proposed pilot lasts 12 weeks with unchanged salaries. Employees would work four days each week. Client coverage is expected on all five weekdays. Leadership will review delivery times, wellbeing and customer response times before a permanent decision. No pilot outcomes are known.",
        },
      ],
    },
  },
  {
    id: "pricing",
    label: "A price worth paying?",
    category: "PRODUCT & STRATEGY",
    description:
      "Explore how a new subscription price travels through a community.",
    input: {
      title: "A price worth paying?",
      question:
        "How might customers and the creator community react to a subscription rising from $12 to $18 per month?",
      context:
        "A fictional creative software company proposes a higher monthly price to fund collaboration features. Include hobbyists, working creators, teams, support and leadership. Explore possible responses and alternative rollout plans.",
      sources: [
        {
          name: "Pricing proposal · fictional scenario",
          content:
            "Fictional planning brief: the current monthly subscription is $12. The proposed price is $18. The product has a mix of hobbyist and professional customers. Collaboration features are planned but have not shipped. Existing customers have not yet been notified. No customer research or churn estimate is available.",
        },
      ],
    },
  },
  {
    id: "car-free",
    label: "A different kind of downtown",
    category: "CITIES & COMMUNITIES",
    description:
      "Trace the trade-offs of turning one busy street into shared space.",
    input: {
      title: "A different kind of downtown",
      question:
        "How might a neighborhood respond to a six-month car-free high street pilot?",
      context:
        "A fictional city plans a temporary car-free high street. Consider residents, retailers, commuters, accessibility advocates, delivery operators and the city. Explore concerns, coalitions and interventions without assuming a desired outcome.",
      sources: [
        {
          name: "Street pilot · fictional scenario",
          content:
            "Fictional planning brief: a city proposes closing one high street to private cars for six months. Emergency access remains available. Delivery windows and accessible transport arrangements have not yet been finalized. Retailers and residents will participate in consultations. No traffic, air-quality or sales outcome data are available.",
        },
      ],
    },
  },
];
