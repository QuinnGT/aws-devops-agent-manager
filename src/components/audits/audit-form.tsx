"use client";

import { ChevronRight, CircleCheck, CircleX, Play, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { addItemsAction, createAuditAction, deleteDraftAction, removeItemsAction, saveDraftAction, startAuditAction } from "@/app/(app)/spaces/[alias]/audits/actions";
import { Callout } from "@/components/common/callout";
import { DisabledReason } from "@/components/common/disabled-reason";
import { ModelPicker } from "@/components/common/model-picker";
import { PageHeader } from "@/components/common/page-header";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { assignByTime, cohortCounts, cohortSelections } from "./cohorts";
import { GroundTruthCard, type EvidenceRowView, type GroundTruthInput } from "./ground-truth-card";
import { InvestigationPicker, type ClientSelection, type PickerState } from "./investigation-picker";
import type { ModelCatalog } from "@/server/ai/models";
import { CONNECTION_FAILED_REASON, readinessRows, startBlockedReason, startLabel, type BedrockReadiness, type ReadinessInput } from "./readiness-view";
import { plural, reviewerFacts, startHelp } from "./words";

export interface ProfileFormOption {
  id: string;
  label: string;
  description: string;
  isDefault: boolean;
  needs: string | null;
  incidentIdTemplate: string;
  inputs: GroundTruthInput[];
  cohorts: { id: string; label: string }[];
  analyzers: { count: number; words: string };
  concurrency: number;
  stepLimit: number;
  /** What an empty model field resolves to for this profile */
  defaultReview: { id: string | null; sourceLabel: string | null };
  defaultReport: { id: string | null; sourceLabel: string | null };
  /** The reviewer a new audit of this profile starts with: the profile's runner when the policy offers it */
  defaultRunner: string;
}

/** A reviewer the policy offers (policy.audits.reviewers), with its options. Every label and default is the policy's. */
export interface ReviewerFormOption {
  id: string;
  label: string;
  description: string;
  options: { id: string; label: string; description: string; default: string; values: { id: string; label: string; description: string }[] }[];
}

export interface DraftFormView {
  id: string;
  name: string;
  profileId: string;
  /** The audit's own choices (empty when it uses the default) */
  reviewModelId: string;
  reportModelId: string;
  /** The reviewer and its option values stored in the draft */
  runner: string;
  runnerOptions: Record<string, string>;
  /** The model the draft would run with now */
  reviewModel: string | null;
  items: (EvidenceRowView & { title: string | null; cohort: string | null; cohortLabel: string | null; journalPresent: boolean; ready: boolean })[];
  names: Record<string, string>;
}

export interface AuditFormProps {
  alias: string;
  profiles: ProfileFormOption[];
  /** The reviewers the policy offers; empty when it lists none, and the profile's runner is used */
  reviewers: ReviewerFormOption[];
  draft: DraftFormView | null;
  statuses: string[];
  releases: { name: string; at: string; atText: string }[];
  runsIn: string;
  maxUploadMb: number;
  canExportJournals: boolean;
  canManageSpace: boolean;
  connectionFailed: boolean;
  connectionNextStep: React.ReactNode;
  /** The model catalogue check for the space's inference Region (Readiness "Amazon Bedrock" row) */
  bedrock: BedrockReadiness;
  /** The catalogue itself, so the pickers can check a chosen ID without another request */
  catalog: ModelCatalog | null;
}

type Fact = [string, React.ReactNode];

/**
 * New audit and a draft audit (pages/audit-new.md): name, profile and models,
 * investigations, cohorts for a before-and-after profile, ground truth, and
 * on the right Readiness and Start. Nothing runs until Start; the first save
 * or upload creates the draft.
 */
export function AuditForm(props: AuditFormProps) {
  const { alias, profiles, draft } = props;
  const router = useRouter();
  const base = `/spaces/${encodeURIComponent(alias)}/audits`;
  const [name, setName] = useState(draft?.name ?? "");
  const [profileId, setProfileId] = useState(draft?.profileId ?? profiles.find((p) => p.isDefault)?.id ?? profiles[0]!.id);
  const profile = profiles.find((p) => p.id === profileId) ?? profiles[0]!;
  const [picker, setPicker] = useState<PickerState>({ selection: null, preview: null, loading: false });
  const [splitMode, setSplitMode] = useState<string>(props.releases[0] ? `release:${props.releases[0].name}` : "time");
  const [splitTime, setSplitTime] = useState("");
  const [moves, setMoves] = useState<Record<string, string>>({});
  const [addCohort, setAddCohort] = useState(profile.cohorts[0]?.id ?? "");
  const [showAllCohort, setShowAllCohort] = useState(false);
  const [models, setModels] = useState({ review: draft?.reviewModelId ?? "", report: draft?.reportModelId ?? "" });
  const reviewerOf = (rid: string) => props.reviewers.find((r) => r.id === rid) ?? null;
  const startValues = (rid: string): Record<string, string> => Object.fromEntries((reviewerOf(rid)?.options ?? []).map((o) => [o.id, o.default]));
  const [runner, setRunner] = useState(draft?.runner ?? profile.defaultRunner);
  const [runnerOptions, setRunnerOptions] = useState<Record<string, string>>({ ...startValues(draft?.runner ?? profile.defaultRunner), ...(draft?.runnerOptions ?? {}) });
  const reviewer = reviewerOf(runner);
  const reviewerName = reviewer?.label ?? runner;
  const usesBedrock = runner === "ai-sdk";
  const pickRunner = (rid: string) => {
    setRunner(rid);
    setRunnerOptions(startValues(rid));
  };
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startBusy] = useTransition();
  const [pickerKey, setPickerKey] = useState(0);
  const modelsRef = useRef<HTMLDivElement>(null);
  const id = draft?.id ?? null;

  const readModels = () => {
    const box = modelsRef.current;
    const v = (n: string) => ((box?.querySelector(`[name="${n}"]`) as HTMLInputElement | null)?.value ?? "").trim();
    return { review: v("reviewModelId"), report: v("reportModelId") };
  };
  /** The reviewer fields sent with a save; left out when the policy offers no choice, so the profile's runner stands. */
  const reviewerFields = () => (props.reviewers.length ? { runner, runnerOptions: Object.fromEntries((reviewer?.options ?? []).map((o) => [o.id, runnerOptions[o.id] ?? o.default])) } : {});

  // ------------------------------------------------ cohorts (new audit)
  const splitAt = useMemo(() => {
    if (splitMode.startsWith("release:")) {
      const r = props.releases.find((x) => `release:${x.name}` === splitMode);
      return r ? new Date(r.at) : null;
    }
    const t = splitTime ? new Date(splitTime) : null;
    return t && !Number.isNaN(t.getTime()) ? t : null;
  }, [splitMode, splitTime, props.releases]);
  const cohortIds = profile.cohorts.map((c) => c.id);
  const found = picker.preview?.found ?? [];
  const cohortItems = found.map((f) => ({ taskId: f.taskId, createdAt: f.createdAt ? new Date(f.createdAt).toISOString() : null }));
  const assignments = !draft && cohortIds.length ? assignByTime(cohortItems, cohortIds, splitAt, moves) : [];

  function selectionsForSave(): (ClientSelection & { cohort?: string })[] | null {
    if (!picker.selection) return null;
    if (!cohortIds.length) return [picker.selection];
    if (draft) return [{ ...picker.selection, cohort: addCohort }];
    return cohortSelections(assignments, cohortIds);
  }

  // ------------------------------------------------ readiness
  const required = profile.inputs.filter((i) => i.required);
  const currentModel = models.review || profile.defaultReview.id;
  const readinessInput: ReadinessInput = draft
    ? {
        name,
        investigations: draft.items.filter((i) => i.journalPresent).length,
        missingJournalIds: 0,
        missingByInput: required.map((r) => ({ label: r.label, items: draft.items.filter((i) => !i.inputs.find((x) => x.kind === r.kind)?.doc).length })),
        ready: draft.items.filter((i) => i.ready).length,
        cohorts: profile.cohorts.map((c) => ({ label: c.label, items: draft.items.filter((i) => i.cohort === c.id && i.ready).length })),
        analyzers: profile.analyzers,
        reviewModelId: currentModel,
        connectionFailed: props.connectionFailed,
        bedrock: props.bedrock,
        canManageSpace: props.canManageSpace,
        reviewer: { runner, label: reviewerName },
      }
    : {
        name,
        investigations: found.length,
        missingJournalIds: picker.preview?.missing.length ?? 0,
        missingByInput: required.map((r) => ({ label: r.label, items: found.filter((f) => !f.docKinds.includes(r.kind)).length })),
        ready: found.filter((f) => required.every((r) => f.docKinds.includes(r.kind))).length,
        cohorts: profile.cohorts.map((c) => ({ label: c.label, items: assignments.filter((a) => a.cohort === c.id).length })),
        analyzers: profile.analyzers,
        reviewModelId: currentModel,
        connectionFailed: props.connectionFailed,
        bedrock: props.bedrock,
        canManageSpace: props.canManageSpace,
        reviewer: { runner, label: reviewerName },
      };
  const rows = readinessRows(readinessInput);
  const blocked = startBlockedReason(readinessInput);
  const reviews = readinessInput.ready;
  const skipping = readinessInput.investigations - reviews;

  // ------------------------------------------------ actions
  async function create(): Promise<string | null> {
    if (!name.trim()) {
      setNameError("Enter a name.");
      return null;
    }
    const selections = selectionsForSave();
    if (!selections?.length) {
      setError("Choose at least one investigation with a cached journal first.");
      return null;
    }
    const m = readModels();
    const r = await createAuditAction(alias, { name, profileId, selections: selections as never, reviewModelId: usesBedrock ? m.review || null : null, reportModelId: m.report || null, ...reviewerFields() });
    if (!r.ok) {
      if (r.fieldErrors.name) setNameError(r.fieldErrors.name);
      setError(r.message);
      return null;
    }
    return r.auditId;
  }

  async function saveDraft(): Promise<boolean> {
    if (!draft) return false;
    if (!name.trim()) {
      setNameError("Enter a name.");
      return false;
    }
    const m = readModels();
    const r = await saveDraftAction(alias, draft.id, { name, reviewModelId: usesBedrock ? m.review : "", reportModelId: m.report, ...reviewerFields() });
    if (!r.ok) {
      if (r.fieldErrors.name) setNameError(r.fieldErrors.name);
      setError(r.message);
      return false;
    }
    return true;
  }

  const onSave = () =>
    startBusy(async () => {
      setError(null);
      if (!draft) {
        const newId = await create();
        if (newId) {
          toast.success("Draft saved");
          router.push(`${base}/${newId}`);
        }
        return;
      }
      if (await saveDraft()) {
        toast.success("Draft saved");
        router.refresh();
      }
    });

  const onAdd = () =>
    startBusy(async () => {
      if (!draft) return;
      const sel = selectionsForSave();
      if (!sel?.length) return;
      setError(null);
      const r = await addItemsAction(alias, draft.id, sel);
      if (!r.ok) return setError(r.message);
      toast.success(r.added ? `Added ${plural(r.added, "investigation")}` : "Those investigations are already in the audit");
      setPickerKey((k) => k + 1);
      router.refresh();
    });

  const onRemove = (itemId: string) =>
    startBusy(async () => {
      if (!draft) return;
      const r = await removeItemsAction(alias, draft.id, [itemId]);
      if (!r.ok) return setError(r.message);
      router.refresh();
    });

  const onStart = () =>
    startBusy(async () => {
      setError(null);
      let auditId = id;
      if (!auditId) auditId = await create();
      else if (!(await saveDraft())) return;
      if (!auditId) return;
      const r = await startAuditAction(alias, auditId, { skipIncomplete: skipping > 0 });
      if (!r.ok) {
        setError(r.message);
        if (!id) router.push(`${base}/${auditId}`);
        return;
      }
      toast.success(`Started ${plural(r.items, "review")}`);
      router.push(`${base}/${auditId}`);
      router.refresh();
    });

  const onDiscard = () =>
    startBusy(async () => {
      if (!draft) return;
      const r = await deleteDraftAction(alias, draft.id);
      if (!r.ok) return setError(r.message);
      toast.success(`Discarded ${draft.name}`);
      router.push(base);
    });

  // ------------------------------------------------ render
  const reviewInherit = profile.defaultReview.id ? `Space default: ${profile.defaultReview.id}` : "No default is set";
  const reportInherit = profile.defaultReport.id
    ? `${profile.defaultReport.sourceLabel ?? "Default"}: ${profile.defaultReport.id}`
    : usesBedrock
      ? "Same as the review model"
      : "None: write the narrative yourself";
  const evidenceRows: EvidenceRowView[] = draft ? draft.items : [];
  const skippedText = skipping > 0 ? `. ${plural(skipping, "investigation")} not ready ${skipping === 1 ? "is" : "are"} skipped` : "";
  const optionText = (reviewer?.options ?? []).map((o) => `${o.label}: ${o.values.find((v) => v.id === (runnerOptions[o.id] ?? o.default))?.label ?? runnerOptions[o.id] ?? o.default}`);
  const facts: Fact[] = usesBedrock
    ? [
        ["Reviews", `${reviews}, one per investigation, ${profile.concurrency} at a time${skippedText}`],
        ["Model", currentModel ? <span className="font-mono text-xs break-all">{currentModel}</span> : <span className="text-muted-foreground">None chosen</span>],
        ["Step limit", `${profile.stepLimit} per review`],
        ["Runs in", props.runsIn],
      ]
    : [
        ["Reviews", `${reviews}, one per investigation${skippedText}`],
        ["Reviewer", [reviewerName, ...optionText].join(", ")],
        ...reviewerFacts(runner),
      ];
  const startButton = (
    <Button type="button" className="w-full" onClick={onStart} disabled={busy}>
      <Play aria-hidden />
      {startLabel(reviews, runner)}
    </Button>
  );

  const profileCards = draft ? profiles.filter((p) => p.id === draft.profileId) : profiles;

  return (
    <div className="space-y-4">
      <PageHeader
        title={draft ? draft.name : "New audit"}
        description="Choose the investigations and add their ground truth. Nothing runs until you start the audit."
        actions={
          <>
            {draft ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" disabled={busy}>
                    Discard
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Discard {draft.name}?</AlertDialogTitle>
                    <AlertDialogDescription>Its uploads stay in this space for later audits.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep the draft</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={onDiscard}>
                      <Trash2 aria-hidden />
                      Discard draft
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : (
              <Link href={base} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Discard
              </Link>
            )}
            <Button variant="outline" size="sm" onClick={onSave} disabled={busy}>
              Save draft
            </Button>
          </>
        }
      />
      {error ? (
        <Callout tone="destructive" title="That didn't work" afterAction>
          {error}
        </Callout>
      ) : null}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          {/* Name, profile and models */}
          <section aria-labelledby="np-h" className="rounded-xl border bg-card">
            <div className="flex min-h-12 items-center border-b px-4 py-2">
              <h2 id="np-h" className="text-sm font-semibold">
                Name and profile
              </h2>
            </div>
            <div className="space-y-4 px-4 py-3">
              <div className="space-y-1.5">
                <Label htmlFor="audit-name">Name</Label>
                <Input
                  id="audit-name"
                  value={name}
                  maxLength={200}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameError(null);
                  }}
                  aria-invalid={nameError ? true : undefined}
                  aria-describedby={nameError ? "audit-name-err" : undefined}
                />
                {nameError ? (
                  <p id="audit-name-err" role="alert" className="text-xs text-destructive-fg">
                    {nameError}
                  </p>
                ) : null}
              </div>
              <fieldset className="space-y-2">
                <legend className="mb-1.5 text-sm font-medium">Profile</legend>
                {profileCards.map((p) => {
                  const on = p.id === profileId;
                  return (
                    <label key={p.id} className={cn("flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring", on && "border-2 border-foreground px-[11px] py-[9px]")}>
                      <input
                        type="radio"
                        name="profile"
                        value={p.id}
                        checked={on}
                        disabled={!!draft}
                        onChange={() => {
                          setProfileId(p.id);
                          setAddCohort(p.cohorts[0]?.id ?? "");
                          setMoves({});
                          setModels({ review: "", report: "" });
                          pickRunner(p.defaultRunner);
                        }}
                        className="mt-0.5 size-5 shrink-0 accent-foreground focus-visible:outline-none"
                      />
                      <span className="min-w-0 text-[13px]">
                        <span className="block text-sm font-semibold">{p.label}</span>
                        <span className="block max-w-[72ch] text-muted-foreground">{p.description}</span>
                        {p.needs ? <span className="mt-0.5 block text-xs text-muted-foreground">{p.needs}</span> : null}
                      </span>
                    </label>
                  );
                })}
                {draft ? <p className="text-xs text-muted-foreground">The profile is fixed once the draft is saved. Discard the draft to use another profile.</p> : null}
              </fieldset>
              {props.reviewers.length ? (
                <fieldset className="space-y-2">
                  <legend className="mb-1.5 text-sm font-medium">Reviewer</legend>
                  {props.reviewers.map((r) => {
                    const on = r.id === runner;
                    return (
                      <div key={r.id} className={cn("rounded-lg border", on && "border-2 border-foreground")}>
                        <label className={cn("flex cursor-pointer items-start gap-3 px-3 py-2.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring", on && "px-[11px] py-[9px]")}>
                          <input
                            type="radio"
                            name="reviewer"
                            value={r.id}
                            checked={on}
                            onChange={() => pickRunner(r.id)}
                            className="mt-0.5 size-5 shrink-0 accent-foreground focus-visible:outline-none"
                          />
                          <span className="min-w-0 text-[13px]">
                            <span className="block text-sm font-semibold">{r.label}</span>
                            <span className="block max-w-[72ch] text-muted-foreground">{r.description}</span>
                          </span>
                        </label>
                        {on && r.options.length ? (
                          <div className="space-y-3 border-t px-3 py-3 pl-11">
                            {r.options.map((o) => (
                              <fieldset key={o.id} className="space-y-1">
                                <legend className="text-[13px] font-medium">{o.label}</legend>
                                {o.description ? <p className="text-xs text-muted-foreground">{o.description}</p> : null}
                                {o.values.map((v) => (
                                  <label key={v.id} className="flex cursor-pointer items-start gap-2.5 py-0.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring">
                                    <input
                                      type="radio"
                                      name={`reviewer-${r.id}-${o.id}`}
                                      value={v.id}
                                      checked={(runnerOptions[o.id] ?? o.default) === v.id}
                                      onChange={() => setRunnerOptions((x) => ({ ...x, [o.id]: v.id }))}
                                      className="mt-0.5 size-5 shrink-0 accent-foreground focus-visible:outline-none"
                                    />
                                    <span className="min-w-0 text-[13px]">
                                      <span className="block font-medium">{v.label}</span>
                                      {v.description ? <span className="block max-w-[64ch] text-muted-foreground">{v.description}</span> : null}
                                    </span>
                                  </label>
                                ))}
                              </fieldset>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </fieldset>
              ) : null}
              <div ref={modelsRef} className="space-y-1.5">
                {/* Hidden, not removed, for a reviewer without a model: the typed value stays if the choice changes back. */}
                <div hidden={!usesBedrock} className="space-y-1.5">
                  <Label htmlFor="reviewModelId">Review model</Label>
                  <ModelPicker
                    key={`review-${profile.id}`}
                    name="reviewModelId"
                    id="reviewModelId"
                    spaceAlias={alias}
                    defaultValue={draft?.reviewModelId ?? ""}
                    inheritLabel={reviewInherit}
                    aria-describedby="review-model-help"
                    catalog={props.catalog}
                    onChange={(v) => setModels((m) => ({ ...m, review: v }))}
                  />
                  <p id="review-model-help" className="text-xs text-muted-foreground">
                    {profile.defaultReview.id ? (
                      props.canManageSpace ? (
                        <>
                          Leave it empty to use the space default, set in{" "}
                          <Link className="font-medium underline underline-offset-4" href={`/spaces/${encodeURIComponent(alias)}/settings#inference`}>
                            Space settings
                          </Link>
                          .
                        </>
                      ) : (
                        "Leave it empty to use the space default. An Admin sets it in Space settings."
                      )
                    ) : props.canManageSpace ? (
                      <>
                        No default is set. Choose a model here, or set a default in{" "}
                        <Link className="font-medium underline underline-offset-4" href={`/spaces/${encodeURIComponent(alias)}/settings`}>
                          Space settings
                        </Link>
                        .
                      </>
                    ) : (
                      "No default is set. Choose a model here, or ask an Admin to set a default in Space settings."
                    )}
                  </p>
                </div>
                <Collapsible>
                  <CollapsibleTrigger className="group mt-1 inline-flex min-h-6 items-center gap-1 rounded-sm text-[13px] font-medium">
                    <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
                    Advanced
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-2 space-y-1.5">
                    <Label htmlFor="reportModelId">Report model</Label>
                    <ModelPicker
                      key={`report-${profile.id}`}
                      name="reportModelId"
                      id="reportModelId"
                      spaceAlias={alias}
                      defaultValue={draft?.reportModelId ?? ""}
                      inheritLabel={reportInherit}
                      aria-describedby="report-model-help"
                      catalog={props.catalog}
                      onChange={(v) => setModels((m) => ({ ...m, report: v }))}
                    />
                    <p id="report-model-help" className="text-xs text-muted-foreground">
                      {usesBedrock
                        ? "Drafts the report's narrative sections. Leave it empty to use the default."
                        : "Drafts the report's narrative sections with a model in Amazon Bedrock. Leave it empty to write them yourself."}
                    </p>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            </div>
          </section>

          {/* Investigations */}
          <section aria-labelledby="inv-h" className="rounded-xl border bg-card">
            {draft ? (
              <DraftItems
                items={draft.items}
                cohorts={profile.cohorts}
                onRemove={onRemove}
                busy={busy}
              />
            ) : null}
            <div className={cn(draft && "border-t")}>
              <InvestigationPicker
                key={`${profile.id}-${pickerKey}`}
                idPrefix={draft ? "add" : "inv"}
                title={draft ? "Add investigations" : "Investigations"}
                alias={alias}
                incidentIdTemplate={profile.incidentIdTemplate}
                docKinds={profile.inputs.map((i) => i.kind)}
                statuses={props.statuses}
                canExportJournals={props.canExportJournals}
                onChange={setPicker}
              />
              {draft && picker.selection ? (
                <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2.5">
                  {profile.cohorts.length ? (
                    <label className="flex items-center gap-2 text-[13px]">
                      Add to
                      <select value={addCohort} onChange={(e) => setAddCohort(e.target.value)} className="h-7 rounded-lg border border-input bg-transparent px-2 text-[13px] dark:bg-input/30">
                        {profile.cohorts.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <Button size="sm" variant="outline" onClick={onAdd} disabled={busy}>
                    Add {plural(found.length, "investigation")}
                  </Button>
                </div>
              ) : null}
            </div>
          </section>

          {/* Cohorts (new audit with a before-and-after profile) */}
          {!draft && profile.cohorts.length ? (
            <section aria-labelledby="coh-h" className="rounded-xl border bg-card">
              <div className="flex min-h-12 items-center justify-between border-b px-4 py-2">
                <h2 id="coh-h" className="text-sm font-semibold">
                  Cohorts
                </h2>
                <span className="text-xs text-muted-foreground">{profile.cohorts.map((c) => c.label).join(" and ")}</span>
              </div>
              <div className="space-y-3 px-4 py-3 text-[13px]">
                <p className="text-muted-foreground">Each investigation goes to the cohort for when it started. You can move one by hand below.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="split-at">Split at</Label>
                    <select id="split-at" value={splitMode} onChange={(e) => setSplitMode(e.target.value)} aria-describedby="split-help" className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30">
                      {props.releases.map((r) => (
                        <option key={r.name} value={`release:${r.name}`}>
                          Release {r.name}, {r.atText}
                        </option>
                      ))}
                      <option value="time">A time you enter</option>
                    </select>
                    <p id="split-help" className="text-xs text-muted-foreground">
                      A release, or a time you enter.
                    </p>
                  </div>
                  {splitMode === "time" ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="split-time">Time</Label>
                      <Input id="split-time" type="datetime-local" value={splitTime} onChange={(e) => setSplitTime(e.target.value)} />
                    </div>
                  ) : null}
                </div>
              </div>
              {found.length ? (
                <>
                  <div className="flex flex-wrap gap-x-6 gap-y-1 border-t px-4 py-3 text-[13px]">
                    {cohortCounts(cohortItems, assignments, cohortIds).map((c) => (
                      <span key={c.cohort}>
                        <span className="mr-1.5 text-lg font-semibold tabular-nums">{c.n}</span>
                        {profile.cohorts.find((x) => x.id === c.cohort)?.label}
                        {c.from && c.to ? `, ${new Date(c.from).toLocaleDateString(undefined, { month: "short", day: "numeric" })} to ${new Date(c.to).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}
                      </span>
                    ))}
                  </div>
                  <table className="w-full border-t text-[13px]">
                    <thead className="bg-muted/50 text-left text-muted-foreground">
                      <tr>
                        <th className="px-4 py-2 font-medium">Investigation</th>
                        <th className="px-2 py-2 text-right font-medium">Started</th>
                        <th className="px-2 py-2 pr-4 font-medium">Cohort</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {(showAllCohort ? found : found.slice(0, 3)).map((f) => {
                        const a = assignments.find((x) => x.taskId === f.taskId);
                        return (
                          <tr key={f.taskId} className="align-top">
                            <td className="px-4 py-2 font-mono text-xs">{f.incidentId ?? f.taskId}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{f.createdAt ? new Date(f.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Unknown"}</td>
                            <td className="px-2 py-2 pr-4">
                              <select
                                aria-label={`Cohort for ${f.incidentId ?? f.taskId}`}
                                value={a?.cohort ?? cohortIds[0]}
                                onChange={(e) => setMoves((m) => ({ ...m, [f.taskId]: e.target.value }))}
                                className="h-7 rounded-lg border border-input bg-transparent px-2 text-[13px] dark:bg-input/30"
                              >
                                {profile.cohorts.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.label}
                                  </option>
                                ))}
                              </select>
                              {a?.moved ? <p className="mt-1 text-xs text-muted-foreground">Moved by hand</p> : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {found.length > 3 ? (
                    <div className="flex justify-center border-t px-4 py-2">
                      <Button variant="ghost" size="sm" onClick={() => setShowAllCohort((s) => !s)}>
                        {showAllCohort ? "Show fewer" : `Show all ${found.length}`}
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : null}
            </section>
          ) : null}

          {/* Ground truth */}
          {profile.inputs.length ? (
            <GroundTruthCard
              alias={alias}
              auditId={id}
              ensureAudit={id ? undefined : create}
              inputs={profile.inputs}
              rows={evidenceRows}
              maxUploadMb={props.maxUploadMb}
              disabledReason={!draft && !picker.selection ? "Choose investigations first: uploads are matched to them." : null}
              names={draft?.names ?? {}}
            />
          ) : null}
        </div>

        {/* Readiness and Start */}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
          <section aria-labelledby="ready-h" className="rounded-xl border bg-card">
            <div className="flex min-h-12 items-center border-b px-4 py-2">
              <h2 id="ready-h" className="text-sm font-semibold">
                Readiness
              </h2>
            </div>
            <ul className="divide-y text-[13px]" aria-live="polite">
              {rows.map((r, i) => {
                const Icon = r.tone === "success" ? CircleCheck : r.tone === "warning" ? TriangleAlert : CircleX;
                return (
                  <li key={i} className="flex items-start gap-2 px-4 py-2.5">
                    <Icon className={cn("mt-0.5 size-4 shrink-0", r.tone === "success" ? "text-success-fg" : r.tone === "warning" ? "text-warning-fg" : "text-destructive-fg")} aria-hidden />
                    <span className="min-w-0">
                      {r.text}
                      {r.detail ? (
                        <details className="mt-0.5 text-xs text-muted-foreground">
                          <summary className="cursor-pointer">Details</summary>
                          <span className="mt-0.5 block break-words">{r.detail}</span>
                        </details>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
          <section aria-labelledby="start-h" className="rounded-xl border bg-card">
            <div className="flex min-h-12 items-center border-b px-4 py-2">
              <h2 id="start-h" className="text-sm font-semibold">
                Start the audit
              </h2>
            </div>
            <div className="space-y-3 px-4 py-3 text-[13px]">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                {facts.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              {blocked ? (
                <div className="space-y-1">
                  <DisabledReason reason={blocked} className="[&>button]:w-full">
                    {startButton}
                  </DisabledReason>
                  {blocked === CONNECTION_FAILED_REASON ? <p className="text-xs text-muted-foreground">{props.connectionNextStep}</p> : null}
                </div>
              ) : (
                startButton
              )}
              <p className="text-xs text-muted-foreground">{startHelp(runner)}</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function DraftItems({
  items,
  cohorts,
  onRemove,
  busy,
}: {
  items: DraftFormView["items"];
  cohorts: { id: string; label: string }[];
  onRemove: (itemId: string) => void;
  busy: boolean;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 10);
  return (
    <div>
      <div className="flex min-h-12 items-center justify-between border-b px-4 py-2">
        <h2 id="inv-h" className="text-sm font-semibold">
          Investigations in this draft
        </h2>
        <span className="text-xs text-muted-foreground">{plural(items.length, "investigation")}</span>
      </div>
      {items.length ? (
        <table className="w-full text-[13px]">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Incident</th>
              {cohorts.length ? <th className="px-2 py-2 font-medium">Cohort</th> : null}
              <th className="px-2 py-2 font-medium">Ready</th>
              <th className="px-2 py-2 pr-4 text-right font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {shown.map((i) => (
              <tr key={i.itemId} className="align-top">
                <td className="px-4 py-2">
                  <span className="font-mono text-xs">{i.incidentId ?? i.taskId}</span>
                  {i.title ? <span className="block text-xs text-muted-foreground">{i.title}</span> : null}
                </td>
                {cohorts.length ? <td className="px-2 py-2">{i.cohortLabel ?? "None"}</td> : null}
                <td className="px-2 py-2">
                  {i.ready ? (
                    <span className="flex items-center gap-1 text-success-fg">
                      <CircleCheck className="size-3.5" aria-hidden />
                      Ready
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-warning-fg">
                      <TriangleAlert className="size-3.5" aria-hidden />
                      {i.journalPresent ? "Missing ground truth" : "No cached journal"}
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 pr-4 text-right">
                  <Button variant="ghost" size="sm" onClick={() => onRemove(i.itemId)} disabled={busy} aria-label={`Remove ${i.incidentId ?? i.taskId}`}>
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">No investigations yet. Add them below.</p>
      )}
      {items.length > 10 ? (
        <div className="flex justify-center border-t px-4 py-2">
          <Button variant="ghost" size="sm" onClick={() => setAll((a) => !a)}>
            {all ? "Show fewer" : `Show all ${items.length}`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
