"use client";

import { type ReactNode, useState } from "react";
import { Callout } from "@/components/common/callout";
import { Checkbox } from "@/components/common/checkbox";
import { ModelPicker } from "@/components/common/model-picker";
import { Input } from "@/components/ui/input";
import type { SpaceSettings } from "@/server/spaces/settings-schema";
import { CheckField, Field, FieldError, selectClass } from "./field";
import type { FormState } from "./form-state";
import { IncidentRuleEditor } from "./incident-rule-editor";
import { SaveBar, SettingsCard } from "./settings-card";
import { useActionForm } from "./use-action-form";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

const COMMIT_POLICIES = [
  { value: "every-version", label: "Keep every version" },
  { value: "daily", label: "Keep one version per day" },
  { value: "ignore", label: "Don't keep versions" },
] as const;

/** Short words for the "Default (...)" option, so it fits the column. */
const POLICY_SHORT: Record<string, string> = { "every-version": "every version", daily: "one per day", ignore: "not kept" };

export interface PolicyDefaults {
  syncIntervalMinutes: number;
  defaultStoreCommitPolicy: string;
  storeCommitPolicies: Record<string, string>;
}

const textInput = { autoComplete: "off", spellCheck: false } as const;
/** Placeholder of an empty optional field, so it can't be mistaken for a saved value. */
const NOT_SET = "Not set";

/** Display name (space row) and environment (settings). */
export function SpaceDetailsSection({ action, displayName, environment }: { action: Action; displayName: string | null; environment: string | null }) {
  const f = useActionForm(action);
  return (
    <SettingsCard id="details" title="Space details" description="How this space is named across the app.">
      <form onSubmit={f.onSubmit} noValidate>
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field id="displayName" label="Display name" optional hint="Shown in the space switcher and page titles. Leave empty to show the alias." error={f.error("displayName")}>
            <Input id="displayName" name="displayName" defaultValue={displayName ?? ""} maxLength={100} {...textInput} />
          </Field>
          <Field id="environment" label="Environment" optional hint="For example Test or Production. Shown next to the Region." error={f.error("environment")}>
            <Input id="environment" name="environment" defaultValue={environment ?? ""} maxLength={40} {...textInput} />
          </Field>
        </div>
        <SaveBar state={f.state} pending={f.pending} label="Save details" />
      </form>
    </SettingsCard>
  );
}

export interface ConnectionValues {
  readRoleArn: string | null;
  writeRoleArn: string | null;
  awsProfile: string | null;
}

/** Role ARNs and the AWS profile. The status and "Test connection" render above the form (`status`). */
export function ConnectionSection({
  action,
  current,
  accountId,
  externalId,
  status,
  aside,
}: {
  action: Action;
  current: ConnectionValues;
  accountId: string;
  externalId: string | null;
  status: ReactNode;
  aside?: ReactNode;
}) {
  const f = useActionForm(action);
  return (
    <SettingsCard
      id="connection"
      title="Connection and roles"
      aside={aside}
      description="The app stores role ARNs or a profile name, never credentials. With no roles and no profile, it uses this app's own AWS credentials."
    >
      {status}
      <form onSubmit={f.onSubmit} noValidate className="border-t">
        <div className="grid gap-4 p-4 lg:grid-cols-2">
          <Field
            id="readRoleArn"
            label="Read role ARN"
            optional
            hint={`Used for browsing, syncing and exports. Must be in account ${accountId}, for example arn:aws:iam::${accountId}:role/DevOpsAgentManagerRead.`}
            error={f.error("readRoleArn")}
          >
            <Input
              id="readRoleArn"
              name="readRoleArn"
              defaultValue={current.readRoleArn ?? ""}
              placeholder={NOT_SET}
              className="font-mono text-xs md:text-xs"
              {...textInput}
            />
          </Field>
          <Field
            id="writeRoleArn"
            label="Write role ARN"
            optional
            hint={`Used only to apply plans, restores included. Needs a read role too. For example arn:aws:iam::${accountId}:role/DevOpsAgentManagerWrite.`}
            error={f.error("writeRoleArn")}
          >
            <Input
              id="writeRoleArn"
              name="writeRoleArn"
              defaultValue={current.writeRoleArn ?? ""}
              placeholder={NOT_SET}
              className="font-mono text-xs md:text-xs"
              {...textInput}
            />
          </Field>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">External ID</p>
            {externalId ? (
              <p className="font-mono text-xs break-all">{externalId}</p>
            ) : (
              <p className="text-sm text-muted-foreground">Not generated yet</p>
            )}
            <p className="text-xs text-muted-foreground">
              {externalId
                ? "Give this value to whoever sets up the roles in AWS: each role must require it before this app can use the role. It stays the same when you edit the roles."
                : "The app creates it the first time you save a role ARN. Each role must then require it before this app can use the role."}{" "}
              In the role&apos;s trust policy it is the <span className="font-mono">sts:ExternalId</span> condition.
            </p>
          </div>
          <Field
            id="awsProfile"
            label="AWS profile (local mode)"
            optional
            hint="A profile name from the AWS config on the machine running the app, for example my-profile. Not a key. Leave empty when the app runs hosted."
            error={f.error("awsProfile")}
          >
            <Input id="awsProfile" name="awsProfile" defaultValue={current.awsProfile ?? ""} placeholder={NOT_SET} {...textInput} />
          </Field>
        </div>
        <SaveBar state={f.state} pending={f.pending} label="Save connection" />
      </form>
    </SettingsCard>
  );
}

/** Sync interval and the per-store commit policy. */
export function CaptureSection({ action, settings, storeNames, defaults }: { action: Action; settings: SpaceSettings; storeNames: string[]; defaults: PolicyDefaults }) {
  const f = useActionForm(action);
  const stores = [...new Set([...storeNames, ...Object.keys(settings.storeCommitPolicies)])].sort();
  const storeError = Object.entries(f.state.fieldErrors).find(([k]) => k.startsWith("storeCommitPolicies"))?.[1];
  return (
    <SettingsCard id="capture" title="Change capture" description="How often the app checks this space for changes, and which memory store versions it keeps in the history.">
      <form onSubmit={f.onSubmit} noValidate>
        <div className="space-y-5 p-4">
          <Field
            id="syncIntervalMinutes"
            label="Sync interval in minutes"
            optional
            hint={`Leave empty to use the app's default (${defaults.syncIntervalMinutes} minutes). Sync status turns stale after twice the interval.`}
            error={f.error("syncIntervalMinutes")}
            className="max-w-xs"
          >
            <Input id="syncIntervalMinutes" name="syncIntervalMinutes" type="number" inputMode="numeric" min={1} step={1} defaultValue={settings.syncIntervalMinutes?.toString() ?? ""} />
          </Field>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Versions to keep for each memory store</legend>
            <p className="text-xs text-muted-foreground">
              &quot;Default&quot; uses the app&apos;s setting for that store, shown in brackets.
            </p>
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Memory store
                    </th>
                    <th scope="col" className="w-72 px-3 py-2 font-medium">
                      Versions kept
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...stores, ""].map((name, i) => {
                    const stored = name ? (settings.storeCommitPolicies[name] ?? "") : "";
                    const policyDefault = name ? (defaults.storeCommitPolicies[name] ?? defaults.defaultStoreCommitPolicy) : defaults.defaultStoreCommitPolicy;
                    return (
                      <tr key={name || "__new"} className="border-t">
                        <td className="px-3 py-1.5">
                          {name ? (
                            <>
                              <span className="font-mono text-xs">{name}</span>
                              <input type="hidden" name={`store.${i}.name`} value={name} />
                            </>
                          ) : (
                            <Input name={`store.${i}.name`} placeholder="Add a store by name" aria-label="New memory store name" {...textInput} />
                          )}
                        </td>
                        <td className="px-3 py-1.5">
                          <select name={`store.${i}.policy`} defaultValue={stored} className={selectClass} aria-label={`Versions kept for ${name || "the new store"}`}>
                            <option value="">Default ({POLICY_SHORT[policyDefault] ?? policyDefault})</option>
                            {COMMIT_POLICIES.map((p) => (
                              <option key={p.value} value={p.value}>
                                {p.label}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <FieldError error={storeError} />
          </fieldset>
        </div>
        <SaveBar state={f.state} pending={f.pending} label="Save change capture" />
      </form>
    </SettingsCard>
  );
}

/** The incident ID rule, with its live tester. */
export function IncidentSection({ action, rule }: { action: Action; rule: SpaceSettings["incidentIdRule"] }) {
  const f = useActionForm(action);
  return (
    <SettingsCard id="incident" title="Incident ID rule" description="How the app finds the incident ID in an investigation, for journal exports, audits and replays.">
      <form onSubmit={f.onSubmit} noValidate>
        <div className="p-4">
          <IncidentRuleEditor rule={rule} errors={f.state.fieldErrors} />
        </div>
        <SaveBar state={f.state} pending={f.pending} label="Save incident ID rule" />
      </form>
    </SettingsCard>
  );
}

/**
 * Plan rules: change reason, approval and deletes. `approvalWarning` is shown
 * while "Require approval" is checked (on, or being turned on), when fewer
 * than two people can approve and apply plans here.
 */
export function PlansSection({
  action,
  settings,
  approvalWarning,
}: {
  action: Action;
  settings: Pick<SpaceSettings, "changeReasonRequired" | "approvalRequired" | "deletesEnabled">;
  approvalWarning?: { title: string; body: string } | null;
}) {
  const f = useActionForm(action);
  const [deletes, setDeletes] = useState(settings.deletesEnabled);
  const [approval, setApproval] = useState(settings.approvalRequired);
  const warnApproval = approval && approvalWarning;
  return (
    <SettingsCard id="plans" title="Plans" description="Rules for plans in this space, restores included.">
      <form onSubmit={f.onSubmit} noValidate>
        <div className="space-y-4 p-4">
          <CheckField
            id="changeReasonRequired"
            label="Require a change reason"
            hint="The person who applies a plan writes why. The reason is saved with the change in the history."
            control={<Checkbox id="changeReasonRequired" name="changeReasonRequired" defaultChecked={settings.changeReasonRequired} aria-describedby="changeReasonRequired-hint" />}
          />
          <CheckField
            id="approvalRequired"
            label="Require approval from a second person"
            hint="A Publisher other than the plan's author approves it before anyone can apply it."
            control={
              <Checkbox
                id="approvalRequired"
                name="approvalRequired"
                checked={approval}
                onCheckedChange={(v) => setApproval(v === true)}
                aria-describedby={warnApproval ? "approvalRequired-hint approval-warning" : "approvalRequired-hint"}
              />
            }
          >
            {warnApproval ? (
              <div id="approval-warning">
                <Callout tone="warning" title={approvalWarning.title}>
                  {approvalWarning.body} See Who can do what at the top of this page.
                </Callout>
              </div>
            ) : null}
          </CheckField>
          <CheckField
            id="deletesEnabled"
            label="Allow plans to delete assets"
            hint="Off by default. The write role must also be allowed to delete assets in AWS (aidevops:DeleteAsset)."
            control={
              <Checkbox
                id="deletesEnabled"
                name="deletesEnabled"
                checked={deletes}
                onCheckedChange={(v) => setDeletes(v === true)}
                aria-describedby={deletes ? "deletesEnabled-hint deletes-warning" : "deletesEnabled-hint"}
              />
            }
          >
            {deletes ? (
              <div id="deletes-warning">
                <Callout tone="warning" title="Publishers can delete assets from the live space">
                  A plan that deletes an asset removes it from the Agent Space when it is applied. The app saves the asset&apos;s last version in the
                  history first, but the delete can&apos;t be undone in the space: restoring creates the asset again with a new ID.
                </Callout>
              </div>
            ) : null}
          </CheckField>
        </div>
        <SaveBar state={f.state} pending={f.pending} label="Save plan rules" />
      </form>
    </SettingsCard>
  );
}

/** IAM actions the space's read role needs for the model list and for reviews (src/server/ai/catalog.ts MODEL_IAM). */
/** The IAM actions the read role needs, folded away: only an AWS admin can act on them. */
function ModelPermissions() {
  const code = (a: string) => (
    <code key={a} className="font-mono text-xs text-foreground">
      {a}
    </code>
  );
  return (
    <details className="border-t px-4 py-3 text-xs text-muted-foreground">
      <summary className="w-fit cursor-pointer font-semibold text-foreground underline-offset-4 hover:underline">For your AWS admin</summary>
      <div className="mt-1.5 space-y-1.5">
        <p>Permissions the space&apos;s read role needs:</p>
        <ul className="max-w-[72ch] list-disc space-y-1 pl-4">
          <li>
            To list models here: {code("bedrock:ListInferenceProfiles")} and {code("bedrock:ListFoundationModels")} on resource {code("*")}. Without them, type a model ID.
          </li>
          <li>
            To run reviews: {code("bedrock:InvokeModel")} and {code("bedrock:InvokeModelWithResponseStream")} on the chosen model or inference profile. For an inference profile, also allow the
            models in each Region it routes to.
          </li>
        </ul>
        <p>The app doesn&apos;t check these permissions. A missing one shows up when the list loads or when an audit starts.</p>
      </div>
    </details>
  );
}

/** Inference account and Region for model review, and the space's default review and report models. */
export function InferenceSection({
  action,
  settings,
  spaceRegion,
  spaceAlias,
  aside,
}: {
  action: Action;
  settings: SpaceSettings["inference"];
  spaceRegion: string;
  /** For the model pickers' list (GET /api/spaces/<alias>/models) */
  spaceAlias: string;
  aside?: ReactNode;
}) {
  const f = useActionForm(action);
  return (
    <SettingsCard id="inference" title="Model review (Amazon Bedrock)" aside={aside} description="Where journal audits run their model. Inference runs in the space's own account through its read role.">
      <form onSubmit={f.onSubmit} noValidate>
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field id="inference.mode" label="Inference account" hint="The only option for now.">
            <select id="inference.mode" name="inference.mode" defaultValue={settings.mode} className={selectClass}>
              <option value="space">The space&apos;s account, through its read role</option>
            </select>
          </Field>
          <Field id="inference.region" label="Inference Region" optional hint={`Leave empty to use the space's Region (${spaceRegion}).`} error={f.error("inference.region")}>
            <Input id="inference.region" name="inference.region" defaultValue={settings.region ?? ""} placeholder={spaceRegion} {...textInput} />
          </Field>
          <Field
            id="inference.reviewModelId"
            label="Review model"
            optional
            hint="The default for new audits. An audit can choose another. With no default, each audit chooses its own."
            error={f.error("inference.reviewModelId")}
          >
            <ModelPicker name="inference.reviewModelId" spaceAlias={spaceAlias} defaultValue={settings.reviewModelId} inheritLabel="No space default (each audit chooses)" />
          </Field>
          <Field id="inference.reportModelId" label="Report model" optional hint="Writes the audit report. Leave it on the default to use the review model." error={f.error("inference.reportModelId")}>
            <ModelPicker name="inference.reportModelId" spaceAlias={spaceAlias} defaultValue={settings.reportModelId} inheritLabel="Same as the review model" />
          </Field>
        </div>
        <ModelPermissions />
        <SaveBar state={f.state} pending={f.pending} label="Save model review" />
      </form>
    </SettingsCard>
  );
}

/** Replay switch and limits. */
export function ReplaysSection({ action, settings, aside }: { action: Action; settings: SpaceSettings["replays"]; aside?: ReactNode }) {
  const f = useActionForm(action);
  return (
    <SettingsCard id="replays" title="Replays" aside={aside} description="Replays create investigations in the space. Until replay permissions are designed, only Admins can start them.">
      <form onSubmit={f.onSubmit} noValidate>
        <div className="space-y-4 p-4">
          <CheckField
            id="replays.enabled"
            label="Allow replays in this space"
            hint="Set a usage floor when you turn this on."
            control={<Checkbox id="replays.enabled" name="replays.enabled" defaultChecked={settings.enabled} aria-describedby="replays.enabled-hint" />}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="replays.concurrency" label="Replays at a time" error={f.error("replays.concurrency")}>
              <Input id="replays.concurrency" name="replays.concurrency" type="number" inputMode="numeric" min={1} step={1} defaultValue={settings.concurrency.toString()} />
            </Field>
            <Field
              id="replays.usageFloorHours"
              label="Usage floor in hours"
              optional
              hint="Replays stop when the remaining investigation hours fall below this."
              error={f.error("replays.usageFloorHours")}
            >
              <Input id="replays.usageFloorHours" name="replays.usageFloorHours" type="number" inputMode="decimal" min={0} step="any" defaultValue={settings.usageFloorHours?.toString() ?? ""} />
            </Field>
          </div>
        </div>
        <SaveBar state={f.state} pending={f.pending} label="Save replays" />
      </form>
    </SettingsCard>
  );
}
