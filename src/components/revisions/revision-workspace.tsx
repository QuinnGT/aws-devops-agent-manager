"use client";

import { CircleCheck, CirclePlus, CircleX, Download, File, FileText, Folder, FolderOpen, GitBranch, GitPullRequest, Lock, Microscope, PenLine, RotateCcw, Save, Trash2, TriangleAlert, Wrench } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { DisabledReason } from "@/components/common/disabled-reason";
import { PageHeader } from "@/components/common/page-header";
import { StatusBadge } from "@/components/common/status-badge";
import { formatTime, type ViewerZone } from "@/components/common/time-format";
import { sortValidation } from "@/components/common/status-words";
import { ValidationList } from "@/components/common/validation-list";
import { EditorArea } from "@/components/drafts/draft-editor";
import { measureText } from "@/components/drafts/editor-state";
import { useJobStatus } from "@/components/job-progress";
import type { ActionResult } from "@/components/plans/action-state";
import { SizeMeterLine, sizeMeterText } from "@/components/plans/size-meter-line";
import { SafeMarkdown } from "@/components/safe-markdown";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { FileDiff } from "@/server/assets/diff";
import type { PackageFolder, PageFileMark, SaveFinding } from "@/server/revisions/views";
import type { ValidationResult } from "@/server/validation/types";
import { AbandonButton, type AbandonRevisionAction } from "./abandon-button";
import { applyQuickFix, deleteOpenFile, editedFiles, isEdited, markSaved, newFileProblem, renameOpenFile, restoreOpenFile, splitIncident, type OpenFile } from "./editor-state";
import { SaveDialog, type SaveOutcome, type SaveRevisionAction, type SaveRules } from "./save-dialog";
import { SavesList, type SaveRow } from "./saves-list";
import { ToAddressCard, type RemoveToAddressAction, type ToAddressItem } from "./to-address-card";
import { FileDiffPanel } from "./file-diff-panel";
import { exportLeftOutText, planButtonReason, planHint, REVISION_STATUS, revisionWord, type RevisionStateInput } from "./words";

export type CreateRevisionPlanAction = (revisionId: string) => Promise<ActionResult<{ planId: string }>>;

export interface FileView {
  kind: "text" | "binary" | "too-large";
  text?: string;
  size: number;
}

export interface RevisionWorkspaceProps {
  alias: string;
  zone: ViewerZone;
  revision: {
    id: string;
    name: string;
    branch: string;
    headCommit: string | null;
    baseLabel: string;
    baseKind: "live" | "release";
    /** "release v1.2" as the Diff tab names it: "v1.2" or "the live space" */
    baseShort: string;
    createdBy: string;
    createdAt: string;
    saves: number;
    linkedFindings: number;
  };
  stateInput: RevisionStateInput;
  /** The tab to open first (from ?tab=) */
  initialTab?: "edit" | "diff" | "changelog" | "saves";
  /** Server-rendered callouts for the state (planned, applied, abandoned, branch missing) */
  callouts: ReactNode;
  can: { save: boolean; plan: boolean; export: boolean; abandon: boolean };
  /** Why saving is refused right now (state), or null */
  saveBlocked: string | null;
  server: { createPlan: { available: boolean; reason: string | null }; export: { available: boolean; reason: string | null }; abandon: { available: boolean; reason: string | null } };
  plan: { planId: string; title: string; state: string; outOfDate: boolean; href: string } | null;
  /** The assets a plan from the revision would hold (the ones it changed against its base), when known */
  planScope?: { changed: string[] } | null;
  exportHref: string;
  plansHref: string;
  tree: { path: string; size: number }[];
  folders: PackageFolder[];
  marks: Record<string, PageFileMark>;
  initial: { path: string; view: FileView } | null;
  build: {
    status: "passed" | "failed";
    errors: number;
    warnings: number;
    ranAt: string;
    results: ValidationResult[];
    omitted: number;
    saveNumber: number | null;
    /** While the build fails: what the package download leaves out; null for older builds */
    leftOut?: { assetKey: string; source: string | null; reasons: string[] }[] | null;
  } | null;
  /** Package path of the note a download with build errors carries, or null */
  leftOutNote?: string | null;
  /** The file each build result is about, by result index */
  resultFiles: (string | null)[];
  rebuilt: string | null;
  findings: { id: string; title: string; incidentId: string | null; kindLabel: string; auditName: string; href: string | null; state: string }[];
  /** The findings sent to the revision from an audit and not linked yet */
  toAddress: ToAddressItem[];
  /** Show the "To address" card: it has findings, or the revision still takes them */
  showToAddress: boolean;
  /** `revisions.build` and an open revision: findings can be taken off the list */
  canRemoveToAddress: boolean;
  removeToAddressAction: RemoveToAddressAction;
  auditsHref: string;
  /** The audits the revision's findings come from */
  sourceAudits: { id: string; name: string; href: string }[];
  changelog: string;
  changelogPath: string | null;
  /** `edited`: the files the saves edited; `built`: the files the build wrote (change record, validation result) */
  baseDiff: { files: FileDiff[]; added: number; removed: number; edited: { added: number; removed: number }; built: { added: number; removed: number; paths: string[] } };
  saves: SaveRow[];
  limits: { agentsMdMaxBytes: number; agentsMdRecommendedLines: number };
  pendingRunId: string | null;
  saveFindings: SaveFinding[];
  saveRules: SaveRules;
  saveAction: SaveRevisionAction;
  planAction: CreateRevisionPlanAction;
  abandonAction: AbandonRevisionAction;
}

const TAB = "h-9 flex-none rounded-t-md rounded-b-none px-2.5 text-[13px] group-data-horizontal/tabs:after:bottom-[-1px] data-active:font-semibold";
const PILL = "rounded-full bg-muted px-1.5 font-mono text-xs font-medium text-muted-foreground tabular-nums";
const EMPTY_FINDINGS_SHOWN = 2;

/** "Deleted", "Error", "Built" or "Edited" for a tree row (text, never color alone); a pending delete, then errors, win. */
function markOf(mark: PageFileMark | undefined, unsaved: boolean, deleted = false): { label: string; className: string } | null {
  if (deleted) return { label: "Deleted", className: "text-destructive-fg" };
  if (mark?.errors) return { label: "Error", className: "text-destructive-fg" };
  if (mark?.generated) return { label: "Built", className: "text-muted-foreground" };
  if (unsaved || mark?.edited) return { label: "Edited", className: "text-info-fg" };
  return null;
}

/**
 * Revision detail, option 1 (revision-detail.md): the header with Export
 * package zip and Create plan, then the Edit, Diff, Changelog and Saves tabs
 * in client state (unsaved text survives a tab switch). The file tree and
 * the right rail (build and validation, linked findings) stay beside every
 * tab. Files load from the file Route Handler as they are opened; edits stay
 * in this tab until "Save" commits them with the save dialog.
 */
export function RevisionWorkspace(p: RevisionWorkspaceProps) {
  const router = useRouter();
  const [tab, setTabState] = useState<string>(p.initialTab ?? "edit");
  // The tab is client state (unsaved text survives a switch); the URL keeps it for reload and links.
  const setTab = useCallback((t: string) => {
    setTabState(t);
    const url = new URL(window.location.href);
    if (t === "edit") url.searchParams.delete("tab");
    else url.searchParams.set("tab", t);
    window.history.replaceState(window.history.state, "", url);
  }, []);
  const [files, setFiles] = useState<Record<string, OpenFile & { head: string | null }>>(() =>
    p.initial ? { [p.initial.path]: { path: p.initial.path, base: p.initial.view.text ?? null, text: p.initial.view.text ?? "", kind: p.initial.view.kind, size: p.initial.view.size, head: p.revision.headCommit } } : {},
  );
  const [current, setCurrent] = useState<string | null>(p.initial?.path ?? null);
  const [loading, setLoading] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  // One-click fixes applied since the last build, a line to jump to, and why a fix couldn't apply.
  const [fixed, setFixed] = useState<ReadonlySet<ValidationResult>>(new Set());
  const [focusAt, setFocusAt] = useState<{ path: string; line: number; key: number } | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const [localRun, setLocalRun] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planning, startPlan] = useTransition();
  const [showAllFindings, setShowAllFindings] = useState(false);
  const [announce, setAnnounce] = useState("");
  const reasonId = useId();
  const editorRef = useRef<HTMLDivElement>(null);

  const edited = useMemo(() => editedFiles(files), [files]);
  const dirty = edited.length > 0;
  const editable = p.can.save && !p.saveBlocked;
  const runId = localRun ?? p.pendingRunId;

  // Read one file at the branch head into the cache (replacing what is there).
  const fetchFile = useCallback(
    async (path: string) => {
      setLoading(path);
      setLoadError(null);
      try {
        const res = await fetch(`/api/spaces/${encodeURIComponent(p.alias)}/revisions/${encodeURIComponent(p.revision.id)}/file?path=${encodeURIComponent(path)}`, { cache: "no-store" });
        if (!res.ok) throw new Error(res.status === 404 ? "The file isn't on the revision branch any more. Reload the page." : "The file couldn't be read. Try again.");
        const body = (await res.json()) as { path: string; head: string; view: FileView };
        const file = { path, base: body.view.text ?? null, text: body.view.text ?? "", kind: body.view.kind, size: body.view.size, head: body.head };
        setFiles((fs) => (fs[path] && isEdited(fs[path]!) ? fs : { ...fs, [path]: file }));
        return file;
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "The file couldn't be read.");
        return null;
      } finally {
        setLoading((l) => (l === path ? null : l));
      }
    },
    [p.alias, p.revision.id],
  );

  // After a build: files without unsaved text are read again when opened, because the build may have
  // rewritten them (change record, indexes, shared sections); the open one is read now.
  const afterBuild = useCallback(() => {
    setFiles((fs) => Object.fromEntries(Object.entries(fs).filter(([, f]) => isEdited(f))));
    setFixed(new Set());
    if (current && p.tree.some((t) => t.path === current)) void fetchFile(current);
    router.refresh();
  }, [current, fetchFile, p.tree, router]);

  // The page refreshes when a save's build (or the create job) ends.
  useJobStatus(runId, {
    onDone: () => {
      setLocalRun(null);
      afterBuild();
    },
  });
  const building = runId !== null;

  // Unsaved edits: the browser asks before leaving, and so does a link to another page of the app.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    const click = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download") || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      if (!window.confirm("You have unsaved changes in this revision. Leave the page and lose them?")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", click, true);
    };
  }, [dirty]);

  const open = useCallback(
    // `inEditor`: the file is already in the editor's state (a fix just made it), so it isn't read from the branch.
    (path: string, opts: { focus?: boolean; inEditor?: boolean } = {}) => {
      setCurrent(path);
      setLoadError(null);
      const url = new URL(window.location.href);
      url.searchParams.set("file", path);
      window.history.replaceState(window.history.state, "", url);
      if (opts.focus) setTab("edit");
      if (!files[path] && !opts.inEditor) void fetchFile(path);
    },
    [fetchFile, files, setTab],
  );

  const setText = (path: string, text: string) => setFiles((fs) => (fs[path] ? { ...fs, [path]: { ...fs[path]!, text } } : fs));

  const onSaved = (outcome: SaveOutcome, paths: string[]) => {
    if (outcome.kind === "error") return;
    setFiles((fs) => markSaved(fs, paths) as typeof fs);
    setAnnounce(outcome.kind === "passed" ? "Saved. The build passed." : `Saved. The build has ${outcome.errors} ${outcome.errors === 1 ? "error" : "errors"}.`);
  };

  const allPaths = useMemo(() => [...new Set([...p.tree.map((t) => t.path), ...Object.keys(files)])], [p.tree, files]);
  const folders = useMemo(() => {
    const added = Object.keys(files).filter((k) => !p.tree.some((t) => t.path === k));
    if (!added.length) return p.folders;
    const out = p.folders.map((f) => ({ ...f, files: [...f.files] }));
    for (const a of added) {
      const top = a.includes("/") ? a.slice(0, a.indexOf("/")) : null;
      const g = out.find((f) => f.name === top);
      if (g) g.files = [...g.files, a].sort((x, y) => x.localeCompare(y));
      else out.push({ name: top, files: [a] });
    }
    return out;
  }, [files, p.folders, p.tree]);

  const word = revisionWord({ ...p.stateInput, building });
  const planReason = p.can.plan
    ? planButtonReason({
        server: p.server.createPlan,
        dirty,
        building,
        changes: p.revision.saves,
        baseLabel: p.revision.baseLabel,
        errors: p.build?.errors ?? 0,
        buildFailed: p.build?.status === "failed",
        plan: p.plan,
      })
    : null;
  const exportReason = p.can.export ? (dirty ? "Save your changes first." : building ? "Building after your last save." : p.server.export.available ? null : p.server.export.reason) : null;
  const headerReason = planReason ?? exportReason;

  const onPlan = () =>
    startPlan(async () => {
      setPlanError(null);
      const r = await p.planAction(p.revision.id);
      if (!r.ok) {
        setPlanError(r.message);
        return;
      }
      router.push(`${p.plansHref}/${encodeURIComponent(r.planId)}`);
    });

  const buildBadge = building ? REVISION_STATUS.building : p.build ? (p.build.status === "passed" ? { tone: "success" as const, icon: CircleCheck, label: "Passed" } : { tone: "destructive" as const, icon: REVISION_STATUS.buildFailed.icon, label: "Failed" }) : null;
  const resultFile = useMemo(() => new Map((p.build?.results ?? []).map((r, i) => [r, p.resultFiles[i] ?? null] as const)), [p.build, p.resultFiles]);

  const focusSeq = useRef(0);
  const goToLine = (path: string, line: number, inEditor = false) => {
    open(path, { focus: true, inEditor });
    focusSeq.current += 1;
    setFocusAt({ path, line, key: focusSeq.current });
  };

  // Apply a result's fix to its file in the editor (loading it first); it is saved with the next save.
  const applyFix = async (r: ValidationResult) => {
    const fix = r.fix;
    const target = fix?.from ?? resultFile.get(r) ?? null;
    if (!fix || !target) return;
    setFixError(null);
    const loaded = files[target] ?? (await fetchFile(target));
    if (!loaded) return;
    const out = applyQuickFix({ ...files, [target]: loaded }, target, fix);
    if ("error" in out) {
      setFixError(out.error);
      return;
    }
    setFiles(out.files as typeof files);
    setFixed((s) => new Set(s).add(r));
    if (out.line) goToLine(out.path, out.line, true);
    else open(out.path, { focus: true, inEditor: true });
    setAnnounce(`${fix.label}: done in the editor. Save to check it.`);
  };

  const fixControl = (r: ValidationResult) => {
    if (!r.fix || !editable) return null;
    if (fixed.has(r)) return <span className="text-xs text-success-fg">Fixed in the editor. Save to check it.</span>;
    return (
      <Button variant="outline" size="sm" onClick={() => void applyFix(r)}>
        <Wrench aria-hidden />
        {r.fix.label}
      </Button>
    );
  };
  const shownFindings = showAllFindings ? p.findings : p.findings.slice(0, EMPTY_FINDINGS_SHOWN);

  const header = (
    <PageHeader
      icon={<GitBranch />}
      title={p.revision.name}
      badges={<StatusBadge {...REVISION_STATUS[word]} />}
      meta={[
        p.revision.baseKind === "live" ? `Based on ${p.revision.baseLabel}, ${formatTime(p.revision.createdAt, "datetime", p.zone)}` : `Based on ${p.revision.baseLabel}`,
        <span key="branch">
          Branch <span className="font-mono text-xs break-all">{p.revision.branch}</span>
        </span>,
        `${p.revision.saves} ${p.revision.saves === 1 ? "save" : "saves"}`,
        `${p.revision.linkedFindings} linked ${p.revision.linkedFindings === 1 ? "finding" : "findings"}`,
        p.sourceAudits.length ? (
          <span key="audits">
            Findings from{" "}
            {p.sourceAudits.map((a, i) => (
              <Fragment key={a.id}>
                {i > 0 ? ", " : null}
                <Link href={a.href} className="underline underline-offset-4 hover:text-foreground">
                  {a.name}
                </Link>
              </Fragment>
            ))}
          </span>
        ) : null,
      ]}
      // One row at lg and up: the meta line wraps under the title, the buttons stay at the right with their reason under them.
      className="lg:flex-nowrap"
      actionsClassName="lg:shrink-0 lg:justify-end"
      actions={
        p.can.export || p.can.plan || (p.can.abandon && p.server.abandon.available) ? (
          <div className="flex flex-col items-start gap-1.5 lg:items-end">
            <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap lg:justify-end">
              {p.can.abandon && p.server.abandon.available ? <AbandonButton revisionId={p.revision.id} name={p.revision.name} action={p.abandonAction} disabled={building} /> : null}
              {p.can.export ? (
                exportReason ? (
                  <Button variant="outline" size="sm" disabled aria-describedby={reasonId}>
                    <Download aria-hidden />
                    Export package zip
                  </Button>
                ) : (
                  <a href={p.exportHref} download className={buttonVariants({ variant: "outline", size: "sm" })}>
                    <Download aria-hidden />
                    Export package zip
                  </a>
                )
              ) : null}
              {p.can.plan ? (
                <Button size="sm" onClick={onPlan} disabled={planReason !== null || planning} aria-describedby={planReason ? reasonId : undefined}>
                  <GitPullRequest aria-hidden />
                  {planning ? "Creating plan…" : "Create plan"}
                </Button>
              ) : null}
            </div>
            {headerReason ? (
              <p id={reasonId} className="max-w-[44ch] text-xs text-muted-foreground lg:text-right">
                <Lock className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
                {headerReason}
              </p>
            ) : p.can.plan ? (
              <p className="max-w-[44ch] text-[12.5px] text-muted-foreground lg:text-right">{planHint(p.planScope)}</p>
            ) : null}
            {planError ? (
              <p role="alert" className="max-w-[44ch] text-xs text-destructive-fg lg:text-right">
                {planError}
              </p>
            ) : null}
          </div>
        ) : null
      }
    />
  );

  const file = current ? files[current] : undefined;
  const mark = current ? p.marks[current] : undefined;
  // The last build's results about the open file, errors first.
  const fileProblems = current ? sortValidation((p.build?.results ?? []).filter((r) => resultFile.get(r) === current)) : [];
  const readOnlyFile = !editable || mark?.generated === true;
  const meter = file && file.kind === "text" && mark?.instructions ? measureText(file.text, p.limits) : null;

  const tree = (
    <Card className="gap-0 py-0" role="navigation" aria-label="Package files">
      <div className="hidden min-h-12 items-center justify-between border-b px-4 py-2 min-[900px]:flex">
        <h2 className="text-sm font-semibold">Package files</h2>
        <span className="text-xs text-muted-foreground tabular-nums">{allPaths.length}</span>
      </div>
      <div className="px-3 py-2.5 min-[900px]:hidden">
        <Select value={current ?? ""} onValueChange={(v) => open(v)}>
          <SelectTrigger aria-label="File" className="w-full max-w-full font-mono text-[13px] sm:w-auto">
            <SelectValue placeholder="Choose a file" />
          </SelectTrigger>
          <SelectContent>
            {allPaths.map((path) => (
              <SelectItem key={path} value={path} className="font-mono text-[13px]">
                {path}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <FileTree folders={folders} current={current} marks={p.marks} files={files} onOpen={(path) => open(path)} />
      {editable ? (
        <div className="hidden border-t px-2 py-1.5 min-[900px]:block">
          <Button variant="ghost" size="sm" onClick={() => setNewOpen(true)}>
            <CirclePlus aria-hidden />
            New file
          </Button>
        </div>
      ) : null}
    </Card>
  );

  const editor = (
    <Card className="gap-0 py-0" ref={editorRef}>
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
        <span className="font-mono text-[13px] break-all text-muted-foreground">{current ?? "No file"}</span>
        {editable ? (
          <div className="flex flex-wrap items-center gap-2">
            {file && file.kind === "text" && !mark?.generated && !file.deleted ? (
              <>
                <Button variant="ghost" size="sm" onClick={() => setRenaming(file.path)}>
                  <PenLine aria-hidden />
                  Rename
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setFiles((fs) => deleteOpenFile(fs, file.path) as typeof fs)}>
                  <Trash2 aria-hidden />
                  Delete
                </Button>
              </>
            ) : null}
            {dirty ? <span className="text-[12.5px] text-warning-fg">{edited.length === 1 && edited[0]!.path === current ? "Unsaved changes" : `Unsaved changes in ${edited.length} ${edited.length === 1 ? "file" : "files"}`}</span> : null}
            {dirty ? (
              <Button size="sm" onClick={() => setSaveOpen(true)} disabled={building}>
                <Save aria-hidden />
                Save
              </Button>
            ) : (
              <DisabledReason reason="No unsaved changes">
                <Button size="sm">
                  <Save aria-hidden />
                  Save
                </Button>
              </DisabledReason>
            )}
          </div>
        ) : null}
      </div>
      {meter ? (
        <>
          <SizeMeterLine meter={meter} />
          <p className="sr-only" role="status" aria-atomic="true">
            {sizeMeterText(meter)}
          </p>
        </>
      ) : null}
      {mark?.generated ? <p className="border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">This file is built from the package. Edit its sources instead.</p> : null}
      {fixError ? (
        <p role="alert" className="border-b px-4 py-2 text-xs text-destructive-fg">
          {fixError}
        </p>
      ) : null}
      {fileProblems.length ? (
        <ul aria-label="Problems in this file" className="grid gap-2 border-b bg-muted/30 px-4 py-2.5 text-[13px]">
          {fileProblems.map((r, i) => {
            const Icon = r.level === "error" ? CircleX : TriangleAlert;
            return (
              <li key={i} className="grid grid-cols-[16px_minmax(0,1fr)] gap-2">
                <Icon className={cn("mt-0.5 size-4", r.level === "error" ? "text-destructive-fg" : "text-warning-fg")} aria-hidden />
                <div className="grid min-w-0 gap-1">
                  <p className="break-words">
                    <span className="sr-only">{r.level === "error" ? "Error: " : "Warning: "}</span>
                    {r.line && current ? (
                      <button type="button" onClick={() => goToLine(current, r.line!)} className="mr-1.5 font-mono text-xs underline underline-offset-4">
                        Line {r.line}
                      </button>
                    ) : null}
                    {r.message}
                  </p>
                  {fixControl(r) ? <div>{fixControl(r)}</div> : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {loadError ? (
        <p role="alert" className="px-4 py-3 text-[13px] text-destructive-fg">
          {loadError}
        </p>
      ) : !current ? (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">{p.tree.length ? "Choose a file in the package files." : "The package has no files."}</p>
      ) : !file ? (
        <p className="px-4 py-3 text-[13px] text-muted-foreground" aria-live="polite">
          {loading === current ? `Opening ${current}…` : `${current} isn't open yet.`}
        </p>
      ) : file.deleted ? (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-[13px]">
          <p>This file is deleted from the package when you save.</p>
          <Button variant="outline" size="sm" onClick={() => setFiles((fs) => restoreOpenFile(fs, file.path) as typeof fs)}>
            <RotateCcw aria-hidden />
            Restore
          </Button>
        </div>
      ) : file.kind === "binary" ? (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">This file is binary ({file.size.toLocaleString("en-US")} bytes) and can&apos;t be edited here.</p>
      ) : file.kind === "too-large" ? (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">This file is too large to open here ({file.size.toLocaleString("en-US")} bytes). Download the package zip to read it.</p>
      ) : (
        <EditorArea
          key={file.path}
          path={file.path}
          value={file.text}
          onChange={(v) => setText(file.path, v)}
          readOnly={readOnlyFile}
          lineNumbers
          marks={fileProblems.flatMap((r) => (r.line ? [{ line: r.line, level: r.level, text: r.message }] : []))}
          focus={focusAt?.path === file.path ? focusAt : null}
        />
      )}
      <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
        {editable ? "Plain markdown. Saving commits to the revision branch and runs the build." : p.can.save && p.saveBlocked ? `Read only. ${p.saveBlocked}` : "Read only."}
      </p>
    </Card>
  );

  const rail = (
    <div className="grid content-start gap-4 sm:grid-cols-2 min-[900px]:col-span-2 xl:col-span-1 xl:grid-cols-1">
      {p.showToAddress ? <ToAddressCard items={p.toAddress} canRemove={p.canRemoveToAddress} removeAction={p.removeToAddressAction} auditsHref={p.auditsHref} /> : null}
      <Card className="gap-0 py-0" role="region" aria-labelledby="rev-build-h">
        <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2">
          <h2 id="rev-build-h" className="text-sm font-semibold">
            Build and validation
          </h2>
          {buildBadge ? <StatusBadge {...buildBadge} /> : null}
        </div>
        {p.build ? (
          <>
            {p.build.results.length ? (
              <ValidationList
                results={p.build.results}
                codeAsDetails
                fileLink={(r) => {
                  const f = resultFile.get(r);
                  return f ? (
                    <button type="button" onClick={() => (r.line ? goToLine(f, r.line) : open(f, { focus: true }))} className="inline-flex min-h-6 items-center text-left font-mono text-xs break-all underline underline-offset-4">
                      {f}
                      {r.line ? `, line ${r.line}` : ""}
                    </button>
                  ) : null;
                }}
                action={fixControl}
              />
            ) : null}
            {p.build.omitted ? <p className="border-t px-4 py-2 text-xs text-muted-foreground">{p.build.omitted} more results are not shown.</p> : null}
            {p.can.export && p.build.status === "failed" ? (
              <div className="border-t px-4 py-2 text-[13px]">
                <p>{exportLeftOutText(p.build.leftOut ? p.build.leftOut.length : null, p.leftOutNote ?? null)}</p>
                {p.build.leftOut?.length ? (
                  <ul className="mt-1 grid gap-1">
                    {p.build.leftOut.map((a) => (
                      <li key={a.assetKey} className="min-w-0">
                        <span className="font-mono text-xs break-all">{a.source ?? a.assetKey}</span>
                        <p className="text-xs text-muted-foreground">{a.reasons[0]}</p>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <div className="grid grid-cols-[16px_minmax(0,1fr)] gap-2 border-t px-4 py-2 text-[13px] first:border-t-0">
              <CircleCheck className="mt-0.5 size-4 text-success-fg" aria-hidden />
              <div>
                {p.rebuilt ?? "Package built"}
                <p className="text-xs text-muted-foreground">
                  {p.build.saveNumber ? `After save ${p.build.saveNumber}` : "When the revision was created"}, {formatTime(p.build.ranAt, "datetime", p.zone)}
                </p>
              </div>
            </div>
          </>
        ) : (
          <p className="px-4 py-3 text-[13px] text-muted-foreground">Not built yet. The build runs on every save.</p>
        )}
      </Card>
      <Card className="gap-0 py-0" role="region" aria-labelledby="rev-findings-h">
        <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2">
          <h2 id="rev-findings-h" className="text-sm font-semibold">
            Linked findings
          </h2>
          <span className="text-xs text-muted-foreground tabular-nums">{p.findings.length}</span>
        </div>
        {p.findings.length ? (
          <ul>
            {shownFindings.map((f) => {
              const t = splitIncident(f.title, f.incidentId);
              const body = (
                <>
                  {t.incident ? <b>{t.incident}</b> : null}
                  {t.rest}
                </>
              );
              return (
                <li key={f.id} className="grid grid-cols-[16px_minmax(0,1fr)] gap-2 border-b px-4 py-2 text-[13px] last:border-b-0">
                  <Microscope className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
                  <div className="min-w-0">
                    {f.href ? (
                      <a href={f.href} className="break-words underline-offset-4 hover:underline">
                        {body}
                      </a>
                    ) : (
                      <p className="break-words">{body}</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {f.kindLabel} · {f.auditName}
                      {f.state !== "accepted" ? ` · ${f.state === "rejected" ? "rejected since it was linked" : `now ${f.state}`}` : ""}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-4 py-3 text-[13px] text-muted-foreground">No save links a finding yet.</p>
        )}
        {p.findings.length > EMPTY_FINDINGS_SHOWN ? (
          <div className="border-t px-4 py-1.5 text-center">
            <Button variant="ghost" size="sm" aria-expanded={showAllFindings} onClick={() => setShowAllFindings((v) => !v)}>
              {showAllFindings ? "Show fewer" : `Show all ${p.findings.length}`}
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );

  return (
    <div className="space-y-4">
      {header}
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      {p.callouts}
      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList variant="line" className="h-auto w-full justify-start overflow-x-auto border-b p-0" aria-label="Revision views">
          <TabsTrigger value="edit" className={TAB}>
            Edit
          </TabsTrigger>
          <TabsTrigger value="diff" className={TAB}>
            Diff against {p.revision.baseShort}
            <span className={PILL}>
              +{p.baseDiff.edited.added} −{p.baseDiff.edited.removed}
            </span>
          </TabsTrigger>
          <TabsTrigger value="changelog" className={TAB}>
            Changelog
          </TabsTrigger>
          <TabsTrigger value="saves" className={TAB}>
            Saves
            <span className={PILL}>{p.revision.saves}</span>
          </TabsTrigger>
        </TabsList>

        <div className="grid items-start gap-4 min-[900px]:grid-cols-[232px_minmax(0,1fr)] xl:grid-cols-[232px_minmax(0,1fr)_300px]">
          {tree}
          <div className="min-w-0">
            <TabsContent value="edit">{editor}</TabsContent>
            <TabsContent value="diff">
              <FileDiffPanel title={`${p.revision.baseLabel.charAt(0).toUpperCase()}${p.revision.baseLabel.slice(1)} → this revision`} files={p.baseDiff.files} builtPaths={p.baseDiff.built.paths} current={current} onPick={(f) => open(f)} dirty={dirty} />
            </TabsContent>
            <TabsContent value="changelog">
              <Card className="gap-0 py-0">
                <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
                  <span className="font-mono text-[13px] text-muted-foreground">{p.changelogPath ?? "Change record"}</span>
                  <span className="text-xs text-muted-foreground">Built from the linked findings</span>
                </div>
                <div className="overflow-x-auto px-4 py-4">
                  <SafeMarkdown headingOffset={1} className="prose prose-sm max-w-none dark:prose-invert [&_table]:min-w-[760px] [&_table]:text-xs">
                    {p.changelog}
                  </SafeMarkdown>
                </div>
              </Card>
            </TabsContent>
            <TabsContent value="saves">
              <SavesList
                saves={p.saves}
                zone={p.zone}
                started={`Started from ${p.revision.baseLabel} by ${p.revision.createdBy}, ${formatTime(p.revision.createdAt, "datetime", p.zone)}.`}
                emptyAction={
                  editable ? (
                    <Button variant="outline" size="sm" onClick={() => setTab("edit")}>
                      Edit files
                    </Button>
                  ) : null
                }
              />
            </TabsContent>
          </div>
          {rail}
        </div>
      </Tabs>

      {editable ? (
        <SaveDialog
          open={saveOpen}
          onOpenChange={setSaveOpen}
          revisionId={p.revision.id}
          branch={p.revision.branch}
          files={edited}
          findings={p.saveFindings}
          rules={p.saveRules}
          expectedHead={edited.map((f) => files[f.path]?.head ?? null).find(Boolean) ?? p.revision.headCommit}
          planWarning={p.plan && ["checking", "ready", "waiting", "approved"].includes(p.plan.state) ? `This save is not in plan ${p.plan.title}. Discard the plan and create a new one to include it.` : null}
          saveAction={async (input) => {
            const r = await p.saveAction(input);
            if (r.ok) setLocalRun(r.runId);
            return r;
          }}
          onSaved={onSaved}
        />
      ) : null}
      {editable ? (
        <NewFileDialog
          open={newOpen}
          onOpenChange={setNewOpen}
          existing={allPaths}
          folder={current?.includes("/") ? current.slice(0, current.lastIndexOf("/") + 1) : ""}
          onCreate={(path) => {
            setFiles((fs) => ({ ...fs, [path]: { path, base: null, text: "", kind: "text", size: 0, head: p.revision.headCommit } }));
            setCurrent(path);
            setTab("edit");
          }}
        />
      ) : null}
      {editable && renaming ? (
        <NewFileDialog
          open
          onOpenChange={(o) => (o ? null : setRenaming(null))}
          existing={allPaths}
          folder={renaming}
          rename
          onCreate={(path) => {
            setFiles((fs) => renameOpenFile(fs, renaming, path) as typeof fs);
            setCurrent(path);
            setTab("edit");
          }}
        />
      ) : null}
    </div>
  );
}

function FileTree({
  folders,
  current,
  marks,
  files,
  onOpen,
}: {
  folders: PackageFolder[];
  current: string | null;
  marks: Record<string, PageFileMark>;
  files: Record<string, OpenFile>;
  onOpen: (path: string) => void;
}) {
  const interesting = (path: string) => path === current || (files[path] && isEdited(files[path]!)) || marks[path]?.edited || (marks[path]?.errors ?? 0) > 0;
  return (
    <div className="hidden max-h-[70vh] overflow-y-auto px-2 py-2 min-[900px]:block">
      {folders.map((folder) => {
        const rows = folder.files.map((path) => {
          const f = files[path];
          const m = markOf(marks[path], Boolean(f && (isEdited(f) || f.base === null)), f?.deleted === true);
          const name = folder.name ? path.slice(folder.name.length + 1) : path;
          const Icon = marks[path]?.generated ? Lock : name.endsWith(".md") ? FileText : File;
          return (
            <li key={path}>
              <a
                href={`?file=${encodeURIComponent(path)}`}
                onClick={(e) => {
                  e.preventDefault();
                  onOpen(path);
                }}
                aria-current={path === current ? "page" : undefined}
                title={path}
                className={cn(
                  "flex min-h-7 items-center gap-2 rounded-md py-1 pr-2 text-[13px] hover:bg-muted",
                  folder.name ? "pl-7" : "pl-2",
                  path === current && "bg-muted font-semibold shadow-[inset_2px_0_0_var(--foreground)]",
                )}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {m ? <span className={cn("shrink-0 text-xs font-normal", m.className)}>{m.label}</span> : null}
              </a>
            </li>
          );
        });
        if (!folder.name) return <ul key="(root)">{rows}</ul>;
        const openByDefault = folder.files.some(interesting);
        return (
          <details key={folder.name} open={openByDefault} className="group">
            <summary className="flex min-h-7 cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-[13px] text-muted-foreground select-none hover:bg-muted [&::-webkit-details-marker]:hidden">
              <Folder className="size-4 group-open:hidden" aria-hidden />
              <FolderOpen className="hidden size-4 group-open:block" aria-hidden />
              <span className="flex-1">{folder.name}</span>
              <span className="text-xs tabular-nums">{folder.files.length}</span>
            </summary>
            <ul>{rows}</ul>
          </details>
        );
      })}
    </div>
  );
}

/** "New file", or with `rename` "Rename file" (the path starts as the file's own; the move happens on save). */
function NewFileDialog({ open, onOpenChange, existing, folder, onCreate, rename = false }: { open: boolean; onOpenChange: (o: boolean) => void; existing: string[]; folder: string; onCreate: (path: string) => void; rename?: boolean }) {
  const id = useId();
  const [path, setPath] = useState(folder);
  const [touched, setTouched] = useState(false);
  const problem = newFileProblem(path, existing);
  const create = (
    <Button
      type="submit"
      onClick={(e) => {
        e.preventDefault();
        if (problem) return;
        onCreate(path.trim());
        onOpenChange(false);
      }}
    >
      {rename ? <PenLine aria-hidden /> : <CirclePlus aria-hidden />}
      {rename ? "Rename" : "Add file"}
    </Button>
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (o) {
          setPath(folder);
          setTouched(false);
        }
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        <form className="grid gap-4" onSubmit={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>{rename ? "Rename file" : "New file"}</DialogTitle>
            <DialogDescription>
              {rename ? "The file moves to the new path when you save. A memory takes its name from its path, so renaming its file renames the memory." : "The file is added to the package when you save. The layout decides which folders become assets."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={id}>Path in the package</Label>
            <Input id={id} value={path} onChange={(e) => (setPath(e.target.value), setTouched(true))} className="font-mono" spellCheck={false} autoComplete="off" aria-invalid={touched && problem ? true : undefined} aria-describedby={`${id}-help`} />
            <p id={`${id}-help`} role={touched && problem ? "alert" : undefined} className={cn("text-xs", touched && problem ? "text-destructive-fg" : "text-muted-foreground")}>
              {touched && problem ? problem : "For example memory/incident-patterns/patterns/new-pattern.md."}
            </p>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            {problem ? <DisabledReason reason={problem}>{create}</DisabledReason> : create}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

