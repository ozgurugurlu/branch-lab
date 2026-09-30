import { loginSchema } from "@/lib/schemas";
import { AppError } from "@/server/errors";
import { api, body } from "@/server/http";
import {
  checkPassword,
  consumeLimit,
  requiresPassword,
  setAuthenticated,
} from "@/server/security";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return api(
    request,
    async ({ owner }) => {
      await consumeLimit("login:global", 100, 15 * 60 * 1000);
      await consumeLimit(`login:${owner}`, 10, 15 * 60 * 1000);
      const input = await body(request, loginSchema);
      if (requiresPassword() && !checkPassword(input.password))
        throw new AppError(
          "INVALID_PASSWORD",
          "That workspace password is incorrect.",
          401,
        );
      await setAuthenticated(owner, true);
      return { authenticated: true };
    },
    { public: true, mutation: true },
  );
}
export async function DELETE(request: Request) {
  return api(
    request,
    async ({ owner }) => {
      await setAuthenticated(owner, false);
      return { authenticated: false };
    },
    { public: true, mutation: true },
  );
}
