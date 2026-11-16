/**
 * Folder trees built from slash-separated names: memory names such as
 * "databases/rds-failover" and skill file paths such as "references/x.md".
 * Pure; unit-tested.
 */

export interface TreeNode<T> {
  /** Last path segment */
  name: string;
  /** Full slash-separated path from the root */
  path: string;
  /** Items whose path is exactly this node (normally zero or one) */
  items: T[];
  children: TreeNode<T>[];
}

interface BuildNode<T> extends TreeNode<T> {
  index: Map<string, BuildNode<T>>;
}

function newNode<T>(name: string, path: string): BuildNode<T> {
  return { name, path, items: [], children: [], index: new Map() };
}

/** Split a name into path segments, dropping empty segments ("a//b/" becomes ["a", "b"]). */
export function pathSegments(name: string): string[] {
  return name
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build a tree from items. A name can be both a folder and an item (a memory
 * "databases" next to "databases/rds-failover"); such a node has items and
 * children. Items with an empty name are placed at the root under `emptyName`.
 */
export function buildPathTree<T>(items: readonly T[], pathOf: (item: T) => string, emptyName = "(no name)"): TreeNode<T>[] {
  const root = newNode<T>("", "");
  for (const item of items) {
    const segs = pathSegments(pathOf(item));
    if (segs.length === 0) segs.push(emptyName);
    let node = root;
    segs.forEach((seg, i) => {
      let child = node.index.get(seg);
      if (!child) {
        child = newNode<T>(seg, segs.slice(0, i + 1).join("/"));
        node.index.set(seg, child);
        node.children.push(child);
      }
      node = child;
    });
    node.items.push(item);
  }
  return finish(root).children;
}

/** Folders (nodes with children) first, then by name; strips the build index. */
function finish<T>(node: BuildNode<T>): TreeNode<T> {
  const children = [...node.index.values()]
    .map((c) => finish(c))
    .sort((a, b) => {
      const af = a.children.length > 0 ? 0 : 1;
      const bf = b.children.length > 0 ? 0 : 1;
      return af - bf || a.name.localeCompare(b.name);
    });
  return { name: node.name, path: node.path, items: node.items, children };
}

/** Number of items in a subtree. */
export function countItems<T>(nodes: readonly TreeNode<T>[]): number {
  return nodes.reduce((n, c) => n + c.items.length + countItems(c.children), 0);
}
