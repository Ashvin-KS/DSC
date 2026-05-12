import { create } from 'zustand';

export interface McqQuestion {
  id: string;
  question: string;
  options: string[];
  answer: string;
  explanation: string;
  source?: string;
}

export interface McqSet {
  id: string;
  notePath: string;
  title: string;
  topic?: string;
  questions: McqQuestion[];
  createdAt: number;
}

interface McqState {
  sets: McqSet[];
  saveSet: (set: Omit<McqSet, 'id' | 'createdAt'> & { id?: string; createdAt?: number }) => McqSet;
  deleteSet: (id: string) => void;
  duplicateSet: (id: string) => void;
  getSetsForNote: (notePath: string | null | undefined) => McqSet[];
}

const STORAGE_KEY = 'atheletia_mcq_sets';

const loadSets = (): McqSet[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const persist = (sets: McqSet[]) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sets));
  } catch {
    // ignore storage failures
  }
};

export const parseMcqSetFromText = (text: string, notePath: string): Omit<McqSet, 'id' | 'createdAt'> | null => {
  const source = text || '';
  const jsonMatch = source.match(/<atheletia_mcq_json[^>]*>([\s\S]*?)<\/atheletia_mcq_json>/i)
    || source.match(/```(?:json\s+mcq|mcq-json|json)?\s*([\s\S]*?"questions"[\s\S]*?)```/i);
  if (jsonMatch?.[1]) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
      if (questions.length) {
        return {
          notePath,
          title: String(parsed.title || parsed.topic || 'MCQ Set'),
          topic: parsed.topic ? String(parsed.topic) : undefined,
          questions: questions.map((q: any, index: number) => ({
            id: String(q.id || `q_${index + 1}`),
            question: String(q.question || q.prompt || ''),
            options: Array.isArray(q.options) ? q.options.map(String) : [],
            answer: String(q.answer || q.correctAnswer || q.correct || ''),
            explanation: String(q.explanation || ''),
            source: q.source ? String(q.source) : undefined,
          })).filter((q: McqQuestion) => q.question && q.options.length > 0),
        };
      }
    } catch {
      // fall through to markdown parser
    }
  }

  const blocks = source.split(/\n(?=\d+\.\s+)/).filter((block) => /^\d+\.\s+/.test(block.trim()));
  const questions = blocks.map((block, index) => {
    const lines = block.trim().split(/\r?\n/);
    const question = (lines.shift() || '').replace(/^\d+\.\s*/, '').trim();
    const options = lines
      .filter((line) => /^[A-D]\)/i.test(line.trim()))
      .map((line) => line.trim());
    const answerLine = lines.find((line) => /\banswer\b/i.test(line));
    const explanationLine = lines.find((line) => /\bexplanation\b/i.test(line));
    return {
      id: `q_${index + 1}`,
      question,
      options,
      answer: answerLine?.replace(/^.*?answer\s*[:\-]\s*/i, '').trim() || '',
      explanation: explanationLine?.replace(/^.*?explanation\s*[:\-]\s*/i, '').trim() || '',
    };
  }).filter((q) => q.question && q.options.length >= 2);

  if (!questions.length) return null;
  return {
    notePath,
    title: 'Generated MCQs',
    questions,
  };
};

export const useMcqStore = create<McqState>((set, get) => ({
  sets: loadSets(),
  saveSet: (input) => {
    const mcqSet: McqSet = {
      ...input,
      id: input.id || `mcq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: input.createdAt || Date.now(),
    };
    set((state) => {
      const next = [mcqSet, ...state.sets.filter((set) => set.id !== mcqSet.id)];
      persist(next);
      return { sets: next };
    });
    return mcqSet;
  },
  deleteSet: (id) => set((state) => {
    const next = state.sets.filter((set) => set.id !== id);
    persist(next);
    return { sets: next };
  }),
  duplicateSet: (id) => {
    const original = get().sets.find((set) => set.id === id);
    if (!original) return;
    get().saveSet({
      ...original,
      id: undefined,
      createdAt: undefined,
      title: `${original.title} Copy`,
    });
  },
  getSetsForNote: (notePath) => {
    if (!notePath) return [];
    return get().sets.filter((set) => set.notePath === notePath);
  },
}));
