import { Card } from "@/components/ui/card";
import { EmptyState } from "./empty-state";
import { PageHeader } from "./page-header";
import { PhaseBadge } from "./phase-badge";

/** The words of PhasePlaceholder: what the page will do, then that it isn't built yet. Pure. */
export function phasePlaceholderText(description: string): { title: string; body: string } {
  return { title: description, body: "This part of the app isn't built yet." };
}

/** The page for a nav item whose phase isn't built yet: what the page will do, and that it isn't built yet. */
export function PhasePlaceholder({ phase, title, description }: { phase: number; title: string; description: string }) {
  const text = phasePlaceholderText(description);
  return (
    <div className="space-y-4">
      <PageHeader title={title} badges={<PhaseBadge phase={phase} />} />
      <Card className="py-0">
        <EmptyState title={text.title}>{text.body}</EmptyState>
      </Card>
    </div>
  );
}
