import { z } from "zod";

export const modelConfigSchema = z
  .object({
    provider: z.enum(["demo", "openai", "google", "ollama", "lmstudio"]),
    model: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9_.:/+-]+$/),
  })
  .strict();
export const createSimulationSchema = z
  .object({
    title: z.string().trim().min(3).max(100),
    question: z.string().trim().min(12).max(2000),
    context: z.string().trim().max(12000).default(""),
    model: modelConfigSchema,
    seed: z.number().int().min(0).max(2147483647).default(42),
    maxRounds: z.number().int().min(1).max(12).default(6),
    actorCount: z.number().int().min(4).max(12).default(6),
    sources: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(120),
            content: z.string().trim().min(1).max(16000),
          })
          .strict(),
      )
      .max(6)
      .default([]),
  })
  .strict()
  .refine(
    (input) => input.sources.reduce((n, s) => n + s.content.length, 0) <= 48000,
    {
      message: "Sources must total no more than 48,000 characters.",
      path: ["sources"],
    },
  );
export const stepSchema = z
  .object({ expectedRound: z.number().int().min(0).max(24) })
  .strict();
export const branchSchema = z
  .object({
    intervention: z.string().trim().min(12).max(2000),
    title: z.string().trim().min(3).max(100).optional(),
  })
  .strict();
export const chatSchema = z
  .object({
    message: z.string().trim().min(1).max(2000),
    actorId: z.string().max(80).optional(),
  })
  .strict();
export const loginSchema = z
  .object({ password: z.string().min(1).max(512) })
  .strict();
