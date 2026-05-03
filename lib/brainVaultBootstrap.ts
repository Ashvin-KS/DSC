import { cacheFileContent, cacheFileTree, type CachedFileNode } from './notesCache';

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

export const preloadBrainVaultCache = async (): Promise<void> => {
  if (typeof window === 'undefined' || !window.atheletiaAPI?.notes) return;

  const vaultPath = getStoredBrainVaultPath();
  if (!vaultPath) return;

  try {
    const tree = await window.atheletiaAPI.notes.getFileTree(vaultPath);
    cacheFileTree(vaultPath, filterMarkdownTree(tree as CachedFileNode[]));
  } catch (error) {
    console.debug('Brain vault preload skipped (tree):', error);
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
    console.debug('Brain vault preload skipped (file):', error);
  }
};
