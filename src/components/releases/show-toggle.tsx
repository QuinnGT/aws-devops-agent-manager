"use client";

import { usePathname, useRouter } from "next/navigation";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/**
 * "Changed <n>" or "All <n>" for the manifest table, kept in `?show=` so links
 * and Back keep the view (pages/releases.md, "Manifest and changes since").
 */
export function ShowToggle({ value, changed, all }: { value: "changed" | "all"; changed: number; all: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const go = (next: string) => {
    if (next !== "changed" && next !== "all") return;
    router.replace(next === "all" ? `${pathname}?show=all` : pathname, { scroll: false });
  };
  return (
    <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={value} onValueChange={go} aria-label="Assets to show">
      <ToggleGroupItem value="changed" className="tabular-nums data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
        Changed {changed}
      </ToggleGroupItem>
      <ToggleGroupItem value="all" className="tabular-nums data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
        All {all}
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
