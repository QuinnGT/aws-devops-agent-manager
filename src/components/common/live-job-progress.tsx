"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { JobProgress } from "@/components/job-progress";

/** JobProgress that refreshes the page when the job finishes. */
export function LiveJobProgress({ runId }: { runId: string }) {
  const router = useRouter();
  const onDone = useCallback(() => router.refresh(), [router]);
  return <JobProgress runId={runId} onDone={onDone} />;
}
