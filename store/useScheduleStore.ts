import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Types
export interface Task {
    id: number;
    title: string;
    description?: string;
    dueDate?: string; // YYYY-MM-DD
    dueTime?: string; // HH:MM (24h)
    tag: 'Work' | 'Health' | 'Study' | 'Life';
    color: 'blue' | 'orange' | 'emerald' | 'gray';
    googleId?: string;
    googleCalendarEventId?: string;
    googleTaskListId?: string;
}

export interface ScheduleEvent {
    id: number;
    googleId?: string; // ID from Google Calendar
    title: string;
    date: string;      // YYYY-MM-DD
    timeStart: string; // HH:MM format (24h)
    duration: number;  // minutes
    type: 'focus' | 'break' | 'meeting' | 'work';
}

interface ScheduleState {
    tasks: Task[];
    events: ScheduleEvent[];
    isGoogleConnected: boolean;
    googleStatusMessage: string;

    // Task actions
    addTask: (task: Omit<Task, 'id'>) => void;
    updateTask: (id: number, updates: Partial<Omit<Task, 'id'>>) => void;
    deleteTask: (id: number) => void;
    completeTask: (id: number) => void;

    // Event actions
    addEvent: (event: Omit<ScheduleEvent, 'id'>, syncToGoogle?: boolean) => Promise<void>;
    updateEvent: (id: number, updates: Partial<Omit<ScheduleEvent, 'id'>>, syncToGoogle?: boolean) => Promise<void>;
    deleteEvent: (id: number, syncToGoogle?: boolean) => Promise<void>;

    // Google Actions
    checkGoogleAuth: () => Promise<void>;
    connectGoogle: () => Promise<void>;
    disconnectGoogle: () => Promise<void>;
    syncWithGoogle: (startDate?: Date, endDate?: Date) => Promise<void>;
    syncTasksWithGoogle: () => Promise<void>;
}

// Helper to get YYYY-MM-DD
const getTodayString = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Default data so the schedule isn't empty on first load
const defaultTasks: Task[] = [
    { id: 1, title: "Review Pull Request", tag: "Work", color: "blue" },
    { id: 2, title: "Gym (Leg Day)", tag: "Health", color: "orange" },
    { id: 3, title: "LeetCode Graph Problems", tag: "Study", color: "emerald" },
    { id: 4, title: "System Design Video", tag: "Study", color: "emerald" },
    { id: 5, title: "Grocery Run", tag: "Life", color: "gray" },
];

const defaultEvents: ScheduleEvent[] = [
    { id: 101, title: "Deep Work Session", date: getTodayString(), timeStart: "09:00", duration: 120, type: "focus" },
    { id: 102, title: "Lunch Break", date: getTodayString(), timeStart: "12:00", duration: 60, type: "break" },
    { id: 103, title: "Team Sync", date: getTodayString(), timeStart: "14:00", duration: 60, type: "meeting" },
    { id: 104, title: "Code Review", date: getTodayString(), timeStart: "15:30", duration: 90, type: "work" },
];

const toGoogleTaskDue = (dueDate?: string, dueTime?: string): string | undefined => {
    if (!dueDate) return undefined;
    if (!dueTime) return `${dueDate}T00:00:00.000Z`;
    return `${dueDate}T${dueTime}:00.000Z`;
};

const buildTaskCalendarRange = (dueDate?: string, dueTime?: string): { start: string; end: string } | null => {
    if (!dueDate) return null;
    const [year, month, day] = dueDate.split('-').map(Number);
    const [h, m] = (dueTime || '09:00').split(':').map(Number);
    const start = new Date(year, month - 1, day, h, m, 0, 0);
    const end = new Date(start.getTime() + 30 * 60000);
    return {
        start: start.toISOString(),
        end: end.toISOString(),
    };
};

export const useScheduleStore = create<ScheduleState>()(
    persist(
        (set, get) => ({
            tasks: defaultTasks,
            events: defaultEvents,
            isGoogleConnected: false,
            googleStatusMessage: '',

            addTask: async (task) => {
                const id = Date.now();
                let googleId: string | undefined;
                let googleCalendarEventId: string | undefined;

                console.log('addTask called. isGoogleConnected:', get().isGoogleConnected);
                console.log('Task data:', task);

                if (get().isGoogleConnected) {
                    try {
                        console.log('Attempting to add to Google Tasks...');
                        // @ts-ignore
                        const result = await window.nexusAPI.google.tasks.add(undefined, {
                            title: task.title,
                            notes: task.description,
                            due: toGoogleTaskDue(task.dueDate, task.dueTime)
                        });
                        console.log('Google Tasks API result:', result);
                        if (typeof result === 'string') {
                            googleId = result;
                        } else if (result && (result as any).error) {
                            console.error('Google Tasks API Error:', (result as any).error);
                        }

                        const calendarRange = buildTaskCalendarRange(task.dueDate, task.dueTime);
                        if (calendarRange) {
                            // @ts-ignore
                            const eventResult = await window.nexusAPI.google.addEvent({
                                title: `[Task] ${task.title}`,
                                description: task.description || '',
                                start: calendarRange.start,
                                end: calendarRange.end,
                            });
                            if (typeof eventResult === 'string') {
                                googleCalendarEventId = eventResult;
                            }
                        }
                    } catch (e) {
                        console.error("Failed to add Google Task:", e);
                    }
                } else {
                    console.log('Not connected to Google, skipping sync');
                }

                set((state) => ({
                    tasks: [...state.tasks, { ...task, id, googleId, googleCalendarEventId }],
                }));
            },

            updateTask: async (id, updates) => {
                const task = get().tasks.find(t => t.id === id);

                set((state) => ({
                    tasks: state.tasks.map((t) =>
                        t.id === id ? { ...t, ...updates } : t
                    ),
                }));

                if (task && task.googleId && get().isGoogleConnected) {
                    try {
                        // @ts-ignore
                        await window.nexusAPI.google.tasks.update(undefined, task.googleId, {
                            title: updates.title ?? task.title,
                            notes: updates.description ?? task.description,
                            due: toGoogleTaskDue(updates.dueDate ?? task.dueDate, updates.dueTime ?? task.dueTime),
                        });

                        const nextTitle = updates.title ?? task.title;
                        const nextDescription = updates.description ?? task.description;
                        const nextDueDate = updates.dueDate ?? task.dueDate;
                        const nextDueTime = updates.dueTime ?? task.dueTime;
                        const calendarRange = buildTaskCalendarRange(nextDueDate, nextDueTime);

                        if (task.googleCalendarEventId && calendarRange) {
                            // @ts-ignore
                            await window.nexusAPI.google.updateEvent(task.googleCalendarEventId, {
                                title: `[Task] ${nextTitle}`,
                                description: nextDescription || '',
                                start: calendarRange.start,
                                end: calendarRange.end,
                            });
                        } else if (task.googleCalendarEventId && !calendarRange) {
                            // @ts-ignore
                            await window.nexusAPI.google.deleteEvent(task.googleCalendarEventId);
                            set((state) => ({
                                tasks: state.tasks.map((t) =>
                                    t.id === id ? { ...t, googleCalendarEventId: undefined } : t
                                ),
                            }));
                        } else if (!task.googleCalendarEventId && calendarRange) {
                            // @ts-ignore
                            const eventResult = await window.nexusAPI.google.addEvent({
                                title: `[Task] ${nextTitle}`,
                                description: nextDescription || '',
                                start: calendarRange.start,
                                end: calendarRange.end,
                            });
                            if (typeof eventResult === 'string') {
                                set((state) => ({
                                    tasks: state.tasks.map((t) =>
                                        t.id === id ? { ...t, googleCalendarEventId: eventResult } : t
                                    ),
                                }));
                            }
                        }
                    } catch (e) {
                        console.error("Failed to update Google Task:", e);
                    }
                }
            },

            deleteTask: async (id) => {
                const task = get().tasks.find(t => t.id === id);

                set((state) => ({
                    tasks: state.tasks.filter((t) => t.id !== id),
                }));

                if (task && task.googleId && get().isGoogleConnected) {
                    try {
                        // @ts-ignore
                        await window.nexusAPI.google.tasks.delete(undefined, task.googleId);
                        if (task.googleCalendarEventId) {
                            // @ts-ignore
                            await window.nexusAPI.google.deleteEvent(task.googleCalendarEventId);
                        }
                    } catch (e) {
                        console.error("Failed to delete Google Task:", e);
                    }
                }
            },

            completeTask: async (id) => {
                console.log('Store: completeTask called for id:', id);
                const task = get().tasks.find(t => t.id === id);

                // Optimistically remove from list
                set((state) => ({
                    tasks: state.tasks.filter((t) => t.id !== id),
                }));

                if (task && task.googleId && get().isGoogleConnected) {
                    console.log('Store: Syncing completion to Google Task:', task.googleId);
                    try {
                        // @ts-ignore
                        await window.nexusAPI.google.tasks.update(undefined, task.googleId, {
                            status: 'completed'
                        });
                        if (task.googleCalendarEventId) {
                            // @ts-ignore
                            await window.nexusAPI.google.deleteEvent(task.googleCalendarEventId);
                        }
                        console.log('Store: Google Task marked completed');
                    } catch (e) {
                        console.error("Failed to complete Google Task:", e);
                    }
                } else {
                    console.log('Store: Task not synced to Google or not connected');
                }
            },

            addEvent: async (event, syncToGoogle = false) => {
                const id = Date.now();
                let googleId: string | undefined;

                if (syncToGoogle && get().isGoogleConnected) {
                    const [year, month, day] = event.date.split('-').map(Number);
                    const [h, m] = event.timeStart.split(':').map(Number);
                    const start = new Date(year, month - 1, day, h, m, 0, 0);
                    const end = new Date(start.getTime() + event.duration * 60000);

                    try {
                        // @ts-ignore
                        const result = await window.nexusAPI.google.addEvent({
                            title: event.title,
                            start: start.toISOString(),
                            end: end.toISOString()
                        });

                        if (typeof result === 'string') {
                            googleId = result;
                            set({ googleStatusMessage: 'Event saved to Google Calendar.' });
                        }
                    } catch (e) {
                        console.error("Failed to sync to Google:", e);
                        const message = e instanceof Error ? e.message : String(e);
                        set({ googleStatusMessage: `Failed to save event to Google Calendar: ${message}` });
                    }
                } else if (syncToGoogle && !get().isGoogleConnected) {
                    set({ googleStatusMessage: 'Google is not connected. Event saved locally only.' });
                }

                set((state) => ({
                    events: [...state.events, { ...event, id, googleId }],
                }));
            },

            updateEvent: async (id, updates, syncToGoogle = false) => {
                const event = get().events.find(e => e.id === id);
                if (!event) return;

                set((state) => ({
                    events: state.events.map((e) =>
                        e.id === id ? { ...e, ...updates } : e
                    ),
                }));

                if (syncToGoogle && get().isGoogleConnected && event.googleId) {
                    const updatedEvent = { ...event, ...updates };
                    const [year, month, day] = updatedEvent.date.split('-').map(Number);
                    const [h, m] = updatedEvent.timeStart.split(':').map(Number);
                    const start = new Date(year, month - 1, day, h, m, 0, 0);
                    const end = new Date(start.getTime() + updatedEvent.duration * 60000);

                    try {
                        // @ts-ignore
                        await window.nexusAPI.google.updateEvent(event.googleId, {
                            title: updatedEvent.title,
                            start: start.toISOString(),
                            end: end.toISOString()
                        });
                        set({ googleStatusMessage: 'Google Calendar event updated.' });
                    } catch (e) {
                        console.error("Failed to update Google event:", e);
                        const message = e instanceof Error ? e.message : String(e);
                        set({ googleStatusMessage: `Failed to update Google Calendar event: ${message}` });
                    }
                }
            },

            deleteEvent: async (id, syncToGoogle = false) => {
                const event = get().events.find(e => e.id === id);

                set((state) => ({
                    events: state.events.filter((e) => e.id !== id),
                }));

                if (syncToGoogle && get().isGoogleConnected && event?.googleId) {
                    try {
                        // @ts-ignore
                        await window.nexusAPI.google.deleteEvent(event.googleId);
                        set({ googleStatusMessage: 'Google Calendar event deleted.' });
                    } catch (e) {
                        console.error("Failed to delete Google event:", e);
                        const message = e instanceof Error ? e.message : String(e);
                        set({ googleStatusMessage: `Failed to delete Google Calendar event: ${message}` });
                    }
                }
            },

            checkGoogleAuth: async () => {
                try {
                    // @ts-ignore
                    const isConnected = await window.nexusAPI.google.checkAuth();
                    set({ isGoogleConnected: isConnected, googleStatusMessage: '' });
                } catch (e) {
                    console.error("Check auth failed:", e);
                    set({ googleStatusMessage: 'Unable to check Google auth status.' });
                }
            },

            connectGoogle: async () => {
                try {
                    // @ts-ignore
                    const success = await window.nexusAPI.google.signIn();
                    if (success) {
                        set({ isGoogleConnected: true, googleStatusMessage: 'Google Calendar connected.' });
                        get().syncWithGoogle();
                        get().syncTasksWithGoogle();
                    } else {
                        set({ googleStatusMessage: 'Google sign-in was cancelled or failed.' });
                    }
                } catch (e) {
                    console.error("Connect google failed:", e);
                    const message = e instanceof Error ? e.message : 'Google sign-in failed.';
                    set({ isGoogleConnected: false, googleStatusMessage: message });
                }
            },

            disconnectGoogle: async () => {
                try {
                    // @ts-ignore
                    await window.nexusAPI.google.signOut();
                    set({ isGoogleConnected: false, googleStatusMessage: 'Google account disconnected.' });
                } catch (e) {
                    console.error("Disconnect google failed:", e);
                    set({ googleStatusMessage: 'Failed to disconnect Google account.' });
                }
            },

            syncWithGoogle: async (startDate, endDate) => {
                if (!get().isGoogleConnected) return;

                let start: Date;
                let end: Date;

                // Default to today if no range provided
                if (!startDate || !endDate) {
                    const now = new Date();
                    start = new Date(now.setHours(0, 0, 0, 0));
                    end = new Date(now.setHours(23, 59, 59, 999));
                } else {
                    start = startDate;
                    end = endDate;
                }

                try {
                    // @ts-ignore
                    const googleEvents = await window.nexusAPI.google.listEvents(start.toISOString(), end.toISOString());

                    if (Array.isArray(googleEvents)) {
                        const currentEvents = get().events;

                        const mappedGoogleEvents: ScheduleEvent[] = googleEvents.map((ge: any) => {
                            const eventStart = new Date(ge.start);
                            const eventEnd = new Date(ge.end);
                            const duration = (eventEnd.getTime() - eventStart.getTime()) / 60000;
                            const timeStart = eventStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                            const dateStr = `${eventStart.getFullYear()}-${String(eventStart.getMonth() + 1).padStart(2, '0')}-${String(eventStart.getDate()).padStart(2, '0')}`;

                            const existing = currentEvents.find(ce => ce.googleId === ge.id);

                            return {
                                id: existing ? existing.id : Date.now() + Math.random(),
                                googleId: ge.id,
                                title: ge.title,
                                date: dateStr,
                                timeStart: timeStart,
                                duration: duration,
                                type: existing ? existing.type : 'meeting'
                            };
                        });

                        const mergedEvents = currentEvents.filter(e => {
                            // Keep if local only
                            if (!e.googleId) return true;
                            // Keep if it belongs to a different day/range than what we just fetched
                            const eDate = new Date(e.date + 'T' + e.timeStart);
                            return !(eDate >= start && eDate <= end);
                        });

                        set({ events: [...mergedEvents, ...mappedGoogleEvents] });
                    }
                    set({ googleStatusMessage: '' });
                } catch (e) {
                    console.error("Sync failed:", e);
                    const message = e instanceof Error ? e.message : String(e);
                    set({ googleStatusMessage: `Google Calendar sync failed: ${message}` });
                }
            },

            syncTasksWithGoogle: async () => {
                if (!get().isGoogleConnected) return;

                try {
                    // @ts-ignore
                    const googleTasks = await window.nexusAPI.google.tasks.list();
                    if (Array.isArray(googleTasks)) {
                        const currentTasks = get().tasks;

                        const localOnlyTasks = currentTasks.filter(t => !t.googleId);

                        const mappedGoogleTasks: Task[] = googleTasks.map((gt: any) => {
                            const existing = currentTasks.find(ct => ct.googleId === gt.id);

                            return {
                                id: existing ? existing.id : Date.now() + Math.random(),
                                title: gt.title,
                                googleId: gt.id,
                                dueDate: typeof gt.due === 'string' ? gt.due.slice(0, 10) : undefined,
                                dueTime: typeof gt.due === 'string' && gt.due.length >= 16 && gt.due.slice(11, 16) !== '00:00'
                                    ? gt.due.slice(11, 16)
                                    : undefined,
                                googleCalendarEventId: existing?.googleCalendarEventId,
                                tag: existing ? existing.tag : 'Work',
                                color: existing ? existing.color : 'gray'
                            };
                        });

                        set({ tasks: [...localOnlyTasks, ...mappedGoogleTasks] });
                    }
                } catch (e) {
                    console.error("Task sync failed:", e);
                    const message = e instanceof Error ? e.message : String(e);
                    set({ googleStatusMessage: `Google Tasks sync failed: ${message}` });
                }
            }
        }),
        {
            name: 'schedule-storage',
        }
    )
);
