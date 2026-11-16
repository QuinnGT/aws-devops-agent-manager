"use server";

import { redirect } from "next/navigation";
import type { FormState } from "@/components/spaces/form-state";
import { requirePermission } from "@/server/auth/dal";
import { errorState, formValues } from "@/server/spaces/action-result";
import { actorOf } from "@/server/spaces/actor";
import { registerSpace, requestConnectionTest } from "@/server/spaces/service";
import { registerSpaceSchema } from "@/server/spaces/validators";

/** Register a space (spaces.manage), then start its connection test. */
export async function registerSpaceAction(_prev: FormState, form: FormData): Promise<FormState> {
  const v = formValues(form);
  let alias: string;
  let runId: string | null = null;
  try {
    const user = await requirePermission("spaces.manage", null);
    const actor = actorOf(user);
    const input = registerSpaceSchema.parse({
      alias: v.alias,
      displayName: v.displayName,
      region: v.region,
      accountId: v.accountId,
      agentSpaceId: v.agentSpaceId,
      readRoleArn: v.readRoleArn,
      writeRoleArn: v.writeRoleArn,
      awsProfile: v.awsProfile,
      historyRepo:
        v["historyRepo.mode"] === "new"
          ? {
              mode: "new",
              repo: {
                name: v["historyRepo.repo.name"],
                remoteUrl: v["historyRepo.repo.remoteUrl"],
                deployKeyFile: v["historyRepo.repo.deployKeyFile"],
                defaultBranch: v["historyRepo.repo.defaultBranch"],
                pushEnabled: v["historyRepo.repo.pushEnabled"],
              },
            }
          : { mode: "existing", id: v["historyRepo.id"] },
    });
    const space = await registerSpace(input, actor);
    alias = space.alias;
    try {
      runId = await requestConnectionTest(space.id, actor, "registration");
    } catch {
      // The space is registered; the overview offers "Test connection" if the queue was unavailable.
      runId = null;
    }
  } catch (err) {
    return errorState(err, v);
  }
  redirect(`/spaces/${encodeURIComponent(alias)}${runId ? `?run=${runId}` : ""}`);
}
