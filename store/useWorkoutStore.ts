import { create } from 'zustand';
import { useNotificationStore } from './useNotificationStore';

export interface WorkoutExercise {
  id: string;
  name: string;
  sets: number;
  reps: string;
  targets: string;
  description: string;
  restSeconds?: number;
  videoLink?: string;
}

export interface WorkoutDay {
  id: string;
  name: string;
  title: string;
  focus: string;
  intensity: string;
  exercises: WorkoutExercise[];
}

export interface WorkoutStats {
  totalWorkouts: number;
  totalTime: number;
  currentStreak: number;
  lastCompletedDate: string | null;
}

interface WorkoutState {
  days: WorkoutDay[];
  activeDayId: string;
  completedSets: Record<string, boolean[]>;
  customReps: Record<string, string>;
  timerSeconds: number;
  isTimerActive: boolean;
  stats: WorkoutStats;
  setActiveDay: (dayId: string) => void;
  addDay: () => void;
  updateDay: (dayId: string, patch: Partial<WorkoutDay>) => void;
  deleteDay: (dayId: string) => void;
  duplicateDay: (dayId: string) => void;
  addExercise: (dayId: string) => void;
  updateExercise: (dayId: string, exerciseId: string, patch: Partial<WorkoutExercise>) => void;
  deleteExercise: (dayId: string, exerciseId: string) => void;
  moveExercise: (dayId: string, exerciseId: string, direction: -1 | 1) => void;
  toggleSet: (dayId: string, exerciseId: string, setIndex: number) => void;
  setCustomReps: (dayId: string, exerciseId: string, reps: string) => void;
  tickTimer: () => void;
  startTimer: () => void;
  pauseTimer: () => void;
  resetTimer: () => void;
  completeWorkout: () => void;
  resetToDefaults: () => void;
}

const STORAGE_KEY = 'atheletia_workout_state';

export const defaultWorkoutDays: WorkoutDay[] = [
  {
    id: 'monday',
    name: 'Monday',
    title: 'Upper Body Strength',
    focus: 'Chest, shoulders, triceps',
    intensity: 'Medium',
    exercises: [
      { id: 'pushups', name: 'Push-ups', sets: 3, reps: '10-15', targets: 'Chest, triceps, core', description: 'Keep your body straight and lower with control.', restSeconds: 60 },
      { id: 'pike-pushups', name: 'Pike Push-ups', sets: 3, reps: '8-12', targets: 'Shoulders', description: 'Hips high, head moves toward the floor between your hands.', restSeconds: 75 },
      { id: 'plank-taps', name: 'Plank Shoulder Taps', sets: 3, reps: '20', targets: 'Core stability', description: 'Minimize hip rotation while tapping each shoulder.', restSeconds: 45 },
    ],
  },
  {
    id: 'tuesday',
    name: 'Tuesday',
    title: 'Lower Body',
    focus: 'Quads, hamstrings, glutes',
    intensity: 'Medium',
    exercises: [
      { id: 'squats', name: 'Bodyweight Squats', sets: 4, reps: '12-20', targets: 'Quads, glutes', description: 'Sit hips back, knees track over toes, chest tall.', restSeconds: 60 },
      { id: 'lunges', name: 'Reverse Lunges', sets: 3, reps: '10 each leg', targets: 'Glutes, quads', description: 'Step back softly and drive through the front heel.', restSeconds: 60 },
      { id: 'calf-raises', name: 'Calf Raises', sets: 3, reps: '20', targets: 'Calves', description: 'Pause briefly at the top of each rep.', restSeconds: 45 },
    ],
  },
  {
    id: 'wednesday',
    name: 'Wednesday',
    title: 'Core and Mobility',
    focus: 'Abs, hips, spine',
    intensity: 'Low',
    exercises: [
      { id: 'dead-bug', name: 'Dead Bug', sets: 3, reps: '10 each side', targets: 'Deep core', description: 'Keep lower back gently pressed down.', restSeconds: 45 },
      { id: 'side-plank', name: 'Side Plank', sets: 3, reps: '30s each side', targets: 'Obliques', description: 'Stack shoulders and hips, keep a straight line.', restSeconds: 45 },
      { id: 'hip-flexor', name: 'Hip Flexor Stretch', sets: 2, reps: '45s each side', targets: 'Hips', description: 'Squeeze the back glute and breathe into the stretch.', restSeconds: 30 },
    ],
  },
  {
    id: 'thursday',
    name: 'Thursday',
    title: 'Pull and Posture',
    focus: 'Back, biceps, posture',
    intensity: 'Medium',
    exercises: [
      { id: 'rows', name: 'Backpack Rows', sets: 4, reps: '10-15', targets: 'Back, biceps', description: 'Pull elbows back and squeeze shoulder blades.', restSeconds: 75 },
      { id: 'superman', name: 'Superman Holds', sets: 3, reps: '30s', targets: 'Lower back', description: 'Lift gently; avoid cranking the neck.', restSeconds: 45 },
      { id: 'wall-angels', name: 'Wall Angels', sets: 3, reps: '12', targets: 'Posture', description: 'Keep ribs down while arms slide along the wall.', restSeconds: 45 },
    ],
  },
  {
    id: 'friday',
    name: 'Friday',
    title: 'Full Body Conditioning',
    focus: 'Strength endurance',
    intensity: 'High',
    exercises: [
      { id: 'burpees', name: 'Burpees', sets: 3, reps: '8-12', targets: 'Full body', description: 'Move smoothly; step back instead of jumping if needed.', restSeconds: 90 },
      { id: 'mountain-climbers', name: 'Mountain Climbers', sets: 3, reps: '30s', targets: 'Core, cardio', description: 'Keep shoulders over wrists and drive knees forward.', restSeconds: 60 },
      { id: 'squat-pulses', name: 'Squat Pulses', sets: 3, reps: '20', targets: 'Quads, glutes', description: 'Stay low and pulse with control.', restSeconds: 60 },
    ],
  },
  {
    id: 'saturday',
    name: 'Saturday',
    title: 'Skill and Stretch',
    focus: 'Technique, flexibility',
    intensity: 'Low',
    exercises: [
      { id: 'bear-crawl', name: 'Bear Crawl', sets: 3, reps: '30s', targets: 'Core, shoulders', description: 'Knees hover low, opposite hand and foot move together.', restSeconds: 60 },
      { id: 'hamstring', name: 'Hamstring Stretch', sets: 2, reps: '60s each side', targets: 'Hamstrings', description: 'Hinge from the hips and keep breathing.', restSeconds: 30 },
    ],
  },
  {
    id: 'sunday',
    name: 'Sunday',
    title: 'Recovery',
    focus: 'Walk, mobility, rest',
    intensity: 'Rest',
    exercises: [
      { id: 'walk', name: 'Easy Walk', sets: 1, reps: '20-30 min', targets: 'Recovery', description: 'Keep it conversational and relaxed.', restSeconds: 0 },
      { id: 'breathing', name: 'Box Breathing', sets: 3, reps: '1 min', targets: 'Nervous system', description: 'Inhale, hold, exhale, hold for equal counts.', restSeconds: 15 },
    ],
  },
];

const defaultStats: WorkoutStats = {
  totalWorkouts: 0,
  totalTime: 0,
  currentStreak: 0,
  lastCompletedDate: null,
};

const todayName = () => new Date().toLocaleDateString('en-US', { weekday: 'long' });
const uid = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

const hydrate = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  const activeDay = defaultWorkoutDays.find((day) => day.name === todayName())?.id || defaultWorkoutDays[0].id;
  return {
    days: defaultWorkoutDays,
    activeDayId: activeDay,
    completedSets: {},
    customReps: {},
    timerSeconds: 0,
    isTimerActive: false,
    stats: defaultStats,
  };
};

const save = (state: Partial<WorkoutState>) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      days: state.days,
      activeDayId: state.activeDayId,
      completedSets: state.completedSets,
      customReps: state.customReps,
      timerSeconds: state.timerSeconds,
      isTimerActive: state.isTimerActive,
      stats: state.stats,
    }));
  } catch {
    // ignore storage failures
  }
};

export const useWorkoutStore = create<WorkoutState>((set, get) => ({
  ...hydrate(),
  setActiveDay: (dayId) => set((state) => {
    const next = { ...state, activeDayId: dayId };
    save(next);
    return next;
  }),
  addDay: () => set((state) => {
    const day: WorkoutDay = { id: uid('day'), name: 'Custom', title: 'New Workout', focus: 'Custom focus', intensity: 'Medium', exercises: [] };
    const next = { ...state, days: [...state.days, day], activeDayId: day.id };
    save(next);
    return next;
  }),
  updateDay: (dayId, patch) => set((state) => {
    const next = { ...state, days: state.days.map((day) => day.id === dayId ? { ...day, ...patch } : day) };
    save(next);
    return next;
  }),
  deleteDay: (dayId) => set((state) => {
    const days = state.days.filter((day) => day.id !== dayId);
    const next = { ...state, days, activeDayId: days[0]?.id || '' };
    save(next);
    return next;
  }),
  duplicateDay: (dayId) => set((state) => {
    const original = state.days.find((day) => day.id === dayId);
    if (!original) return state;
    const copy = { ...original, id: uid('day'), name: `${original.name} Copy`, title: `${original.title} Copy`, exercises: original.exercises.map((ex) => ({ ...ex, id: uid('ex') })) };
    const next = { ...state, days: [...state.days, copy], activeDayId: copy.id };
    save(next);
    return next;
  }),
  addExercise: (dayId) => set((state) => {
    const exercise: WorkoutExercise = { id: uid('ex'), name: 'New Exercise', sets: 3, reps: '10', targets: 'Target muscles', description: 'Add form notes here.', restSeconds: 60 };
    const next = { ...state, days: state.days.map((day) => day.id === dayId ? { ...day, exercises: [...day.exercises, exercise] } : day) };
    save(next);
    return next;
  }),
  updateExercise: (dayId, exerciseId, patch) => set((state) => {
    const next = {
      ...state,
      days: state.days.map((day) => day.id === dayId ? {
        ...day,
        exercises: day.exercises.map((exercise) => exercise.id === exerciseId ? { ...exercise, ...patch } : exercise),
      } : day),
    };
    save(next);
    return next;
  }),
  deleteExercise: (dayId, exerciseId) => set((state) => {
    const next = { ...state, days: state.days.map((day) => day.id === dayId ? { ...day, exercises: day.exercises.filter((exercise) => exercise.id !== exerciseId) } : day) };
    save(next);
    return next;
  }),
  moveExercise: (dayId, exerciseId, direction) => set((state) => {
    const next = {
      ...state,
      days: state.days.map((day) => {
        if (day.id !== dayId) return day;
        const exercises = [...day.exercises];
        const index = exercises.findIndex((exercise) => exercise.id === exerciseId);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= exercises.length) return day;
        const [item] = exercises.splice(index, 1);
        exercises.splice(target, 0, item);
        return { ...day, exercises };
      }),
    };
    save(next);
    return next;
  }),
  toggleSet: (dayId, exerciseId, setIndex) => set((state) => {
    const key = `${dayId}:${exerciseId}`;
    const exercise = state.days.find((day) => day.id === dayId)?.exercises.find((ex) => ex.id === exerciseId);
    const current = state.completedSets[key] || Array(exercise?.sets || setIndex + 1).fill(false);
    const updated = [...current];
    updated[setIndex] = !updated[setIndex];
    const next = { ...state, completedSets: { ...state.completedSets, [key]: updated } };
    save(next);
    return next;
  }),
  setCustomReps: (dayId, exerciseId, reps) => set((state) => {
    const next = { ...state, customReps: { ...state.customReps, [`${dayId}:${exerciseId}`]: reps } };
    save(next);
    return next;
  }),
  tickTimer: () => set((state) => {
    if (!state.isTimerActive) return state;
    const next = { ...state, timerSeconds: state.timerSeconds + 1 };
    save(next);
    return next;
  }),
  startTimer: () => set((state) => {
    const next = { ...state, isTimerActive: true };
    save(next);
    return next;
  }),
  pauseTimer: () => set((state) => {
    const next = { ...state, isTimerActive: false };
    save(next);
    return next;
  }),
  resetTimer: () => set((state) => {
    const next = { ...state, isTimerActive: false, timerSeconds: 0 };
    save(next);
    return next;
  }),
  completeWorkout: () => set((state) => {
    const today = new Date();
    const last = state.stats.lastCompletedDate ? new Date(state.stats.lastCompletedDate) : null;
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const sameDay = last?.toDateString() === today.toDateString();
    const streak = sameDay
      ? state.stats.currentStreak
      : last?.toDateString() === yesterday.toDateString()
        ? state.stats.currentStreak + 1
        : 1;
    const next = {
      ...state,
      isTimerActive: false,
      stats: {
        totalWorkouts: sameDay ? state.stats.totalWorkouts : state.stats.totalWorkouts + 1,
        totalTime: state.stats.totalTime + state.timerSeconds,
        currentStreak: streak,
        lastCompletedDate: today.toISOString(),
      },
    };
    save(next);
    useNotificationStore.getState().pushNotification({
      type: 'success',
      title: 'Workout completed',
      message: `Nice. Current streak: ${next.stats.currentStreak} day${next.stats.currentStreak === 1 ? '' : 's'}.`,
      source: 'workout',
    });
    return next;
  }),
  resetToDefaults: () => set(() => {
    const next = {
      days: defaultWorkoutDays,
      activeDayId: defaultWorkoutDays.find((day) => day.name === todayName())?.id || defaultWorkoutDays[0].id,
      completedSets: {},
      customReps: {},
      timerSeconds: 0,
      isTimerActive: false,
      stats: defaultStats,
    };
    save(next);
    return next;
  }),
}));
