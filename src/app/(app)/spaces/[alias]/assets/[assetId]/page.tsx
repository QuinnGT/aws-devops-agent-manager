import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { ActionButton, CopyIdButton } from "@/components/assets/action-button";
import { AddReasonButton } from "@/components/assets/add-reason-form";
import { AssetHeader } from "@/components/assets/asset-header";
import { StatusWord } from "@/components/assets/badges";
import { assetHref, assetTabHref, restoreConfirm, spaceHref } from "@/components/assets/format";
import { StatusSwitch } from "@/components/assets/status-switch";
import { Callout } from "@/components/common/callout";
import { DisabledReason } from "@/components/common/disabled-reason";
import { LinkTabs } from "@/components/common/link-tabs";
import { RoleNote } from "@/components/common/role-note";
import { shortSourceLabel } from "@/components/common/source-labels";
import { Time } from "@/components/common/time";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { permissionsIn, roleFor } from "@/server/auth/dal";
import { roleNote } from "@/server/auth/role-words";
import { loadAssetPage } from "@/server/assets/asset-page";
import { SKILL_KEYS } from "@/server/assets/config";
import { assetIdParam, firstParam, loadSpaceForPage } from "@/server/assets/guard";
import { sectionHeading } from "@/server/assets/sections";
import { agentTypeLabel } from "@/server/history/display-name";
import { parseAssetTab, shortAssetId } from "@/server/assets/versions";
import { listDrafts, STATUS_KEY } from "@/server/drafts";
import { getAppPolicy } from "@/server/policy";
import { addReasonAction } from "../../history/actions";
import { statusCellFor } from "../_components/status-cell";
import { restoreVersionAction, setStatusInDraftAction } from "../actions";
import { ContentTab } from "./_components/content-tab";
import { FilesTab } from "./_components/files-tab";
import { MetadataTab } from "./_components/metadata-tab";
import { VersionsTab } from "./_components/versions-tab";

const outlineSm = buttonVariants({ variant: "outline", size: "sm" });

export default async function AssetPage(props: PageProps<"/spaces/[alias]/assets/[assetId]">) {
  const { alias, assetId: rawId } = await props.params;
  const sp = await props.searchParams;
  const { user, space } = await loadSpaceForPage(alias, "assets.read");
  const assetId = assetIdParam(rawId);
  const [perms, role] = await Promise.all([permissionsIn(user, space.id), roleFor(user, space.id)]);
  const canHistory = perms.has("history.read");
  const requested = parseAssetTab(firstParam(sp.tab));
  const tab = requested === "versions" && !canHistory ? "content" : requested;

  const view = await loadAssetPage(space, assetId, { tab, version: firstParam(sp.version), from: firstParam(sp.from), to: firstParam(sp.to) });
  if (!view) notFound();
  const { detail, actions } = view;
  const asset = detail.asset;
  const policy = detail.policy;
  const metadata = view.currentMetadata;
  const deleted = Boolean(asset.deletedAt);
  const canDraft = perms.has("drafts.write");
  const canPlan = perms.has("plans.create");
  const canReason = perms.has("reasons.write");
  // One line for the controls this role doesn't get: Restore on Versions, Edit elsewhere, then Add reason.
  const appPolicy = getAppPolicy().policy;
  const roleText =
    (actions.typeEditable && tab === "versions" ? roleNote(appPolicy, role, "plans.create", "restore older versions") : null) ??
    (actions.typeEditable && !deleted ? roleNote(appPolicy, role, "drafts.write", "draft changes") : null) ??
    roleNote(appPolicy, role, "reasons.write", "add change reasons");
  const reasonParam = Number.parseInt(firstParam(sp.reason) ?? "", 10);

  const myDrafts = canDraft ? await listDrafts(space.id, { createdBy: user.email }) : [];
  const myDraft = myDrafts.find((d) => d.assetId === asset.assetId);
  const draftStatus = new Map(myDrafts.flatMap((d) => (d.assetId && typeof d.desired.metadata[STATUS_KEY] === "string" ? [[d.assetId, d.desired.metadata[STATUS_KEY] as string] as const] : [])));
  const liveStatus = typeof metadata[STATUS_KEY] === "string" ? (metadata[STATUS_KEY] as string) : null;

  // ---------- top bar ----------
  const typeHeading = sectionHeading(policy, asset.assetType);
  const compare = view.compare?.ok ? view.compare : null;
  const crumbs: { label: string; href?: string }[] = [
    { label: "Assets", href: spaceHref(space.alias, "/assets") },
    { label: typeHeading, href: `${spaceHref(space.alias, "/assets")}?type=${encodeURIComponent(asset.assetType)}` },
  ];
  if (detail.store) crumbs.push({ label: detail.store.name, href: assetHref(space.alias, detail.store.assetId) });
  const displayName = detail.displayName;
  crumbs.push({ label: displayName, href: compare ? assetHref(space.alias, asset.assetId) : undefined });
  if (compare) crumbs.push({ label: `Compare v${compare.from.version} and v${compare.to.version}` });

  // ---------- header ----------
  const statusControl: ReactNode =
    canDraft && !deleted && actions.supportsStatus && actions.rules.status && liveStatus ? (
      <StatusSwitch
        active={(draftStatus.get(asset.assetId) ?? liveStatus) === "ACTIVE"}
        liveActive={liveStatus === "ACTIVE"}
        assetName={displayName}
        action={setStatusInDraftAction.bind(null, space.alias, asset.assetId)}
      />
    ) : liveStatus && !deleted ? (
      <StatusWord status={liveStatus} />
    ) : null;

  const last = detail.lastChange;
  const version = view.viewing ? (asset.liveVersion ?? asset.lastSyncedVersion) : (detail.committed?.assetJson.serviceVersion ?? asset.liveVersion ?? asset.lastSyncedVersion);
  const createdAt = detail.committed?.assetJson.serviceCreatedAt ?? asset.createdAt;
  const sourcePolicy = policy.attribution;
  const meta: ReactNode[] = [
    version !== null ? `Version ${version}` : null,
    last ? (
      <>
        Updated <Time value={last.at} format="date" /> by {shortSourceLabel(last.source, sourcePolicy)}
      </>
    ) : null,
    createdAt ? (
      <>
        Created <Time value={createdAt} format="date" />
      </>
    ) : null,
  ];
  if (asset.assetType === "skill" && detail.skill) {
    const chips = [
      { k: SKILL_KEYS.agentTypes, label: "Agent types", values: detail.skill.agentTypes.map((a) => agentTypeLabel(policy, a)), mono: false },
      { k: SKILL_KEYS.enableTools, label: "Tools", values: detail.skill.enableTools, mono: true },
    ];
    for (const c of chips) {
      if (!c.values.length) continue;
      meta.push(
        <span className="inline-flex flex-wrap items-center gap-1 align-middle" title={c.k}>
          {c.label}:
          {c.values.map((v) => (
            <span key={v} className={cn("rounded-md border px-1.5 text-xs leading-5", c.mono && "font-mono")}>
              {v}
            </span>
          ))}
        </span>,
      );
    }
  }
  // An instruction file's agent type, labeled like a skill's agent types; the ID (GENERIC) is in the tooltip only.
  if (detail.nameKey) {
    meta.push(
      <span className="inline-flex flex-wrap items-center gap-1 align-middle">
        Agent type:
        <span className="rounded-md border px-1.5 text-xs leading-5" title={detail.nameKey}>
          {agentTypeLabel(policy, detail.nameKey)}
        </span>
      </span>,
    );
  }
  meta.push(<CopyIdButton id={asset.assetId} short={shortAssetId(asset.assetId)} />);
  if (myDraft) {
    meta.push(
      <Link className="rounded-sm underline underline-offset-4" href={`${assetHref(space.alias, asset.assetId)}/draft`}>
        You have a draft of this {policy.assetTypes.assetTypes[asset.assetType]?.noun?.one ?? "asset"}
      </Link>,
    );
  }

  // Add reason: the newest change that accepts one.
  const reasonTarget = view.entries.find((e) => e.commitHash);
  const addReason =
    canReason && reasonTarget?.commitHash && reasonTarget.canAddReason && reasonTarget.notes.length === 0 && reasonTarget.pendingReasons.length === 0 ? (
      <AddReasonButton
        alias={space.alias}
        assetId={asset.assetId}
        commit={reasonTarget.commitHash}
        target={`${displayName}${reasonTarget.version !== null ? ` v${reasonTarget.version}` : ""}`}
        action={addReasonAction}
      />
    ) : null;

  const editLabel = "Edit as draft";
  const edit =
    canDraft && actions.typeEditable && !deleted ? (
      actions.contentLocked ? (
        <DisabledReason reason={<span className="max-w-[44ch] text-right">{actions.contentLocked}</span>} className="contents">
          <Button size="sm">{editLabel}</Button>
        </DisabledReason>
      ) : (
        // The draft route starts from live when there is no draft yet; the first "Save draft" creates it (draft-editor.md).
        <Link className={buttonVariants({ size: "sm" })} href={`${assetHref(space.alias, asset.assetId)}/draft`}>
          {editLabel}
        </Link>
      )
    ) : null;

  const headerActions =
    addReason || edit ? (
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center justify-items-end gap-x-2 gap-y-1.5 [&>div>span]:col-span-2">
        {addReason ?? <span />}
        {edit ?? <span />}
      </div>
    ) : null;

  // ---------- callouts ----------
  const callouts: ReactNode[] = [];
  if (!detail.repo.ok) {
    callouts.push(
      <Callout key="repo" tone="warning" title="The history repository can't be read">
        {detail.repo.message}
      </Callout>,
    );
  }
  if (deleted && asset.deletedAt) {
    const restore =
      canPlan && actions.typeEditable && view.restoreVersion !== null ? (
        actions.contentLocked ? (
          <DisabledReason reason={actions.contentLocked}>
            <Button size="sm" variant="outline">
              Restore as a plan
            </Button>
          </DisabledReason>
        ) : (
          <ActionButton action={restoreVersionAction.bind(null, space.alias, asset.assetId, view.restoreVersion)} pendingLabel="Creating plan" icon="restore" confirm={restoreConfirm(displayName, view.restoreVersion)}>
            Restore as a plan
          </ActionButton>
        )
      ) : undefined;
    callouts.push(
      <Callout
        key="deleted"
        tone="warning"
        title={
          <>
            Deleted from the space on <Time value={asset.deletedAt} format="datetime" />.
          </>
        }
        action={restore}
      >
        Its history stays in the history repository.
      </Callout>,
    );
  }
  if (view.viewing && tab === "content") {
    const current = view.latest?.version;
    callouts.push(
      <Callout
        key="viewing"
        tone="info"
        title={`Showing v${view.viewing.version}${current !== undefined && current !== null ? `. The current version is v${current}.` : "."}`}
        action={
          <Link className={outlineSm} href={assetHref(space.alias, asset.assetId)}>
            Show the current version
          </Link>
        }
      >
        {view.viewing.updatedAt ? (
          <>
            Recorded <Time value={view.viewing.updatedAt} format="datetime" />.
          </>
        ) : null}
      </Callout>,
    );
  }

  // ---------- tabs ----------
  const files = detail.committed?.files ?? [];
  const tabs = [
    { key: "content", href: assetTabHref(space.alias, asset.assetId, "content"), label: "Content" },
    ...(canHistory ? [{ key: "versions", href: assetTabHref(space.alias, asset.assetId, "versions"), label: "Versions", count: view.points.length }] : []),
    { key: "metadata", href: assetTabHref(space.alias, asset.assetId, "metadata"), label: "Metadata" },
    { key: "files", href: assetTabHref(space.alias, asset.assetId, "files"), label: "Files", count: files.length },
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={crumbs} keepLastTwoBelow="lg" />
      <AssetHeader
        assetType={asset.assetType}
        name={displayName}
        typeLabel={detail.typeLabel}
        managed={detail.managed}
        status={statusControl}
        description={typeof metadata.description === "string" ? metadata.description : null}
        meta={meta}
        actions={headerActions}
      />
      <RoleNote text={roleText} alias={space.alias} />
      {callouts.length ? (
        <section aria-label="Needs attention" className="space-y-2">
          {callouts.slice(0, 3)}
        </section>
      ) : null}
      <LinkTabs items={tabs} current={tab} label="Asset sections" />
      {tab === "content" ? (
        <ContentTab
          alias={space.alias}
          view={view}
          file={firstParam(sp.file)}
          showVersions={canHistory}
          statusCell={statusCellFor({ alias: space.alias, canDraft, policy, draftStatus, nameOf: (type, id) => (type === asset.assetType && id === asset.assetId ? asset.name : undefined) })}
        />
      ) : tab === "versions" ? (
        <VersionsTab
          alias={space.alias}
          view={view}
          canReason={canReason}
          canPlan={canPlan}
          restoreFor={canPlan && actions.typeEditable && !actions.contentLocked ? (v: number) => restoreVersionAction.bind(null, space.alias, asset.assetId, v) : null}
          openReason={Number.isSafeInteger(reasonParam) && reasonParam > 0 ? reasonParam : null}
        />
      ) : tab === "metadata" ? (
        <MetadataTab view={view} />
      ) : (
        <FilesTab alias={space.alias} view={view} />
      )}
    </div>
  );
}

