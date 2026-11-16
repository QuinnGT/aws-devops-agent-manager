"use client";

import { CircleX, Lock } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { PathTree } from "@/components/assets/path-tree";
import { AssetTypeIcon } from "@/components/common/asset-type-icon";
import { Callout } from "@/components/common/callout";
import { Checkbox } from "@/components/common/checkbox";
import { DisabledReason } from "@/components/common/disabled-reason";
import { PageHeader } from "@/components/common/page-header";
import { StatusBadge } from "@/components/common/status-badge";
import { STATUS, validationStatus } from "@/components/common/status-words";
import { formatTime, type ViewerZone } from "@/components/common/time-format";
import { ValidationList } from "@/components/common/validation-list";
import type { ActionResult } from "@/components/plans/action-state";
import { useReturnFocus } from "@/components/plans/return-focus";
import { Segmented } from "@/components/plans/segmented";
import { SizeMeterLine, sizeMeterText } from "@/components/plans/size-meter-line";
import { DiffCounts, MetadataChanges, UnifiedDiff } from "@/components/plans/unified-diff";
import { SafeMarkdown } from "@/components/safe-markdown";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { splitFrontmatter, displayValues } from "@/server/assets/frontmatter";
import { buildPathTree } from "@/server/assets/tree";
import type { DesiredFile } from "@/server/packages/types";
import type { JsonSchema } from "@/server/validation/schemas";
import type { ValidationResult } from "@/server/validation/types";
import { SYNCED_COMPARISON_NOTE } from "@/components/plans/words";
import { changedFiles, createPlanButton, diffAgainst, diffMetadata, diffPill, editorButtons, isDirty, measureText } from "./editor-state";
import { checkMetadata, mergeValidation } from "./metadata-check";
import { type FieldSpec, fieldOfPath, formFromSchema, listText, parseList, type ReferenceRule, type ReadOnlyFact, setReference } from "./schema-form";

export interface DraftEditorProps {
  alias: string;
  assetHref: string;
  draftsHref: string;
  asset: { assetId: string; assetType: string; name: string; typeLabel: string; managed: boolean; deleted: boolean };
  /** The draft shown, or null when the viewer has none yet (the first save creates it) */
  draft: { id: string; updatedAt: string; baseVersion: number | null } | null;
  /** First save: where the starting text came from */
  fresh: { from: "live" | "committed"; baseVersion: number } | null;
  readOnly: boolean;
  authorName: string;
  desired: { metadata: Record<string, unknown>; files: DesiredFile[]; refs: Record<string, string | string[]> };
  against: { source: "live" | "committed"; version: number; metadata: Record<string, unknown>; files: { path: string; encoding: "utf8" | "base64"; content: string | null }[]; liveError: string | null } | null;
  type: { content: "single-file" | "multi-file" | "binary"; mainFile: string | null; supportsStatus: boolean; metadataSchema: JsonSchema | null; warningSchema: JsonSchema | null; references: ReferenceRule[]; noun: string };
  rules: { content: boolean; metadata: boolean; status: boolean; managed: boolean };
  policy: { agentTypes: { id: string; label: string }[]; descriptionMax: number; agentsMdMaxBytes: number; agentsMdRecommendedLines: number; readOnlyKeys: string[] };
  validation: ValidationResult[];
  lockedReason: string | null;
  planTitle: string | null;
  zone: ViewerZone;
  /** Server-rendered callouts, between the header and the tabs */
  callouts: ReactNode;
  /** Read-only facts under the Details form (live version, asset ID) */
  facts: { label: string; value: ReactNode; mono?: boolean }[];
  detailsNote: string | null;
  detailsAside: string | null;
  save: (input: {
    assetId: string;
    draftId: string | null;
    expectedUpdatedAt: string | null;
    from: "live" | "committed" | null;
    expectedBaseVersion: number | null;
    metadata: Record<string, unknown>;
    refs?: Record<string, string | string[]>;
    files: DesiredFile[];
  }) => Promise<ActionResult<{ draftId: string; updatedAt: string; validation: ValidationResult[] }>>;
  discard: (draftId: string) => Promise<ActionResult>;
  /** "Create plan from this draft" (plans.create); null hides it */
  createPlan: ((draftIds: string[], title: string) => Promise<ActionResult<{ planId: string }>>) | null;
  plansHref: string;
}

interface Saved {
  draftId: string;
  updatedAt: string;
  validation: ValidationResult[];
  files: DesiredFile[];
  metadata: Record<string, unknown>;
}

const TAB = "h-9 flex-none rounded-t-md rounded-b-none px-2.5 text-[13px] group-data-horizontal/tabs:after:bottom-[-1px] data-active:font-semibold";

const formatOf = (path: string, text: string) => (/\.(md|markdown)$/i.test(path) ? (text.startsWith("---\n") || text.startsWith("---\r\n") ? "Markdown with YAML frontmatter" : "Markdown") : "Text");

/**
 * The draft editor (draft-editor.md): header with Save and Discard, Edit,
 * Preview and Diff tabs in client state (unsaved text survives a tab switch),
 * and the Validation and Details cards. Nothing here touches the space.
 */
export function DraftEditor(p: DraftEditorProps) {
  const router = useRouter();
  const [saving, startSave] = useTransition();
  const [files, setFiles] = useState<DesiredFile[]>(p.desired.files);
  const [metadata, setMetadata] = useState<Record<string, unknown>>(p.desired.metadata);
  const [refs, setRefs] = useState<Record<string, string | string[]>>(p.desired.refs);
  const [lists, setLists] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Saved | null>(null);
  const [announce, setAnnounce] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const discardFocus = useReturnFocus();
  const editableFiles = files.filter((f) => f.encoding === "utf8");
  const mainPath = p.type.mainFile && files.some((f) => f.path === p.type.mainFile) ? p.type.mainFile : (editableFiles[0]?.path ?? files[0]?.path ?? "");
  const [path, setPath] = useState(mainPath);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [compare, setCompare] = useState<"content" | "metadata">("content");
  const statusOnlyEditor = !p.rules.content;
  const [tab, setTab] = useState(statusOnlyEditor ? "content" : "edit");

  // The later of the server's draft and the last local save wins (a refresh after save, or a rebase elsewhere).
  const local = saved && (!p.draft || saved.updatedAt >= p.draft.updatedAt) ? saved : null;
  const draftId = local?.draftId ?? p.draft?.id ?? null;
  const updatedAt = local?.updatedAt ?? p.draft?.updatedAt ?? null;
  const baseline = local ? { files: local.files, metadata: local.metadata } : { files: p.desired.files, metadata: p.desired.metadata };
  const savedValidation = local?.validation ?? p.validation;
  const current = { files, metadata };
  const dirty = !p.readOnly && isDirty(baseline, current);
  const exists = draftId !== null;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const editable = !p.readOnly && !p.lockedReason && p.planTitle === null && !p.asset.deleted;
  const liveIssues = useMemo(() => checkMetadata({ error: p.type.metadataSchema, warning: p.type.warningSchema }, metadata), [p.type.metadataSchema, p.type.warningSchema, metadata]);
  const validation = useMemo(() => mergeValidation(savedValidation, liveIssues), [savedValidation, liveIssues]);
  const fieldErrors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const r of liveIssues) {
      const k = r.level === "error" ? fieldOfPath(r.path ?? "") : null;
      if (k && !out[k]) out[k] = r.message;
    }
    return out;
  }, [liveIssues]);

  const fileDiffs = useMemo(() => (p.against ? diffAgainst(p.against.files, files) : []), [p.against, files]);
  const metaDiff = useMemo(() => diffMetadata(p.against?.metadata ?? null, metadata), [p.against, metadata]);
  const pill = p.against ? diffPill(fileDiffs, metaDiff) : null;
  const statusOnly = pill === "status";
  const buttons = editorButtons({ readOnly: p.readOnly, exists, planTitle: p.planTitle, assetDeleted: p.asset.deleted, lockedReason: p.lockedReason, dirty, saving });
  const planButton = createPlanButton({
    canCreate: p.createPlan !== null,
    readOnly: p.readOnly,
    exists,
    planTitle: p.planTitle,
    assetDeleted: p.asset.deleted,
    lockedReason: p.lockedReason,
    dirty,
    errors: validation.filter((v) => v.level === "error").length,
  });

  const form = useMemo(
    () =>
      formFromSchema({
        schema: p.type.metadataSchema,
        supportsStatus: p.type.supportsStatus,
        references: p.type.references,
        agentTypes: p.policy.agentTypes,
        readOnlyKeys: p.policy.readOnlyKeys,
        descriptionMax: p.policy.descriptionMax,
        allow: { metadata: p.rules.metadata && editable, status: p.rules.status && editable },
        metadata,
      }),
    [p.type, p.policy, p.rules, editable, metadata],
  );

  const file = files.find((f) => f.path === path) ?? files[0];
  const text = file?.encoding === "utf8" ? file.content : "";
  const isInstructions = p.asset.assetType === "agents_md";
  const [meterText, setMeterText] = useState(text);
  const meterTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const meter = isInstructions ? measureText(text, p.policy) : null;
  const announcedMeter = isInstructions ? measureText(meterText, p.policy) : null;

  const setText = (value: string) => {
    setFiles((fs) => fs.map((f) => (f.path === path ? { ...f, content: value } : f)));
    clearTimeout(meterTimer.current);
    meterTimer.current = setTimeout(() => setMeterText(value), 1000);
  };

  const onSave = () =>
    startSave(async () => {
      setError(null);
      const sent = changedFiles(baseline.files, files);
      const r = await p.save({
        assetId: p.asset.assetId,
        draftId,
        expectedUpdatedAt: updatedAt,
        from: exists ? null : (p.fresh?.from ?? null),
        expectedBaseVersion: exists ? null : (p.fresh?.baseVersion ?? null),
        metadata,
        refs,
        files: sent,
      });
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setSaved({ draftId: r.draftId, updatedAt: r.updatedAt, validation: r.validation, files, metadata });
      const errors = r.validation.filter((v) => v.level === "error").length;
      const warnings = r.validation.length - errors;
      setAnnounce(`Draft saved. ${errors} ${errors === 1 ? "error" : "errors"}, ${warnings} ${warnings === 1 ? "warning" : "warnings"}.`);
      router.refresh();
    });

  const onCreatePlan = () =>
    startSave(async () => {
      if (!draftId || !p.createPlan) return;
      setError(null);
      const r = await p.createPlan([draftId], p.asset.name);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      router.push(`${p.plansHref}/${encodeURIComponent(r.planId)}`);
    });

  const onDiscard = () =>
    startSave(async () => {
      if (!draftId) return;
      const r = await p.discard(draftId);
      if (!r.ok) {
        setDiscardOpen(false);
        setError(r.message);
        return;
      }
      setSaved(null);
      router.push(p.assetHref);
    });

  const setMeta = (key: string, value: unknown) =>
    setMetadata((m) => {
      const next = { ...m };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });

  const lastSaved = updatedAt ? formatTime(updatedAt, "datetime", p.zone) : null;
  const based = p.draft?.baseVersion ?? p.fresh?.baseVersion ?? null;
  const meta: ReactNode[] = [
    p.readOnly ? `Draft by ${p.authorName}, read only` : `${exists ? "Your draft" : "New draft"}, based on ${(exists ? p.against?.source : p.fresh?.from) === "committed" ? "the last synced" : "live"} v${based}`,
    p.readOnly && based !== null ? `based on live v${based}` : null,
    lastSaved ? `${p.readOnly ? "Saved" : "Last saved"} ${lastSaved}` : "Not saved yet",
    dirty ? (
      <span key="dirty" className="text-warning-fg">
        Unsaved changes
      </span>
    ) : null,
  ];

  const saveBtn = (
    <Button size="sm" onClick={onSave} disabled={saving}>
      {saving ? "Saving" : "Save draft"}
    </Button>
  );

  const actions =
    buttons.save === null ? null : (
      <div className="flex flex-col items-end gap-1.5">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {buttons.cancel ? (
            <Link href={p.assetHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Cancel
            </Link>
          ) : null}
          {buttons.discard ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                discardFocus.remember();
                setDiscardOpen(true);
              }}
              disabled={saving}
            >
              Discard draft
            </Button>
          ) : null}
          {buttons.save.enabled ? saveBtn : <DisabledReason reason={buttons.save.reason}>{saveBtn}</DisabledReason>}
          {planButton ? (
            planButton.enabled ? (
              <Button size="sm" variant="outline" onClick={onCreatePlan} disabled={saving}>
                Create plan from this draft
              </Button>
            ) : (
              <DisabledReason reason={planButton.reason}>
                <Button size="sm" variant="outline">
                  Create plan from this draft
                </Button>
              </DisabledReason>
            )
          ) : null}
        </div>
        <p className="text-[12.5px] text-muted-foreground">Nothing changes in the space until a plan is applied.</p>
        {error ? (
          <p role="alert" className="flex max-w-md items-start gap-1.5 text-xs text-destructive-fg">
            <CircleX className="mt-px size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        ) : null}
      </div>
    );

  const multi = editableFiles.length > 1;
  const fileOptions = (withCounts: boolean) =>
    // More than four files: the Diff header lists only the changed ones (the Edit tab has the file tree).
    (withCounts && files.length > 4 ? files.filter((f) => fileDiffs.find((x) => x.path === f.path)?.status !== "unchanged") : files).map((f) => {
      const d = fileDiffs.find((x) => x.path === f.path);
      const suffix = withCounts && d ? (d.status === "unchanged" ? ", no change" : d.added || d.removed ? ` +${d.added} −${d.removed}` : ", changed") : "";
      return { value: f.path, label: `${f.path}${suffix}` };
    });
  const shownDiffPath = diffPath ?? fileDiffs.find((d) => d.status !== "unchanged")?.path ?? path;
  const shownDiff = fileDiffs.find((d) => d.path === shownDiffPath);
  const totals = fileDiffs.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 });

  return (
    <div className="space-y-4">
      <PageHeader
        icon={<AssetTypeIcon assetType={p.asset.assetType} className="size-5" />}
        title={p.asset.name}
        badges={
          <>
            <Badge variant="outline" className="h-[22px] font-normal">
              {p.asset.typeLabel}
            </Badge>
            {p.asset.managed ? (
              <Badge variant="outline" className="h-[22px] gap-1 font-normal">
                <Lock aria-hidden />
                Managed store
              </Badge>
            ) : null}
            <StatusBadge {...STATUS.draft} />
          </>
        }
        meta={meta}
        actions={actions}
      />
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      {p.against?.source === "committed" ? (
        <Callout tone="info" title={`Based on the last synced version (v${p.against.version})`}>
          The plan checks the live space before anything is written.{p.against.liveError ? ` ${p.against.liveError}` : ""}
        </Callout>
      ) : null}
      {p.callouts}

      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList variant="line" className="h-auto w-full justify-start border-b p-0" aria-label="Draft views">
          {statusOnlyEditor ? (
            <TabsTrigger value="content" className={TAB}>
              Content
            </TabsTrigger>
          ) : (
            <>
              <TabsTrigger value="edit" className={TAB}>
                Edit
              </TabsTrigger>
              <TabsTrigger value="preview" className={TAB}>
                Preview
              </TabsTrigger>
            </>
          )}
          <TabsTrigger value="diff" className={TAB}>
            Changes
            {pill ? <span className="rounded-full bg-muted px-1.5 font-mono text-xs font-medium text-muted-foreground tabular-nums">{pill}</span> : null}
          </TabsTrigger>
        </TabsList>

        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0">
            {statusOnlyEditor ? (
              <TabsContent value="content">
                <Card className="gap-0 py-0">
                  <div className="flex min-h-12 items-center border-b px-4 py-2 font-mono text-[13px] text-muted-foreground">
                    {file?.path} · live v{p.against?.version ?? based} · read only
                  </div>
                  <RenderedFile path={file?.path ?? ""} text={text} />
                </Card>
              </TabsContent>
            ) : (
              <>
                <TabsContent value="edit">
                  <Card className="gap-0 py-0">
                    <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
                      {multi && files.length <= 4 ? (
                        <Segmented label="File" value={path} onChange={setPath} options={fileOptions(false)} />
                      ) : (
                        <span className="font-mono text-[13px] text-muted-foreground">{file?.path}</span>
                      )}
                      <span className="text-xs text-muted-foreground">{formatOf(file?.path ?? "", text)}</span>
                    </div>
                    {meter && announcedMeter ? (
                      <>
                        <SizeMeterLine meter={meter} />
                        <p className="sr-only" role="status" aria-atomic="true">
                          {sizeMeterText(announcedMeter)}
                        </p>
                      </>
                    ) : null}
                    <div className={cn(files.length > 4 && "grid md:grid-cols-[220px_minmax(0,1fr)]")}>
                      {files.length > 4 ? (
                        <nav aria-label="Files" className="border-b p-3 md:border-r md:border-b-0">
                          <PathTree
                            nodes={buildPathTree(files, (f) => f.path)}
                            renderItem={(f, node) => (
                              <button
                                type="button"
                                onClick={() => setPath(f.path)}
                                aria-current={f.path === path ? "true" : undefined}
                                className={cn("inline-flex min-h-6 items-center rounded-sm px-1 text-left font-mono text-xs hover:underline", f.path === path && "bg-muted font-semibold")}
                              >
                                {node.name}
                              </button>
                            )}
                          />
                        </nav>
                      ) : null}
                      {file && file.encoding === "utf8" ? (
                        <EditorArea key={file.path} path={file.path} value={text} onChange={setText} readOnly={!editable || !p.rules.content} />
                      ) : (
                        <p className="px-4 py-3 text-[13px] text-muted-foreground">This file is binary and can&apos;t be edited here.</p>
                      )}
                    </div>
                    <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">Plain markdown. Tab moves focus out of the editor, so indent with spaces.</p>
                  </Card>
                </TabsContent>
                <TabsContent value="preview">
                  <Card className="gap-0 py-0">
                    <div className="flex min-h-12 items-center border-b px-4 py-2 font-mono text-[13px] text-muted-foreground">
                      {file?.path} · {p.readOnly ? `${p.authorName}'s draft` : "your draft"}, rendered
                    </div>
                    <RenderedFile path={file?.path ?? ""} text={text} />
                  </Card>
                </TabsContent>
              </>
            )}
            <TabsContent value="diff">
              <Card className="gap-0 py-0">
                <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
                  {multi && !statusOnly && compare === "content" && fileOptions(true).length > 1 ? (
                    <Segmented label="File" value={shownDiffPath} onChange={setDiffPath} options={fileOptions(true)} />
                  ) : (
                    <h2 className="text-sm font-semibold">
                      {p.against?.source === "committed" ? "Last synced" : "Live"} v{p.against?.version ?? "?"} → {p.readOnly ? `${p.authorName}'s draft` : "your draft"}
                    </h2>
                  )}
                  {!statusOnly ? (
                    <div className="flex items-center gap-3">
                      <DiffCounts added={totals.added} removed={totals.removed} />
                      <Segmented
                        label="Compare"
                        value={compare}
                        onChange={setCompare}
                        options={[
                          { value: "content", label: "Content" },
                          { value: "metadata", label: "Metadata" },
                        ]}
                      />
                    </div>
                  ) : null}
                </div>
                {p.against?.source === "committed" ? (
                  <p className="border-b px-4 py-2 text-xs text-muted-foreground">
                    {SYNCED_COMPARISON_NOTE}
                  </p>
                ) : null}
                {!p.against ? (
                  <p className="px-4 py-3 text-[13px] text-muted-foreground">The live version could not be read, and the history repository has no committed version of this asset.</p>
                ) : statusOnly ? (
                  <MetadataChanges changes={metaDiff} before="Live" after="Draft" empty="No change." />
                ) : compare === "metadata" ? (
                  <MetadataChanges changes={metaDiff} before="Live" after="Draft" empty="No metadata change." />
                ) : shownDiff ? (
                  <UnifiedDiff file={shownDiff} />
                ) : (
                  <p className="px-4 py-3 text-[13px] text-muted-foreground">No content change.</p>
                )}
              </Card>
            </TabsContent>
          </div>

          <aside className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1" aria-label="Validation and details">
            <Card className="gap-0 py-0" role="region" aria-labelledby="validation-h">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2">
                <h2 id="validation-h" className="text-sm font-semibold">
                  Validation
                </h2>
                <StatusBadge {...validationStatus(validation)} />
              </div>
              <ValidationList results={validation} emptyHelp={lastSaved ? `Checked at your last save, ${lastSaved}.${dirty ? " Your unsaved changes are checked when you save." : ""}` : "Files are checked when you save."} />
              {validation.length ? <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">Details are checked as you edit. Files are checked when you save.</p> : null}
            </Card>
            <Card className="gap-0 py-0" role="region" aria-labelledby="details-h">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2">
                <h2 id="details-h" className="text-sm font-semibold">
                  Details
                </h2>
                {p.detailsAside ? <span className="text-xs text-muted-foreground">{p.detailsAside}</span> : null}
              </div>
              <div className="space-y-4 px-4 py-4">
                {form.fields.map((f) => (
                  <Field
                    key={f.key}
                    field={f}
                    metadata={metadata}
                    lists={lists}
                    error={fieldErrors[f.key] ?? null}
                    liveStatus={typeof p.against?.metadata.status === "string" ? (p.against.metadata.status as string) : null}
                    noun={p.type.noun}
                    onChange={setMeta}
                    onList={(key, value) => {
                      setLists((l) => ({ ...l, [key]: value }));
                      const items = parseList(value);
                      setMeta(key, items.length ? items : undefined);
                    }}
                    onReference={(rule, ids) => {
                      const next = setReference(metadata, refs, rule, ids);
                      setMetadata(next.metadata);
                      setRefs(next.refs);
                    }}
                  />
                ))}
                <Facts facts={form.facts} extra={p.facts} />
                {p.detailsNote ? <p className="text-xs text-muted-foreground">{p.detailsNote}</p> : null}
              </div>
            </Card>
          </aside>
        </div>
      </Tabs>

      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent onCloseAutoFocus={discardFocus.onCloseAutoFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your draft of {p.asset.name}?</AlertDialogTitle>
            <AlertDialogDescription>Your edits are deleted. The live space is not affected.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onDiscard}>
              Discard draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The plain-text editor of draft-editor.md (mono 13 px, soft wrap, no spellcheck, inset focus ring); the revision editor uses it too. */
export function EditorArea({ path, value, onChange, readOnly }: { path: string; value: string; onChange: (v: string) => void; readOnly: boolean }) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="sr-only">
        {path} content
      </label>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        readOnly={readOnly}
        wrap="soft"
        spellCheck={false}
        className="field-sizing-fixed min-h-[520px] resize-y rounded-none border-0 px-4 py-3 font-mono text-[13px] leading-[1.6] break-words whitespace-pre-wrap shadow-none focus-visible:ring-0 md:text-[13px] dark:bg-transparent"
        style={{ outlineOffset: "-2px" }}
      />
    </div>
  );
}

/** The draft's file rendered: frontmatter as a definition list, then the body through SafeMarkdown (untrusted content). */
function RenderedFile({ path, text }: { path: string; text: string }) {
  if (!/\.(md|markdown)$/i.test(path) && path !== "") {
    return <pre className="overflow-x-auto px-4 py-3 font-mono text-xs whitespace-pre-wrap">{text}</pre>;
  }
  const fm = splitFrontmatter(text);
  return (
    <div className="space-y-3 px-4 py-4">
      {fm.raw !== null ? (
        fm.data ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md border bg-muted/30 px-3 py-2 text-xs">
            {Object.entries(fm.data).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-mono text-muted-foreground">{k}</dt>
                <dd className="whitespace-pre-wrap">{displayValues(v).join("\n")}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-xs text-destructive-fg">The frontmatter is not valid YAML{fm.error ? `: ${fm.error}` : ""}.</p>
        )
      ) : null}
      <SafeMarkdown className="prose prose-sm max-w-[72ch] dark:prose-invert">{fm.body}</SafeMarkdown>
    </div>
  );
}

function Facts({ facts, extra }: { facts: ReadOnlyFact[]; extra: DraftEditorProps["facts"] }) {
  const rows = [...facts.map((f) => ({ label: f.label, value: f.value as ReactNode, mono: false })), ...extra.map((f) => ({ ...f, mono: f.mono ?? false }))];
  if (!rows.length) return null;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-muted-foreground">{r.label}</dt>
          <dd className={cn("break-words", r.mono && "font-mono text-xs leading-5")}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function HelpOrError({ id, hint, error }: { id: string; hint: string | null; error: string | null }) {
  if (error) {
    return (
      <p id={id} role="alert" className="flex items-start gap-1.5 text-xs text-destructive-fg">
        <CircleX className="mt-px size-3.5 shrink-0" aria-hidden />
        {hint ?? error}
      </p>
    );
  }
  return hint ? (
    <p id={id} className="text-xs text-muted-foreground">
      {hint}
    </p>
  ) : null;
}

function Field({
  field: f,
  metadata,
  lists,
  error,
  liveStatus,
  noun,
  onChange,
  onList,
  onReference,
}: {
  field: FieldSpec;
  metadata: Record<string, unknown>;
  lists: Record<string, string>;
  error: string | null;
  liveStatus: string | null;
  noun: string;
  onChange: (key: string, value: unknown) => void;
  onList: (key: string, value: string) => void;
  onReference: (rule: ReferenceRule, ids: string[]) => void;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  const v = metadata[f.key];
  const describedBy = error || f.hint ? helpId : undefined;
  switch (f.kind) {
    case "status": {
      const active = v !== "INACTIVE";
      const live = liveStatus === "INACTIVE" ? "Inactive" : liveStatus === "ACTIVE" ? "Active" : null;
      const differs = liveStatus !== null && liveStatus !== (active ? "ACTIVE" : "INACTIVE");
      return (
        <div className="space-y-1.5">
          <p id={`${id}-label`} className="text-[13px] font-medium">
            {f.label}
          </p>
          <div className="flex min-h-6 items-center gap-2">
            <Switch
              id={id}
              checked={active}
              onCheckedChange={(on) => onChange(f.key, on ? "ACTIVE" : "INACTIVE")}
              aria-labelledby={`${id}-label ${id}-state`}
              aria-describedby={differs ? helpId : undefined}
              className="data-unchecked:bg-muted-foreground/60"
            />
            <span id={`${id}-state`} className="text-[13px]">
              {active ? "Active" : "Inactive"}
            </span>
          </div>
          {differs && live ? (
            <p id={helpId} className="text-xs text-muted-foreground">
              Live is {live}. Switching a {noun} off doesn&apos;t create a new version.
            </p>
          ) : null}
        </div>
      );
    }
    case "agent-types": {
      const chosen = Array.isArray(v) ? (v as string[]) : [];
      return (
        <fieldset className="space-y-2" aria-describedby={describedBy}>
          <legend className="mb-1.5 text-[13px] font-medium">{f.label}</legend>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {f.options.map((o) => {
              const cid = `${id}-${o.id}`;
              return (
                <div key={o.id} className="flex items-start gap-1.5">
                  <Checkbox
                    id={cid}
                    checked={chosen.includes(o.id)}
                    onCheckedChange={(on) => onChange(f.key, on ? [...chosen, o.id] : chosen.filter((x) => x !== o.id))}
                    className="-mt-0.5"
                  />
                  <Label htmlFor={cid} className="text-[13px] leading-5 font-normal">
                    {o.label}
                  </Label>
                </div>
              );
            })}
          </div>
          <HelpOrError id={helpId} hint={f.hint} error={error} />
        </fieldset>
      );
    }
    case "description": {
      const s = typeof v === "string" ? v : "";
      return (
        <div className="space-y-1.5">
          <Label htmlFor={id} className="text-[13px]">
            {f.label}
          </Label>
          <Textarea id={id} value={s} onChange={(e) => onChange(f.key, e.target.value)} className="min-h-18 text-[13px] md:text-[13px]" aria-invalid={error ? true : undefined} aria-describedby={`${id}-count${describedBy ? ` ${helpId}` : ""}`} />
          <p id={`${id}-count`} className={cn("text-xs tabular-nums", s.length > f.max ? "text-destructive-fg" : "text-muted-foreground")}>
            {s.length.toLocaleString("en-US")} of {f.max.toLocaleString("en-US")} characters
          </p>
          {error ? <HelpOrError id={helpId} hint={f.hint} error={error} /> : null}
        </div>
      );
    }
    case "list": {
      const shown = lists[f.key] ?? listText(v);
      return (
        <div className="space-y-1.5">
          <Label htmlFor={id} className="text-[13px]">
            {f.label}
          </Label>
          <Input id={id} value={shown} onChange={(e) => onList(f.key, e.target.value)} className="h-8 text-[13px] md:text-[13px]" aria-invalid={error ? true : undefined} aria-describedby={helpId} />
          <HelpOrError id={helpId} hint={error ? f.hint : "Separate values with commas."} error={error} />
        </div>
      );
    }
    case "reference": {
      const rule = f.rule;
      if (rule.many) {
        const chosen = Array.isArray(v) ? (v as string[]) : [];
        return (
          <fieldset className="space-y-2" aria-describedby={describedBy}>
            <legend className="mb-1.5 text-[13px] font-medium">{f.label}</legend>
            {rule.options.length === 0 ? <p className="text-xs text-muted-foreground">None in this space.</p> : null}
            <div className="grid gap-y-1.5">
              {rule.options.map((o) => {
                const cid = `${id}-${o.assetId}`;
                return (
                  <div key={o.assetId} className="flex items-start gap-1.5">
                    <Checkbox
                      id={cid}
                      checked={chosen.includes(o.assetId)}
                      onCheckedChange={(on) => onReference(rule, on ? [...chosen, o.assetId] : chosen.filter((x) => x !== o.assetId))}
                      className="-mt-0.5"
                    />
                    <Label htmlFor={cid} className="text-[13px] leading-5 font-normal">
                      {o.name}
                    </Label>
                  </div>
                );
              })}
            </div>
            <HelpOrError id={helpId} hint={f.hint} error={error} />
          </fieldset>
        );
      }
      return (
        <div className="space-y-1.5">
          <Label htmlFor={id} className="text-[13px]">
            {f.label}
          </Label>
          <Select value={typeof v === "string" ? v : ""} onValueChange={(next) => onReference(rule, next ? [next] : [])}>
            <SelectTrigger id={id} size="sm" className="w-full text-[13px] md:text-[13px]" aria-invalid={error ? true : undefined} aria-describedby={describedBy}>
              <SelectValue placeholder="Choose by name" />
            </SelectTrigger>
            <SelectContent>
              {rule.options.map((o) => (
                <SelectItem key={o.assetId} value={o.assetId}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <HelpOrError id={helpId} hint={error ? f.hint : null} error={error} />
        </div>
      );
    }
    case "text": {
      return (
        <div className="space-y-1.5">
          <Label htmlFor={id} className="text-[13px]">
            {f.label}
          </Label>
          <Input id={id} value={typeof v === "string" ? v : ""} onChange={(e) => onChange(f.key, e.target.value)} className="h-8 text-[13px] md:text-[13px]" aria-invalid={error ? true : undefined} aria-describedby={describedBy} />
          <HelpOrError id={helpId} hint={f.hint} error={error} />
        </div>
      );
    }
  }
}
