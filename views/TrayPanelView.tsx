import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  AlarmClock,
  BellOff,
  Brain,
  CalendarDays,
  ChevronRight,
  Clock3,
  Dumbbell,
  Gamepad2,
  LayoutDashboard,
  MessageSquare,
  Moon,
  Pause,
  Play,
  Power,
  RefreshCw,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import { StatusBanner } from '../components/ui/StatusBanner';

type TimerMode = 'pomodoro' | 'shortBreak' | 'longBreak';

interface TimerSnapshot {
  timeLeft: number;
  isActive: boolean;
  mode: TimerMode;
}

interface MusicTrackSnapshot {
  id: string;
  title: string;
  thumbnail?: string;
}

interface PlaylistSnapshot {
  id: number;
  name: string;
  trackCount: number;
  thumbnail?: string;
}

interface MusicSnapshot {
  isPlaying: boolean;
  currentTrack: MusicTrackSnapshot | null;
  activePlaylistId: number | null;
  playlists: PlaylistSnapshot[];
}

const DEFAULT_TIMER: TimerSnapshot = {
  timeLeft: 25 * 60,
  isActive: false,
  mode: 'pomodoro',
};

const DEFAULT_MUSIC: MusicSnapshot = {
  isPlaying: false,
  currentTrack: null,
  activePlaylistId: null,
  playlists: [],
};

const formatTime = (seconds: number) => {
  const safe = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(safe / 60).toString().padStart(2, '0');
  const s = (safe % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
};

const modeLabel = (mode: TimerMode) => {
  if (mode === 'shortBreak') return 'Short Break';
  if (mode === 'longBreak') return 'Long Break';
  return 'Pomodoro';
};

const getTrayErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
};

export const TrayPanelView: React.FC = () => {
  const [incognito, setIncognito] = useState<{ active: boolean; remainingSeconds: number }>({ active: false, remainingSeconds: 0 });
  const [gameMode, setGameMode] = useState(false);
  const [timerState, setTimerState] = useState<TimerSnapshot>(DEFAULT_TIMER);
  const [musicState, setMusicState] = useState<MusicSnapshot>(DEFAULT_MUSIC);
  const [busy, setBusy] = useState<string | null>(null);
  const [panelStatus, setPanelStatus] = useState<{ tone: 'warning' | 'error'; title: string; message: string } | null>(null);

  const refreshSystemState = useCallback(async () => {
    try {
      const appBridge = window.atheletiaAPI?.app;
      if (!appBridge?.getIncognitoStatus || !appBridge.getGameMode) {
        setPanelStatus({
          tone: 'warning',
          title: 'Tray bridge unavailable',
          message: 'Some tray controls may not work in this runtime.',
        });
        return;
      }
      const status = await appBridge.getIncognitoStatus();
      if (status) setIncognito(status);
      const gm = await appBridge.getGameMode();
      if (typeof gm === 'boolean') setGameMode(gm);
      setPanelStatus(null);
    } catch (error) {
      setPanelStatus({
        tone: 'error',
        title: 'Tray state unavailable',
        message: getTrayErrorMessage(error, 'Failed to read tray state.'),
      });
    }
  }, []);

  useEffect(() => {
    refreshSystemState();
    const interval = window.setInterval(() => {
      refreshSystemState();
    }, 1000);
    return () => window.clearInterval(interval);
  }, [refreshSystemState]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const register = async (promise: Promise<() => void>) => {
      const unlisten = await promise;
      if (disposed) {
        try { unlisten(); } catch { }
        return;
      }
      unlisteners.push(unlisten);
    };
    const setup = async () => {
      try {
        await register(listen<TimerSnapshot>('app:timer-state', (event) => {
          if (event.payload) {
            setTimerState({
              timeLeft: Number(event.payload.timeLeft || 0),
              isActive: Boolean(event.payload.isActive),
              mode: (event.payload.mode as TimerMode) || 'pomodoro',
            });
          }
        }));
        await register(listen<MusicSnapshot>('app:music-state', (event) => {
          if (event.payload) {
            setMusicState({
              isPlaying: Boolean(event.payload.isPlaying),
              currentTrack: event.payload.currentTrack || null,
              activePlaylistId: typeof event.payload.activePlaylistId === 'number' ? event.payload.activePlaylistId : null,
              playlists: Array.isArray(event.payload.playlists) ? event.payload.playlists : [],
            });
          }
        }));
      } catch {
        // ignore outside tauri
      }
    };
    setup();
    emitTo('main', 'tray:request-state', true).catch(() => { /* main may not be ready yet */ });
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) {
        try { unlisten(); } catch { }
      }
    };
  }, []);

  const runAction = useCallback(async (key: string, fn: () => Promise<any>) => {
    setPanelStatus(null);
    try {
      setBusy(key);
      await fn();
    } catch (error) {
      setPanelStatus({
        tone: 'error',
        title: 'Tray action failed',
        message: getTrayErrorMessage(error, `Action ${key} failed.`),
      });
      console.error(`[tray_panel] action failed: ${key}`, error);
    } finally {
      setBusy(null);
    }
  }, []);

  const openPage = useCallback(async (page: string) => {
    await runAction(`open-${page}`, async () => {
      if (window.atheletiaAPI?.app?.showWindowPage) {
        await window.atheletiaAPI.app.showWindowPage(page);
      } else {
        await window.atheletiaAPI?.app?.showWindow?.();
      }
    });
  }, [runAction]);

  const hidePanel = useCallback(async () => {
    await runAction('hide-panel', async () => {
      try {
        if (window.atheletiaAPI?.app?.toggleTrayPanel) {
          await window.atheletiaAPI.app.toggleTrayPanel();
          return;
        }
      } catch {
        // fallback below
      }
      try {
        await getCurrentWindow().hide();
      } catch (error) {
        throw new Error(getTrayErrorMessage(error, 'Unable to hide the tray panel.'));
      }
    });
  }, [runAction]);

  const controlMusic = useCallback(async (action: 'prev' | 'play_pause' | 'next') => {
    await runAction(`music-${action}`, async () => {
      try {
        if (window.atheletiaAPI?.app?.musicControl) {
          await window.atheletiaAPI.app.musicControl(action);
          return;
        }
      } catch {
        // fallback below
      }
      {
        await emitTo('main', 'tray:music-control', action);
      }
    });
  }, [runAction]);

  const selectPlaylist = useCallback(async (playlistId: number) => {
    await runAction(`playlist-${playlistId}`, async () => {
      try {
        if (window.atheletiaAPI?.app?.musicSelectPlaylist) {
          await window.atheletiaAPI.app.musicSelectPlaylist(playlistId);
          return;
        }
      } catch {
        // fallback below
      }
      {
        await emitTo('main', 'tray:music-playlist-select', { playlistId });
      }
    });
  }, [runAction]);

  const controlTimer = useCallback(async (action: string, minutes?: number) => {
    await runAction(`timer-${action}`, async () => {
      try {
        if (window.atheletiaAPI?.app?.timerControl) {
          await window.atheletiaAPI.app.timerControl(action, minutes);
          return;
        }
      } catch {
        // fallback below
      }
      {
        await emitTo('main', 'tray:timer-control', { action, minutes });
      }
    });
  }, [runAction]);

  const incognitoLabel = useMemo(() => {
    if (!incognito.active) return 'Off';
    if (incognito.remainingSeconds <= 0) return 'On';
    const mins = Math.floor(incognito.remainingSeconds / 60).toString().padStart(2, '0');
    const secs = Math.max(0, incognito.remainingSeconds % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
  }, [incognito]);

  return (
    <div className="h-screen w-screen overflow-y-auto custom-scrollbar text-white" style={{ background: 'var(--bg-app)', color: 'var(--text-main)' }}>
      <div className="min-h-full p-3">
        <div
          className="min-h-full rounded-2xl p-3 flex flex-col gap-3"
          style={{
            border: '1px solid var(--border-soft)',
            background: 'linear-gradient(180deg, var(--bg-elev-1) 0%, var(--bg-canvas) 100%)',
          }}
        >
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-base font-bold tracking-tight">Atheletia Control Center</h1>
              <p className="text-[11px] text-gray-400">Tray quick actions</p>
            </div>
            <button
              onClick={() => { hidePanel(); }}
              className="px-2 py-1 text-xs rounded-md transition-colors"
              style={{ background: 'var(--bg-elev-2)', color: 'var(--text-soft)' }}
              title="Hide panel"
            >
              Hide
            </button>
          </div>

          {panelStatus && (
            <StatusBanner
              tone={panelStatus.tone}
              title={panelStatus.title}
              message={panelStatus.message}
            />
          )}

          <div className="rounded-xl border border-[#2a2c32] bg-[#151821] p-3">
            <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-2">Quick Open</div>
            <div className="grid grid-cols-3 gap-2">
              {[
                { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
                { id: 'chat', label: 'Chat', icon: MessageSquare },
                { id: 'brain', label: 'Brain', icon: Brain },
                { id: 'schedule', label: 'Schedule', icon: CalendarDays },
                { id: 'zen', label: 'Zen', icon: AlarmClock },
                { id: 'music', label: 'Music', icon: Play },
                { id: 'workout', label: 'Workout', icon: Dumbbell },
              ].map((item) => (
                <button
                  key={item.id}
                  onClick={() => openPage(item.id)}
                  disabled={busy === `open-${item.id}`}
                  className="flex items-center justify-between px-2 py-2 rounded-lg bg-[#1d212b] hover:bg-[#272d39] disabled:opacity-50 text-xs"
                >
                  <span className="flex items-center gap-1.5">
                    <item.icon size={13} />
                    <span>{item.label}</span>
                  </span>
                  <ChevronRight size={12} className="text-gray-500" />
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-[#2a2c32] bg-[#151821] p-3">
            <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-2">Music</div>
            <div className="flex items-center gap-2 mb-2">
              {musicState.currentTrack?.thumbnail ? (
                <img src={musicState.currentTrack.thumbnail} alt="" className="w-8 h-8 rounded object-cover border border-[#2a2c32]" />
              ) : (
                <div className="w-8 h-8 rounded bg-[#1f2431] border border-[#2a2c32]" />
              )}
              <div className="min-w-0">
                <div className="text-xs font-semibold text-gray-100 truncate">
                  {musicState.currentTrack?.title || 'No track playing'}
                </div>
                <div className="text-[10px] text-gray-500 truncate">
                  {musicState.playlists.find(p => p.id === musicState.activePlaylistId)?.name || 'Select a playlist below'}
                </div>
              </div>
            </div>
            <div className="flex items-center justify-center gap-3">
              <button onClick={() => controlMusic('prev')} disabled={busy === 'music-prev'} className="w-9 h-9 rounded-full bg-[#222733] hover:bg-[#2f3646] flex items-center justify-center disabled:opacity-50">
                <SkipBack size={16} />
              </button>
              <button
                onClick={() => controlMusic('play_pause')}
                disabled={busy === 'music-play_pause'}
                className="w-11 h-11 rounded-full flex items-center justify-center disabled:opacity-50"
                style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
              >
                {musicState.isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
              </button>
              <button onClick={() => controlMusic('next')} disabled={busy === 'music-next'} className="w-9 h-9 rounded-full bg-[#222733] hover:bg-[#2f3646] flex items-center justify-center disabled:opacity-50">
                <SkipForward size={16} />
              </button>
            </div>
            <div className="grid grid-cols-1 gap-1 mt-3 max-h-24 overflow-y-auto custom-scrollbar">
              {(musicState.playlists || []).slice(0, 4).map((playlist) => (
                <button
                  key={playlist.id}
                  onClick={() => selectPlaylist(playlist.id)}
                  disabled={busy === `playlist-${playlist.id}`}
                  className={`text-left px-2 py-1.5 rounded-md text-xs transition-colors border ${
                    musicState.activePlaylistId === playlist.id
                      ? 'text-white'
                      : 'bg-[#1f2431] border-[#2a2c32] hover:bg-[#2a3141] text-gray-200'
                  }`}
                  style={musicState.activePlaylistId === playlist.id ? { background: 'var(--accent-soft)', borderColor: 'color-mix(in srgb, var(--accent) 45%, transparent)', color: 'var(--text-strong)' } : undefined}
                >
                  <div className="truncate font-medium">{playlist.name}</div>
                  <div className="text-[10px] text-gray-500">{playlist.trackCount} tracks</div>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-[#2a2c32] bg-[#151821] p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-wider text-gray-400">Pomodoro</div>
              <div className="text-[11px] text-gray-300">{modeLabel(timerState.mode)}</div>
            </div>
            <div className="text-2xl font-mono font-semibold text-center mb-2">{formatTime(timerState.timeLeft)}</div>
            <div className="flex items-center justify-center gap-2 mb-2">
              <button
                onClick={() => controlTimer(timerState.isActive ? 'pause' : 'start')}
                disabled={busy === 'timer-start' || busy === 'timer-pause'}
                className="px-3 py-1.5 rounded-md bg-[#232838] hover:bg-[#2f3650] text-xs disabled:opacity-50 flex items-center gap-1.5"
              >
                {timerState.isActive ? <Pause size={13} /> : <Play size={13} />}
                {timerState.isActive ? 'Pause' : 'Start'}
              </button>
              <button
                onClick={() => controlTimer('reset')}
                disabled={busy === 'timer-reset'}
                className="px-3 py-1.5 rounded-md bg-[#232838] hover:bg-[#2f3650] text-xs disabled:opacity-50 flex items-center gap-1.5"
              >
                <Clock3 size={13} />
                Reset
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button onClick={() => controlTimer('set_duration', 25)} className="text-xs py-1.5 rounded-md bg-[#1f2431] hover:bg-[#2a3141]">25m</button>
              <button onClick={() => controlTimer('set_duration', 5)} className="text-xs py-1.5 rounded-md bg-[#1f2431] hover:bg-[#2a3141]">5m</button>
              <button onClick={() => controlTimer('set_duration', 15)} className="text-xs py-1.5 rounded-md bg-[#1f2431] hover:bg-[#2a3141]">15m</button>
            </div>
          </div>

          <div className="rounded-xl border border-[#2a2c32] bg-[#151821] p-3">
            <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-2">Privacy & Performance</div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-sm">
                <Moon size={14} className={incognito.active ? 'text-cyan-300' : 'text-gray-500'} />
                <span>Incognito</span>
              </div>
              <span className={`text-xs font-semibold ${incognito.active ? 'text-cyan-300' : 'text-gray-500'}`}>{incognitoLabel}</span>
            </div>
            <div className="grid grid-cols-4 gap-2 mb-3">
              <button onClick={() => runAction('incognito-toggle', async () => setIncognito((await window.atheletiaAPI?.app?.toggleIncognito?.()) || incognito))} className="text-xs py-1.5 rounded-md bg-[#1f2431] hover:bg-[#2a3141]">Toggle</button>
              <button onClick={() => runAction('incognito-15', async () => setIncognito((await window.atheletiaAPI?.app?.setIncognitoFor?.(15)) || incognito))} className="text-xs py-1.5 rounded-md bg-[#1f2431] hover:bg-[#2a3141]">15m</button>
              <button onClick={() => runAction('incognito-30', async () => setIncognito((await window.atheletiaAPI?.app?.setIncognitoFor?.(30)) || incognito))} className="text-xs py-1.5 rounded-md bg-[#1f2431] hover:bg-[#2a3141]">30m</button>
              <button onClick={() => runAction('incognito-off', async () => setIncognito((await window.atheletiaAPI?.app?.setIncognitoFor?.(0)) || incognito))} className="text-xs py-1.5 rounded-md bg-[#1f2431] hover:bg-[#2a3141]">Off</button>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm">
                <Gamepad2 size={14} className={gameMode ? 'text-amber-300' : 'text-gray-500'} />
                <span>Game Mode</span>
              </div>
              <button
                onClick={() => runAction('game-mode', async () => {
                  const next = await window.atheletiaAPI?.app?.toggleGameMode?.();
                  if (typeof next === 'boolean') setGameMode(next);
                })}
                className={`text-xs px-3 py-1.5 rounded-md ${gameMode ? 'bg-amber-500/20 text-amber-300' : 'bg-[#1f2431] hover:bg-[#2a3141]'}`}
              >
                {gameMode ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-[#2a2c32] bg-[#151821] p-3">
            <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-2">System</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => runAction('refresh-ai', async () => { await window.atheletiaAPI?.app?.refreshAi?.(); await openPage('dashboard'); })}
                className="text-xs py-2 rounded-md bg-[#1f2431] hover:bg-[#2a3141] flex items-center justify-center gap-1.5"
              >
                <RefreshCw size={13} /> Refresh AI
              </button>
              <button
                onClick={() => runAction('clear-notifications', async () => { await window.atheletiaAPI?.app?.clearNotifications?.(); })}
                className="text-xs py-2 rounded-md bg-[#1f2431] hover:bg-[#2a3141] flex items-center justify-center gap-1.5"
              >
                <BellOff size={13} /> Clear Alerts
              </button>
              <button
                onClick={() => { hidePanel(); }}
                className="text-xs py-2 rounded-md bg-[#1f2431] hover:bg-[#2a3141] flex items-center justify-center gap-1.5"
              >
                <Moon size={13} /> Hide Panel
              </button>
              <button
                onClick={() => runAction('quit', async () => { await window.atheletiaAPI?.app?.quit?.(); })}
                className="text-xs py-2 rounded-md bg-red-500/20 hover:bg-red-500/30 text-red-300 flex items-center justify-center gap-1.5"
              >
                <Power size={13} /> Quit
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
