import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  Copy,
  Dumbbell,
  ExternalLink,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  TimerReset,
  Trash2,
} from 'lucide-react';
import { useWorkoutStore, WorkoutExercise } from '../store/useWorkoutStore';
import { useIntentStore } from '../store/useIntentStore';
import { getProviderKey, resolveProviderForModel } from '../lib/modelFetch';

const formatDuration = (seconds: number) => {
  const safe = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const getSetKey = (dayId: string, exerciseId: string) => `${dayId}:${exerciseId}`;

const safeNumber = (value: string | number, fallback: number) => {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.floor(next) : fallback;
};

const extractJsonObject = (text: string) => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = fenced || text;
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(raw.slice(first, last + 1));
  } catch {
    return null;
  }
};

const fallbackAiPlan = (prompt: string): { summary: string; exercises: WorkoutExercise[] } => ({
  summary: `Drafted a simple editable plan for: ${prompt || 'general strength and mobility'}.`,
  exercises: [
    {
      id: `ai_${Date.now()}_warmup`,
      name: 'Dynamic Warm-up',
      sets: 2,
      reps: '60s',
      targets: 'Joints, light cardio',
      description: 'Move through arm circles, hip hinges, leg swings, and easy marching.',
      restSeconds: 20,
    },
    {
      id: `ai_${Date.now()}_main`,
      name: 'Controlled Squats',
      sets: 3,
      reps: '10-15',
      targets: 'Quads, glutes, core',
      description: 'Sit hips back, keep chest tall, and pause briefly at the bottom.',
      restSeconds: 60,
    },
    {
      id: `ai_${Date.now()}_finish`,
      name: 'Forearm Plank',
      sets: 3,
      reps: '30-45s',
      targets: 'Core stability',
      description: 'Keep ribs down and squeeze glutes so the lower back stays neutral.',
      restSeconds: 45,
    },
  ],
});

export const WorkoutView: React.FC = () => {
  const {
    days,
    activeDayId,
    completedSets,
    customReps,
    timerSeconds,
    isTimerActive,
    stats,
    setActiveDay,
    addDay,
    updateDay,
    deleteDay,
    duplicateDay,
    addExercise,
    updateExercise,
    deleteExercise,
    moveExercise,
    toggleSet,
    setCustomReps,
    tickTimer,
    startTimer,
    pauseTimer,
    resetTimer,
    completeWorkout,
    resetToDefaults,
  } = useWorkoutStore();
  const settings = useIntentStore((s) => s.settings);
  const [aiPrompt, setAiPrompt] = useState('Make this day better for my current energy and goals.');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState<{ summary: string; exercises: WorkoutExercise[]; mode: 'append' | 'replace' } | null>(null);
  const [aiMode, setAiMode] = useState<'append' | 'replace'>('append');
  const [tutorialBusyId, setTutorialBusyId] = useState<string | null>(null);

  const activeDay = days.find((day) => day.id === activeDayId) || days[0];

  useEffect(() => {
    if (!isTimerActive) return;
    const id = window.setInterval(() => tickTimer(), 1000);
    return () => window.clearInterval(id);
  }, [isTimerActive, tickTimer]);

  const progress = useMemo(() => {
    if (!activeDay) return { done: 0, total: 0, percent: 0 };
    const total = activeDay.exercises.reduce((sum, exercise) => sum + Math.max(1, exercise.sets), 0);
    const done = activeDay.exercises.reduce((sum, exercise) => {
      const key = getSetKey(activeDay.id, exercise.id);
      return sum + (completedSets[key] || []).filter(Boolean).length;
    }, 0);
    return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
  }, [activeDay, completedSets]);

  if (!activeDay) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: 'var(--bg-app)', color: 'var(--text-main)' }}>
        <button onClick={resetToDefaults} className="rounded-md px-4 py-2 text-sm transition-colors hover:opacity-80" style={{ background: 'var(--bg-elev-2)', color: 'var(--text-strong)' }}>
          Restore default workout plan
        </button>
      </div>
    );
  }

  const handleAiGenerate = async () => {
    setAiBusy(true);
    setAiResult(null);
    
    const currentDayCompletion = activeDay.exercises.map((ex) => {
      const key = getSetKey(activeDay.id, ex.id);
      const setsCompleted = (completedSets[key] || []).filter(Boolean).length;
      return {
        name: ex.name,
        setsCompleted,
        setsTotal: ex.sets,
        completionPercent: Math.round((setsCompleted / Math.max(1, ex.sets)) * 100),
      };
    });
    
    const allDaysContext = days.map((day) => ({
      name: day.name,
      title: day.title,
      focus: day.focus,
      intensity: day.intensity,
      exercises: day.exercises.map((ex) => ({
        name: ex.name,
        sets: ex.sets,
        reps: ex.reps,
        targets: ex.targets,
      })),
    }));
    
    const currentPlan = JSON.stringify(
      {
        ...activeDay,
        completionStatus: currentDayCompletion,
        overallProgress: progress,
      },
      null,
      2
    );
    const allDaysJson = JSON.stringify(allDaysContext, null, 2);
    
    try {
      const defaultModel = (settings as any)?.defaultModel || 'meta/llama-3.3-70b-instruct';
      const defaultProvider = (settings as any)?.defaultProvider || resolveProviderForModel(defaultModel, 'nvidia');
      const model = defaultModel;
      const provider = resolveProviderForModel(model, defaultProvider, 'nvidia');
      
      const getApiKeyForProvider = (settings: any, provider: string) => {
        const key = getProviderKey(settings, provider);
        if (key) return key;
        const fallbacks = ['openai', 'nvidia', 'anthropic', 'groq', 'gemini'];
        for (const p of fallbacks) {
          const k = getProviderKey(settings, p);
          if (k) return k;
        }
        return '';
      };
      
      const apiKey = getApiKeyForProvider(settings, provider);
      
      const modeInstruction = aiMode === 'replace'
        ? `REPLACE MODE: Replace exercises based on completion status. 
- If user has NOT started (0% complete): Full replacement is fine.
- If user is PARTIALLY done: Keep completed exercises, replace only the remaining incomplete ones.
- If user is MOSTLY done (>75%): Only suggest minor adjustments or additions, don't remove completed work.
- Use the completionStatus to know which exercises are done. Respect their effort.`
        : `APPEND MODE: Add new exercises to complement the current day. Consider what's already done and suggest exercises that fill gaps or progress the workout naturally.`;
      
      let parsed: any = null;
      if (window.atheletiaAPI?.settings?.chatCompletion && (apiKey || provider === 'local')) {
        const response = await window.atheletiaAPI.settings.chatCompletion(
          model,
          [
            {
              role: 'system',
              content: `You are a practical workout programming assistant. Return JSON only with summary and exercises. Exercises must have name, sets, reps, targets, description, restSeconds. Keep it safe, editable, and concise.\n\n${modeInstruction}\n\nYou have access to the FULL weekly plan context. Use it to avoid conflicts (e.g., don't schedule heavy legs the day after a leg day) and suggest complementary work.`,
            },
            {
              role: 'user',
              content: `User request: ${aiPrompt}\n\nCurrent day with completion status:\n${currentPlan}\n\nFULL WEEKLY PLAN CONTEXT (all days for scheduling awareness):\n${allDaysJson}`,
            },
          ],
          900,
          0.45,
          apiKey,
          provider,
        );
        const text = typeof response === 'string'
          ? response
          : response?.choices?.[0]?.message?.content || response?.content || '';
        parsed = extractJsonObject(text);
      }
      if (!parsed) parsed = fallbackAiPlan(aiPrompt);
      const exercises = Array.isArray(parsed.exercises)
        ? parsed.exercises.map((exercise: any, index: number) => ({
          id: `ai_${Date.now()}_${index}`,
          name: String(exercise.name || 'AI Exercise'),
          sets: safeNumber(exercise.sets, 3),
          reps: String(exercise.reps || '10'),
          targets: String(exercise.targets || 'General fitness'),
          description: String(exercise.description || 'Keep the movement controlled and stop if pain appears.'),
          restSeconds: safeNumber(exercise.restSeconds ?? exercise.rest, 60),
          videoLink: typeof exercise.videoLink === 'string' ? exercise.videoLink : undefined,
        }))
        : fallbackAiPlan(aiPrompt).exercises;
      setAiResult({
        summary: String(parsed.summary || parsed.title || 'AI workout draft ready.'),
        exercises,
        mode: aiMode,
      });
    } catch (error) {
      console.warn('Workout AI generation failed, using fallback.', error);
      setAiResult({ ...fallbackAiPlan(aiPrompt), mode: aiMode });
    } finally {
      setAiBusy(false);
    }
  };

  const applyAiExercises = () => {
    if (!aiResult) return;
    
    if (aiResult.mode === 'replace') {
      const exercisesToKeep = new Set<string>();
      for (const exercise of activeDay.exercises) {
        const key = getSetKey(activeDay.id, exercise.id);
        const setsCompleted = (completedSets[key] || []).filter(Boolean).length;
        const completionPercent = (setsCompleted / Math.max(1, exercise.sets)) * 100;
        if (completionPercent >= 50) {
          exercisesToKeep.add(exercise.id);
        }
      }
      
      for (const exercise of activeDay.exercises) {
        if (!exercisesToKeep.has(exercise.id)) {
          deleteExercise(activeDay.id, exercise.id);
        }
      }
    }
    
    for (const exercise of aiResult.exercises) {
      addExercise(activeDay.id);
      const created = useWorkoutStore.getState().days.find((day) => day.id === activeDay.id)?.exercises.at(-1);
      if (created) {
        updateExercise(activeDay.id, created.id, exercise);
      }
    }
    setAiResult(null);
  };

  const findTutorial = async (exercise: WorkoutExercise) => {
    setTutorialBusyId(exercise.id);
    try {
      const query = `UK YouTube ${exercise.name} exercise tutorial proper form`;
      const results = await window.atheletiaAPI?.music?.search?.(query);
      const first = Array.isArray(results) ? results[0] : null;
      if (first?.id) {
        const url = String(first.id).startsWith('http') ? first.id : `https://www.youtube.com/watch?v=${first.id}`;
        updateExercise(activeDay.id, exercise.id, { videoLink: url });
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    } catch (error) {
      console.warn('Tutorial lookup failed.', error);
    } finally {
      setTutorialBusyId(null);
    }
  };

  return (
    <div className="h-full overflow-hidden" style={{ background: 'var(--bg-app)', color: 'var(--text-main)' }}>
      <div className="h-full grid grid-cols-[260px_minmax(0,1fr)_320px]">
        <aside className="border-r p-4 overflow-y-auto custom-scrollbar" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-1)' }}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Dumbbell size={18} style={{ color: 'var(--success)' }} />
              <h1 className="text-sm font-bold uppercase tracking-wider" style={{ color: 'var(--text-strong)' }}>Workout</h1>
            </div>
            <button 
              onClick={addDay} 
              className="rounded-md p-1.5 transition-all duration-200 hover:bg-white/10 active:scale-95" 
              style={{ color: 'var(--success)', background: 'color-mix(in srgb, var(--success) 15%, transparent)' }} 
              title="Add day"
            >
              <Plus size={16} />
            </button>
          </div>

          <div className="space-y-1.5">
            {days.map((day) => {
              const isActive = activeDay.id === day.id;
              return (
                <button
                  key={day.id}
                  onClick={() => setActiveDay(day.id)}
                  className="w-full rounded-md border px-3 py-2 text-left transition-all hover:bg-white/5"
                  style={{
                    borderColor: isActive ? 'var(--success)' : 'var(--border-soft)',
                    background: isActive ? 'color-mix(in srgb, var(--success) 15%, transparent)' : 'var(--bg-elev-2)',
                    color: isActive ? 'var(--text-strong)' : 'var(--text-muted)',
                  }}
                >
                  <div className="truncate text-sm font-semibold">{day.name}</div>
                  <div className="truncate text-[11px]" style={{ color: 'var(--text-faint)' }}>{day.title}</div>
                </button>
              );
            })}
          </div>

          <div className="mt-5 space-y-2 rounded-lg border p-3" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-2)' }}>
            <div className="flex items-center justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
              <span>Today progress</span>
              <span>{progress.done}/{progress.total}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full" style={{ background: 'var(--bg-elev-3)' }}>
              <div className="h-full rounded-full transition-all" style={{ width: `${progress.percent}%`, background: 'var(--success)' }} />
            </div>
            <div className="text-2xl font-bold" style={{ color: 'var(--text-strong)' }}>{progress.percent}%</div>
          </div>
        </aside>

        <main className="flex-1 overflow-y-auto custom-scrollbar p-6">
          <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-[260px] flex-1">
              <input
                value={activeDay.title}
                onChange={(event) => updateDay(activeDay.id, { title: event.target.value })}
                className="w-full bg-transparent text-3xl font-bold tracking-tight outline-none"
                style={{ color: 'var(--text-strong)' }}
              />
              <div className="mt-3 grid grid-cols-3 gap-2">
                <input value={activeDay.name} onChange={(event) => updateDay(activeDay.id, { name: event.target.value })} className="rounded-md border px-3 py-2 text-sm outline-none" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-2)', color: 'var(--text-main)' }} />
                <input value={activeDay.focus} onChange={(event) => updateDay(activeDay.id, { focus: event.target.value })} className="rounded-md border px-3 py-2 text-sm outline-none" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-2)', color: 'var(--text-main)' }} />
                <select value={activeDay.intensity} onChange={(event) => updateDay(activeDay.id, { intensity: event.target.value })} className="rounded-md border px-3 py-2 text-sm outline-none" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-1)', color: 'var(--text-main)' }}>
                  {['Rest', 'Low', 'Medium', 'High'].map((level) => <option key={level} value={level}>{level}</option>)}
                </select>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => duplicateDay(activeDay.id)} className="rounded-md border p-2" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-2)', color: 'var(--text-soft)' }} title="Duplicate day">
                <Copy size={16} />
              </button>
              <button 
                onClick={() => deleteDay(activeDay.id)} 
                className="rounded-md border p-2 transition-all hover:opacity-80 active:scale-95" 
                style={{ borderColor: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 15%, transparent)', color: 'var(--danger)' }} 
                title="Delete day"
              >
                <Trash2 size={16} />
              </button>
            </div>
          </div>

          <div className="mb-5 grid grid-cols-4 gap-3">
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-2)' }}>
              <div className="text-[11px] uppercase" style={{ color: 'var(--text-faint)' }}>Timer</div>
              <div className="mt-1 text-xl font-mono" style={{ color: 'var(--text-strong)' }}>{formatDuration(timerSeconds)}</div>
            </div>
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-2)' }}>
              <div className="text-[11px] uppercase" style={{ color: 'var(--text-faint)' }}>Sessions</div>
              <div className="mt-1 text-xl font-bold" style={{ color: 'var(--text-strong)' }}>{stats.totalWorkouts}</div>
            </div>
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-2)' }}>
              <div className="text-[11px] uppercase" style={{ color: 'var(--text-faint)' }}>Streak</div>
              <div className="mt-1 text-xl font-bold" style={{ color: 'var(--text-strong)' }}>{stats.currentStreak}d</div>
            </div>
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-2)' }}>
              <div className="text-[11px] uppercase" style={{ color: 'var(--text-faint)' }}>Total Time</div>
              <div className="mt-1 text-xl font-mono" style={{ color: 'var(--text-strong)' }}>{formatDuration(stats.totalTime)}</div>
            </div>
          </div>

          <div className="mb-5 flex flex-wrap items-center gap-2">
            <button onClick={isTimerActive ? pauseTimer : startTimer} className="rounded-md px-4 py-2 text-sm font-bold" style={{ background: 'var(--success)', color: 'var(--accent-contrast)' }}>
              {isTimerActive ? 'Pause Timer' : 'Start Timer'}
            </button>
            <button onClick={resetTimer} className="flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-2)', color: 'var(--text-soft)' }}>
              <TimerReset size={15} /> Reset
            </button>
            <button onClick={completeWorkout} className="flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm" style={{ borderColor: 'var(--success)', background: 'color-mix(in srgb, var(--success) 12%, transparent)', color: 'var(--success)' }}>
              <Check size={15} /> Complete Workout
            </button>
            <button onClick={resetToDefaults} className="ml-auto flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm" style={{ borderColor: 'var(--border-soft)', background: 'color-mix(in srgb, var(--bg-elev-1) 3%, transparent)', color: 'var(--text-muted)' }}>
              <RotateCcw size={15} /> Defaults
            </button>
          </div>

          <div className="space-y-3">
            {activeDay.exercises.map((exercise, index) => {
              const key = getSetKey(activeDay.id, exercise.id);
              const setState = completedSets[key] || Array(exercise.sets).fill(false);
              return (
                <section key={exercise.id} className="rounded-lg border p-4" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-1)' }}>
                  <div className="mb-3 flex items-center gap-2">
                    <input
                      value={exercise.name}
                      onChange={(event) => updateExercise(activeDay.id, exercise.id, { name: event.target.value })}
                      className="min-w-0 flex-1 bg-transparent text-lg font-semibold outline-none"
                      style={{ color: 'var(--text-strong)' }}
                    />
                    <button onClick={() => moveExercise(activeDay.id, exercise.id, -1)} disabled={index === 0} className="rounded-md p-1.5 disabled:opacity-30" style={{ color: 'var(--text-muted)' }} title="Move up">
                      <ArrowUp size={15} />
                    </button>
                    <button onClick={() => moveExercise(activeDay.id, exercise.id, 1)} disabled={index === activeDay.exercises.length - 1} className="rounded-md p-1.5 disabled:opacity-30" style={{ color: 'var(--text-muted)' }} title="Move down">
                      <ArrowDown size={15} />
                    </button>
                    <button onClick={() => deleteExercise(activeDay.id, exercise.id)} className="rounded-md p-1.5" style={{ color: 'var(--danger)' }} title="Delete exercise">
                      <Trash2 size={15} />
                    </button>
                  </div>

                  <div className="grid grid-cols-[90px_120px_1fr_120px] gap-2">
                    <input type="number" min="1" value={exercise.sets} onChange={(event) => updateExercise(activeDay.id, exercise.id, { sets: safeNumber(event.target.value, exercise.sets) })} className="rounded-md border px-2 py-2 text-sm outline-none" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-2)', color: 'var(--text-main)' }} />
                    <input value={customReps[key] ?? exercise.reps} onChange={(event) => { setCustomReps(activeDay.id, exercise.id, event.target.value); updateExercise(activeDay.id, exercise.id, { reps: event.target.value }); }} className="rounded-md border px-2 py-2 text-sm outline-none" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-2)', color: 'var(--text-main)' }} />
                    <input value={exercise.targets} onChange={(event) => updateExercise(activeDay.id, exercise.id, { targets: event.target.value })} className="rounded-md border px-2 py-2 text-sm outline-none" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-2)', color: 'var(--text-main)' }} />
                    <input type="number" min="0" value={exercise.restSeconds || 0} onChange={(event) => updateExercise(activeDay.id, exercise.id, { restSeconds: safeNumber(event.target.value, 0) })} className="rounded-md border px-2 py-2 text-sm outline-none" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-2)', color: 'var(--text-main)' }} />
                  </div>
                  <div className="mt-1 grid grid-cols-[90px_120px_1fr_120px] gap-2 text-[10px] uppercase" style={{ color: 'var(--text-faint)' }}>
                    <span>Sets</span>
                    <span>Reps</span>
                    <span>Targets</span>
                    <span>Rest sec</span>
                  </div>

                  <textarea
                    value={exercise.description}
                    onChange={(event) => updateExercise(activeDay.id, exercise.id, { description: event.target.value })}
                    className="mt-3 min-h-16 w-full resize-y rounded-md border px-3 py-2 text-sm outline-none"
                    style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-2)', color: 'var(--text-soft)' }}
                  />

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap gap-1.5">
                      {Array.from({ length: Math.max(1, exercise.sets) }).map((_, setIndex) => (
                        <button
                          key={setIndex}
                          onClick={() => toggleSet(activeDay.id, exercise.id, setIndex)}
                          className={`h-8 min-w-8 rounded-md border text-xs font-bold transition-all hover:opacity-100 hover:border-white/20 ${
                            setState[setIndex] ? 'opacity-100' : 'opacity-35'
                          }`}
                          style={{
                            borderColor: setState[setIndex] ? 'var(--success)' : 'var(--border-soft)',
                            background: setState[setIndex] ? 'var(--success)' : 'var(--bg-elev-2)',
                            color: setState[setIndex] ? 'var(--accent-contrast)' : 'var(--text-faint)',
                          }}
                        >
                          {setIndex + 1}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      {exercise.videoLink && (
                        <button 
                          onClick={() => window.open(exercise.videoLink, '_blank', 'noopener,noreferrer')} 
                          className="flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-all hover:opacity-80 active:scale-95" 
                          style={{ borderColor: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 15%, transparent)', color: 'var(--accent)' }}
                        >
                          <ExternalLink size={13} /> Tutorial
                        </button>
                      )}
                      <button 
                        onClick={() => findTutorial(exercise)} 
                        disabled={tutorialBusyId === exercise.id} 
                        className="flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs disabled:opacity-50 transition-all opacity-70 hover:opacity-100 hover:bg-white/5" 
                        style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-2)', color: 'var(--text-soft)' }}
                      >
                        <Search size={13} /> {tutorialBusyId === exercise.id ? 'Searching' : 'UK YouTube'}
                      </button>
                    </div>
                  </div>
                </section>
              );
            })}
          </div>

          <button 
            onClick={() => addExercise(activeDay.id)} 
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed py-3 text-sm transition-all border-white/10 hover:border-accent/40 text-gray-400 hover:text-white bg-white/[0.02] hover:bg-white/[0.04] opacity-80 hover:opacity-100"
          >
            <Plus size={16} /> Add Exercise
          </button>
        </main>

        <aside className="border-l p-4 overflow-y-auto custom-scrollbar" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-1)' }}>
          <div className="mb-3 flex items-center gap-2">
            <Bot size={17} style={{ color: 'var(--accent)' }} />
            <h2 className="text-sm font-bold uppercase tracking-wider" style={{ color: 'var(--text-strong)' }}>AI Helper</h2>
          </div>
          <textarea
            value={aiPrompt}
            onChange={(event) => setAiPrompt(event.target.value)}
            className="min-h-28 w-full resize-y rounded-lg border px-3 py-2 text-sm outline-none"
            style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-2)', color: 'var(--text-soft)' }}
            placeholder="Tell AI what changed: low energy, leg day, shoulder pain, 30 minutes, no equipment..."
          />
          <div className="mt-2 flex gap-1">
            <button
              onClick={() => setAiMode('append')}
              className="flex-1 rounded-md px-2 py-1.5 text-xs font-semibold transition-colors"
              style={{
                background: aiMode === 'append' ? 'color-mix(in srgb, var(--accent) 20%, transparent)' : 'var(--bg-elev-2)',
                color: aiMode === 'append' ? 'var(--accent)' : 'var(--text-muted)',
                border: `1px solid ${aiMode === 'append' ? 'var(--accent)' : 'var(--border-soft)'}`,
              }}
            >
              Append
            </button>
            <button
              onClick={() => setAiMode('replace')}
              className="flex-1 rounded-md px-2 py-1.5 text-xs font-semibold transition-colors"
              style={{
                background: aiMode === 'replace' ? 'color-mix(in srgb, var(--danger) 20%, transparent)' : 'var(--bg-elev-2)',
                color: aiMode === 'replace' ? 'var(--danger)' : 'var(--text-muted)',
                border: `1px solid ${aiMode === 'replace' ? 'var(--danger)' : 'var(--border-soft)'}`,
              }}
            >
              Replace
            </button>
          </div>
          <button onClick={handleAiGenerate} disabled={aiBusy} className="mt-3 flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-bold disabled:opacity-50" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>
            <Sparkles size={15} /> {aiBusy ? 'Drafting...' : 'Generate Editable Plan'}
          </button>

          {aiResult && (
            <div className="mt-4 rounded-lg border p-3" style={{ borderColor: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 10%, transparent)' }}>
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{aiResult.summary}</div>
                <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded" style={{
                  background: aiResult.mode === 'replace' ? 'color-mix(in srgb, var(--danger) 20%, transparent)' : 'color-mix(in srgb, var(--accent) 20%, transparent)',
                  color: aiResult.mode === 'replace' ? 'var(--danger)' : 'var(--accent)',
                }}>
                  {aiResult.mode}
                </span>
              </div>
              <div className="mt-3 space-y-2">
                {aiResult.exercises.map((exercise) => (
                  <div key={exercise.id} className="rounded-md border p-2" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-2)' }}>
                    <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{exercise.name}</div>
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{exercise.sets} x {exercise.reps} - {exercise.targets}</div>
                  </div>
                ))}
              </div>
              <button onClick={applyAiExercises} className="mt-3 w-full rounded-md border px-3 py-2 text-sm font-semibold transition-colors hover:bg-white/5" style={{ borderColor: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 15%, transparent)', color: 'var(--accent)' }}>
                {aiResult.mode === 'replace' ? 'Replace Current Day' : 'Add To Current Day'}
              </button>
            </div>
          )}

          <div className="mt-5 rounded-lg border p-3 text-[11px] opacity-60" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-elev-1)', color: 'var(--text-muted)' }}>
            Each field here is editable. The default weekly mock plan stays as the reset baseline, and any custom changes persist locally.
          </div>
        </aside>
      </div>
    </div>
  );
};
