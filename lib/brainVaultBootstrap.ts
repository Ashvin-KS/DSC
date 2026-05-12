import { cacheFileContent, cacheFileTree, type CachedFileNode } from './notesCache';

export interface BrainVaultPreloadResult {
  warnings: string[];
}

/** No default vault path — users must configure it in Brain settings. */
export const DEFAULT_BRAIN_VAULT = '';

const BRAIN_VAULT_STORAGE_KEY = 'brain_vaultPath';
const BRAIN_SELECTED_FILE_STORAGE_KEY = 'brain_selectedFile';

export const normalizePathForCompare = (input: string): string =>
  input.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export const isPathWithin = (candidatePath: string, parentPath: string): boolean => {
  const candidate = normalizePathForCompare(candidatePath);
  const parent = normalizePathForCompare(parentPath);
  return candidate === parent || candidate.startsWith(`${parent}/`);
};

export const isMarkdownPath = (targetPath: string): boolean =>
  targetPath.toLowerCase().endsWith('.md');

export const filterMarkdownTree = (nodes: CachedFileNode[]): CachedFileNode[] =>
  nodes
    .map((node) => {
      if (!node.isDirectory) {
        return isMarkdownPath(node.path) ? node : null;
      }

      const children = filterMarkdownTree(node.children || []);
      if (children.length === 0 && (node.children || []).length > 0) return null;
      return { ...node, children };
    })
    .filter((node): node is CachedFileNode => Boolean(node));

export const getStoredBrainVaultPath = (): string =>
  localStorage.getItem(BRAIN_VAULT_STORAGE_KEY) || DEFAULT_BRAIN_VAULT;

const getErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
};

export const preloadBrainVaultCache = async (): Promise<BrainVaultPreloadResult> => {
  const warnings: string[] = [];
  if (typeof window === 'undefined' || !window.atheletiaAPI?.notes) return { warnings };

  const vaultPath = getStoredBrainVaultPath();
  if (!vaultPath) return { warnings };

  try {
    const tree = await window.atheletiaAPI.notes.getFileTree(vaultPath);
    cacheFileTree(vaultPath, filterMarkdownTree(tree as CachedFileNode[]));
  } catch (error) {
    warnings.push(`Brain vault preload skipped (tree): ${getErrorMessage(error, 'Unknown error')}`);
  }

  const selectedFile = localStorage.getItem(BRAIN_SELECTED_FILE_STORAGE_KEY);
  if (!selectedFile || !isMarkdownPath(selectedFile) || !isPathWithin(selectedFile, vaultPath)) {
    return;
  }

  try {
    const content = await window.atheletiaAPI.notes.readFile(selectedFile);
    if (content !== null) {
      cacheFileContent(selectedFile, content);
    }
  } catch (error) {
    warnings.push(`Brain vault preload skipped (file): ${getErrorMessage(error, 'Unknown error')}`);
  }

  return { warnings };
};
