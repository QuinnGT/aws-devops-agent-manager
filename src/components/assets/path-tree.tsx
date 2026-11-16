import type { ReactNode } from "react";
import type { TreeNode } from "@/server/assets/tree";

/**
 * A folder tree (memory names, skill files). Server component; `renderItem`
 * draws each item at its node. Folders render as open <details>.
 */
export function PathTree<T>({ nodes, renderItem, depth = 0 }: { nodes: TreeNode<T>[]; renderItem: (item: T, node: TreeNode<T>) => ReactNode; depth?: number }) {
  if (nodes.length === 0) return null;
  return (
    <ul className={depth === 0 ? "space-y-0.5 text-sm" : "ml-4 border-l pl-3 space-y-0.5"}>
      {nodes.map((n) => (
        <li key={n.path}>
          {n.children.length > 0 ? (
            <details open>
              <summary className="cursor-pointer select-none">
                <span className="font-medium">{n.name}/</span>
                {n.items.length > 0 ? <span className="ml-2">{n.items.map((it, i) => <span key={i}>{renderItem(it, n)}</span>)}</span> : null}
              </summary>
              <PathTree nodes={n.children} renderItem={renderItem} depth={depth + 1} />
            </details>
          ) : (
            n.items.map((it, i) => <div key={i}>{renderItem(it, n)}</div>)
          )}
        </li>
      ))}
    </ul>
  );
}
