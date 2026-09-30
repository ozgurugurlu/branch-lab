import { api } from "@/server/http";
import { privacyInfo } from "@/server/privacy";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return api(request, ({ session }) => privacyInfo(session));
}
