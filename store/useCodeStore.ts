import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useLeetCodeActivityStore } from './useLeetCodeActivityStore';

export interface Problem {
    id: string;
    title: string;
    difficulty: 'Easy' | 'Medium' | 'Hard';
    url: string;
    isSolved: boolean;
    notes?: string;
    lastPracticed?: string;
    category?: string;
    technique?: string;
    solvedDate?: string; // Track when it was solved
}

interface CodeState {
    problems: Problem[];
    activeProblemId: string | null;
    selectedCategory: string | null;

    // Actions
    setProblems: (problems: Problem[]) => void;
    addProblem: (problem: Omit<Problem, 'id' | 'isSolved'>) => void;
    removeProblem: (id: string) => void;
    toggleSolved: (id: string) => void;
    updateNotes: (id: string, notes: string) => void;
    setActiveProblem: (id: string | null) => void;
    setSelectedCategory: (category: string | null) => void;
    importFromCsv: (csvContent: string) => void;
}

const DEFAULT_PROBLEMS: Problem[] = [
    { id: '1', title: 'Two Sum', difficulty: 'Easy', url: 'https://leetcode.com/problems/two-sum', isSolved: false, category: 'Array & Hashing', technique: 'Hash Map' },
    { id: '2', title: 'LRU Cache', difficulty: 'Medium', url: 'https://leetcode.com/problems/lru-cache', isSolved: false, category: 'Linked List', technique: 'Hash Map & DLL' },
];

function parseCsvLine(line: string): string[] {
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const next = line[i + 1];
        if (char === '"' && inQuotes && next === '"') {
            current += '"';
            i++;
        } else if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            cells.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    cells.push(current.trim());
    return cells;
}

export const useCodeStore = create<CodeState>()(
    persist(
        (set) => ({
            problems: DEFAULT_PROBLEMS,
            activeProblemId: null,
            selectedCategory: null,

            setProblems: (problems) => set({ problems }),

            addProblem: (problem) => set((state) => ({
                problems: [
                    ...state.problems,
                    {
                        ...problem,
                        id: crypto.randomUUID(),
                        isSolved: false
                    }
                ]
            })),

            removeProblem: (id) => set((state) => ({
                problems: state.problems.filter((p) => p.id !== id)
            })),

            toggleSolved: (id) => {
                const state = useCodeStore.getState();
                const problem = state.problems.find(p => p.id === id);
                if (!problem) return;

                const willBeSolved = !problem.isSolved;
                const today = new Date().toISOString().split('T')[0];

                // Update activity tracker for heatmap
                const activityStore = useLeetCodeActivityStore.getState();
                if (willBeSolved) {
                    activityStore.recordSolve(id);
                } else {
                    activityStore.unrecordSolve(id);
                }

                set({
                    problems: state.problems.map((p) =>
                        p.id === id ? {
                            ...p,
                            isSolved: willBeSolved,
                            solvedDate: willBeSolved ? today : undefined
                        } : p
                    )
                });
            },

            updateNotes: (id, notes) => set((state) => ({
                problems: state.problems.map((p) =>
                    p.id === id ? { ...p, notes } : p
                )
            })),

            setActiveProblem: (id) => set({ activeProblemId: id }),

            setSelectedCategory: (category) => set({ selectedCategory: category }),

            importFromCsv: (csvContent) => {
                const lines = csvContent.replace(/^\uFEFF/, '').split(/\r?\n/);
                const problems: Problem[] = [];
                const existingById = new Map(useCodeStore.getState().problems.map((p) => [p.id, p]));
                const existingByTitle = new Map(useCodeStore.getState().problems.map((p) => [p.title.toLowerCase(), p]));

                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;

                    const parts = parseCsvLine(line);
                    if (parts.length < 4) continue;

                    const category = parts[0];
                    const problemNo = parts[1];
                    const link = parts[2].trim();
                    const name = parts[3];
                    const technique = parts[4];
                    const isSolved = parts[5]?.toLowerCase() === 'true' || parts[5]?.toLowerCase() === 'yes';
                    const id = `csv-${problemNo || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
                    const existing = existingById.get(id) || existingByTitle.get(name.toLowerCase());

                    problems.push({
                        ...(existing ?? {}),
                        id,
                        title: name,
                        url: link,
                        difficulty: existing?.difficulty || 'Medium',
                        isSolved: existing?.isSolved ?? isSolved,
                        category,
                        technique,
                        notes: existing?.notes,
                        lastPracticed: existing?.lastPracticed,
                        solvedDate: existing?.solvedDate,
                    });
                }

                if (problems.length > 0) {
                    set({ problems });
                }
            },
        }),
        {
            name: 'atheletia-code-store',
            partialize: (state) => ({
                problems: state.problems,
                activeProblemId: state.activeProblemId,
                selectedCategory: state.selectedCategory,
            }),
        }
    )
);
