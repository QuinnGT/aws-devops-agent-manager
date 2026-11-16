import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { spaceBase } from "@/components/app-shell/nav";
import { Callout } from "@/components/common/callout";
import { Time } from "@/components/common/time";
import { getViewerZone } from "@/components/common/viewer-zone";
import { DraftEditor } from "@/components/drafts/draft-editor";
import { sentenceCase } from "@/components/drafts/schema-form";
import { loadPlansPage } from "@/components/plans/page-guard";
import { PlanActionButton } from "@/components/plans/plan-controls";
import { buttonVariants } from "@/components/ui/button";
import { MANAGED_LOCK_REASON } from "@/server/assets/edit-rules";
import { assetIdParam, firstParam } from "@/server/assets/guard";
import { assetLabel } from "@/server/history/display-name";
import { loadDraftEditorPage } from "@/server/drafts/loaders";
import { getAppPolicy } from "@/server/policy";
import { OPEN_STATES } from "@/server/plans/states";
import { resolvedSchema } from "@/server/validation/schemas";
import { createPlanFromDraftsAction } from "../../../drafts/actions";
import { discardDraftAction, rebaseDraftAction, saveDraftAction } from "./actions";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ghostSm = buttonVariants({ variant: "ghost", size: "sm" });
const outlineSm = buttonVariants({ variant: "outline", size: "sm" });

/** Draft editor (design-system pages/draft-editor.md). Drafts never touch the space; only an applied plan does. */
export default async function DraftEditorPage({ params, searchParams }: PageProps<"/spaces/[alias]/assets/[assetId]/draft">) {
  const { alias, assetId: rawId } = await params;
  const { user, space, perms, viewer } = await loadPlansPage(alias);
  const assetId = assetIdParam(rawId);
  const base = spaceBase(space.alias);
  const assetHref = `${base}/assets/${encodeURIComponent(assetId)}`;
  // Without drafts.write the route goes back to the asset page (other people's drafts are read only for everyone).
  if (!perms.has("drafts.write")) redirect(assetHref);
  const requested = firstParam((await searchParams).draft);
  const page = await loadDraftEditorPage(space.id, assetId, viewer, { draftId: requested && UUID_RE.test(requested) ? requested : null });
  if (!page) notFound();
  const { asset, editor, fresh } = page;
  if (!editor && (!page.policy.editable || asset.deleted)) redirect(assetHref);

  const policy = getAppPolicy().policy;
  const name = assetLabel(policy, { assetType: asset.assetType, name: asset.name, assetId: asset.assetId });
  const entry = policy.assetTypes.assetTypes[asset.assetType];
  const typeLabel = entry?.label ?? asset.assetType;
  const plural = sentenceCase(entry?.noun?.other ?? `${typeLabel}s`);
  const crumbs = [
    { label: "Assets", href: `${base}/assets` },
    { label: plural, href: `${base}/assets?type=${encodeURIComponent(asset.assetType)}` },
    ...(asset.parentAssetId && asset.parentName ? [{ label: asset.parentName, href: `${base}/assets/${encodeURIComponent(asset.parentAssetId)}` }] : []),
    { label: name, href: assetHref },
    { label: "Draft" },
  ];

  const model = editor ?? fresh;
  if (!model) {
    return (
      <div className="mx-auto max-w-7xl space-y-4">
        <SpaceTopBar space={space} user={user} crumbs={crumbs} />
        <Callout
          tone="destructive"
          title={`Can't open ${name} for editing`}
          action={
            <Link href={assetHref} className={outlineSm}>
              Open asset
            </Link>
          }
        >
          The live space could not be read, and the history repository has no committed version of this asset to start from. Check the connection, then try again.
        </Callout>
      </div>
    );
  }

  const rules = editor ? editor.rules : fresh!.rules;
  const against = editor ? editor.against : fresh!.against;
  const desired = editor ? editor.desired : fresh!.desired;
  const typeInfo = editor ? editor.type : { label: fresh!.label, content: fresh!.content, mainFile: fresh!.mainFile, supportsStatus: fresh!.supportsStatus, metadataSchema: fresh!.metadataSchema, references: fresh!.references };
  const planOpen = editor?.plan && OPEN_STATES.includes(editor.plan.state) ? editor.plan : null;
  const zone = await getViewerZone();
  const movedTo = editor?.live.ok && editor.live.exists && editor.live.movedPastBase ? editor.live : null;
  const own = !page.readOnly;

  // ---------- callouts, in the page file's order, at most three ----------
  const callouts: { key: string; node: ReactNode }[] = [];
  if (asset.deleted && editor) {
    callouts.push({
      key: "deleted",
      node: (
        <Callout
          tone="destructive"
          title={
            asset.deletedAt ? (
              <>
                Deleted from the space on <Time value={asset.deletedAt} format="datetime" />
              </>
            ) : (
              "Deleted from the space"
            )
          }
          action={
            <Link href={assetHref} className={outlineSm}>
              Open asset
            </Link>
          }
        >
          Discard the draft, or restore the asset as a plan from its page.
        </Callout>
      ),
    });
  }
  if (movedTo && editor) {
    const button = { action: "rebase", label: `Use v${movedTo.version} as the base`, enabled: true, disabledReason: null };
    callouts.push({
      key: "moved",
      node: (
        <Callout
          tone="warning"
          title={
            <>
              Live moved from v{editor.draft.baseVersion} to v{movedTo.version} at <Time value={movedTo.updatedAt} format="datetime" />
              {page.liveSource ? ` (${page.liveSource})` : ""}
            </>
          }
          action={own && editor.draft.status === "open" ? <PlanActionButton button={button} run={rebaseDraftAction.bind(null, space.alias, editor.draft.id)} done={`Draft based on v${movedTo.version}`} /> : undefined}
        >
          The Changes tab now includes their change. A plan skips this draft until it is based on v{movedTo.version}.
        </Callout>
      ),
    });
  }
  if (planOpen) {
    callouts.push({
      key: "plan",
      node: (
        <Callout
          tone="info"
          title={`This draft is in plan ${planOpen.title}`}
          action={
            <Link href={`${base}/plans/${planOpen.id}`} className={ghostSm}>
              Open plan
            </Link>
          }
        >
          {own ? "Discard the plan to edit the draft again." : `${page.authorName} can edit it again if the plan is discarded.`}
        </Callout>
      ),
    });
  }
  if (rules.managed && !rules.content) {
    callouts.push({
      key: "managed",
      node: (
        <Callout tone="info" title="Only the status can change">
          {MANAGED_LOCK_REASON}
        </Callout>
      ),
    });
  }
  const other = page.others[0];
  if (other) {
    callouts.push({
      key: "other",
      node: (
        <Callout
          tone="info"
          title={`${other.authorName} also has a draft of ${name}`}
          action={
            <Link href={`${base}/drafts`} className={ghostSm}>
              Open drafts
            </Link>
          }
        >
          Saved <Time value={other.updatedAt} format="datetime" />
          {other.baseVersion !== null ? `, based on v${other.baseVersion}` : ""}. Plans apply one at a time, so the second plan to reach {name} skips it and asks for a re-check.
        </Callout>
      ),
    });
  }

  const shortId = asset.assetId.length > 11 ? asset.assetId.slice(0, 11) : asset.assetId;
  const facts = [
    {
      label: "Live version",
      value:
        asset.liveVersion !== null ? (
          <>
            v{asset.liveVersion}
            {asset.liveUpdatedAt ? (
              <>
                , updated <Time value={asset.liveUpdatedAt} format="date" />
              </>
            ) : null}
          </>
        ) : (
          "Not in the space"
        ),
    },
    { label: "Asset ID", value: <span title={asset.assetId}>{shortId}</span>, mono: true },
  ];
  const skillType = typeof desired.metadata.skill_type === "string" ? desired.metadata.skill_type : null;
  // draft-editor.md "Details card": the identity key of agents_md (agent_type), skill_type and any immutableKeys are read only.
  const readOnlyKeys = [...new Set([...(asset.assetType === "agents_md" ? page.policy.identityKeys : []), "skill_type", ...page.policy.immutableKeys])];

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={crumbs} />
      <DraftEditor
        alias={space.alias}
        assetHref={assetHref}
        draftsHref={`${base}/drafts`}
        asset={{ assetId: asset.assetId, assetType: asset.assetType, name, typeLabel, managed: rules.managed, deleted: asset.deleted }}
        draft={editor ? { id: editor.draft.id, updatedAt: editor.draft.updatedAt, baseVersion: editor.draft.baseVersion } : null}
        fresh={!editor && fresh ? { from: fresh.against.source, baseVersion: fresh.against.version } : null}
        readOnly={page.readOnly}
        authorName={page.authorName}
        desired={{ metadata: desired.metadata, files: desired.files, refs: desired.refs ?? {} }}
        against={against ? { source: against.source, version: against.version, metadata: against.metadata, files: against.files.map((f) => ({ path: f.path, encoding: f.encoding, content: f.content })), liveError: against.liveError } : null}
        type={{
          content: typeInfo.content,
          mainFile: typeInfo.mainFile,
          supportsStatus: typeInfo.supportsStatus,
          metadataSchema: typeInfo.metadataSchema,
          warningSchema: resolvedSchema(policy, asset.assetType, "metadataWarningSchema"),
          references: typeInfo.references,
          noun: page.policy.noun,
        }}
        rules={{ content: rules.content, metadata: rules.metadata, status: rules.status, managed: rules.managed }}
        policy={{
          agentTypes: page.policy.agentTypes,
          descriptionMax: page.policy.descriptionMaxChars,
          agentsMdMaxBytes: page.policy.agentsMdMaxBytes,
          agentsMdRecommendedLines: page.policy.agentsMdRecommendedLines,
          readOnlyKeys,
        }}
        validation={editor ? editor.validation : fresh!.validation}
        lockedReason={editor && !editor.canEdit && !page.readOnly && !planOpen ? editor.lockedReason : null}
        planTitle={planOpen?.title ?? null}
        zone={zone}
        callouts={
          callouts.length ? (
            <section aria-label="Needs attention" className="space-y-2">
              {callouts.slice(0, 3).map((c) => (
                <div key={c.key}>{c.node}</div>
              ))}
            </section>
          ) : null
        }
        facts={facts}
        detailsNote={asset.assetType === "agents_md" ? "Each agent type has its own instructions file, so a draft can't change which agent type this file is for." : null}
        detailsAside={skillType ? `${sentenceCase(skillType)} skill` : null}
        save={saveDraftAction.bind(null, space.alias)}
        discard={discardDraftAction.bind(null, space.alias)}
        createPlan={perms.has("plans.create") ? createPlanFromDraftsAction.bind(null, space.alias) : null}
        plansHref={`${base}/plans`}
      />
    </div>
  );
}
