import { StatusWord } from "@/components/assets/badges";
import { StatusSwitch } from "@/components/assets/status-switch";
import type { AssetListRow } from "@/server/assets/browse";
import { assetActionRules } from "@/server/assets/edit-rules";
import type { Policy } from "@/server/policy";
import { setStatusInDraftAction } from "../actions";

/**
 * The status cell of asset tables: the Active switch for a user with
 * drafts.write where the edit rules allow it, else the status words.
 */
export function statusCellFor(opts: {
  alias: string;
  canDraft: boolean;
  policy: Pick<Policy, "assetTypes" | "plans">;
  nameOf: (assetType: string, assetId: string) => string | undefined;
  /** Status in the user's open drafts, by asset ID */
  draftStatus: ReadonlyMap<string, string>;
}) {
  return function StatusCell(row: AssetListRow) {
    const a = assetActionRules(opts.policy, row, opts.nameOf);
    if (opts.canDraft && !row.deleted && a.supportsStatus && a.rules.status && row.status) {
      return (
        <StatusSwitch
          active={(opts.draftStatus.get(row.assetId) ?? row.status) === "ACTIVE"}
          liveActive={row.status === "ACTIVE"}
          assetName={row.name}
          action={setStatusInDraftAction.bind(null, opts.alias, row.assetId)}
        />
      );
    }
    return row.status ? <StatusWord status={row.status} /> : <span className="text-xs text-muted-foreground">No status</span>;
  };
}
