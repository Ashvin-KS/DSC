export interface CachedFileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: CachedFileNode[];
}

type TreeCacheEntry = {
  tree: CachedFileNode[];
  signature: string;
  ts: number;
};

type FileCacheEntry = {
  content: string;
  ts: number;
};

const treeCache = new Map<string, TreeCacheEntry>();
const fileCache = new Map<string, FileCacheEntry>();

const DEFAULT_TREE_TTL_MS = Number.POSITIVE_INFINITY;
const DEFAULT_FILE_TTL_MS = 15_000;

export const buildFileTreeSignature = (nodes: CachedFileNode[]): string => {
  const parts: string[] = [];

  const visit = (items: CachedFileNode[]) => {
    for (const node of items) {
      parts.push(node.isDirectory ? `d:${node.path}` : `f:${node.path}`);
      if (node.children?.length) {
        visit(node.children);
      }
    }
  };

  visit(nodes);
  return parts.join('|');
};

export const getCachedFileTree = (
  vaultPath: string,
  maxAgeMs = DEFAULT_TREE_TTL_MS,
): TreeCacheEntry | null => {
  const cached = treeCache.get(vaultPath);
  if (!cached) return null;
  if (Number.isFinite(maxAgeMs) && Date.now() - cached.ts > maxAgeMs) return null;
  return cached;
};

export const cacheFileTree = (vaultPath: string, tree: CachedFileNode[]): TreeCacheEntry => {
  const entry = {
    tree,
    signature: buildFileTreeSignature(tree),
    ts: Date.now(),
  };
  treeCache.set(vaultPath, entry);
  return entry;
};

export const invalidateFileTreeCache = (vaultPath?: string) => {
  if (vaultPath) {
    treeCache.delete(vaultPath);
    return;
  }
  treeCache.clear();
};

export const getCachedFileContent = (
  filePath: string,
  maxAgeMs = DEFAULT_FILE_TTL_MS,
): string | null => {
  const cached = fileCache.get(filePath);
  if (!cached) return null;
  if (Date.now() - cached.ts > maxAgeMs) return null;
  return cached.content;
};

export const cacheFileContent = (filePath: string, content: string) => {
  fileCache.set(filePath, { content, ts: Date.now() });
};

export const invalidateFileContentCache = (filePath?: string) => {
  if (filePath) {
    fileCache.delete(filePath);
    return;
  }
  fileCache.clear();
};
