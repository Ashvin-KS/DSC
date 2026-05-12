import React, { useState } from 'react';
import { Play, Pause, RotateCcw, Moon, Music, Clock } from 'lucide-react';
import { useTimerStore, formatTime } from '../store/useTimerStore';
import { useMusicStore } from '../store/useMusicStore';
import { useNavStore } from '../store/useNavStore';

export const ZenView: React.FC = () => {
  const {
    timeLeft, isActive, start, pause, reset, setDuration,
    isPomodoroEnabled, togglePomodoro, mode, setMode,
    autoSyncMusic, toggleAutoSyncMusic
  } = useTimerStore();
  const playlists = useMusicStore((s) => s.playlists);
  const setActivePlaylist = useMusicStore((s) => s.setActivePlaylist);
  const setActiveTab = useNavStore((s) => s.setActiveTab);

  const [dndEnabled, setDndEnabled] = useState(false);
  const [isEditingTime, setIsEditingTime] = useState(false);
  const [customMinutes, setCustomMinutes] = useState('25');

  const toggleTimer = () => {
    if (isActive) {
      pause();
    } else {
      start();
    }
  };

  const handleReset = () => {
    reset();
    setIsEditingTime(false);
  };

  const handleTimeEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const mins = parseInt(customMinutes);
    if (!isNaN(mins) && mins > 0) {
      setDuration(mins);
      if (isPomodoroEnabled) togglePomodoro(); // turn off structured pomodoro if manually overriding
    }
    setIsEditingTime(false);
  };

  // Fullscreen toggle helper
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  };

  return (
    <div className="h-full w-full flex flex-col items-center justify-center relative overflow-hidden animate-in fade-in duration-700" style={{ background: 'var(--bg-app)' }}>

      {/* Ambient Background Glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-indigo-900/10 rounded-full blur-[120px] pointer-events-none" />

      {/* --- COMPONENT A: FOCUS TIMER --- */}
      <div className="z-20 flex flex-col items-center mb-10 w-full">
        <div className="relative group flex flex-col items-center">

          {/* Pomodoro Mode Tabs */}
          {isPomodoroEnabled && (
            <div className="flex items-center gap-2 mb-8 bg-white/5 p-1 rounded-full border border-white/5 backdrop-blur-md">
              <button
                onClick={() => setMode('pomodoro')}
                className={`px-4 py-1.5 rounded-full text-xs font-bold transition-colors ${mode === 'pomodoro' ? 'bg-[var(--accent-soft)] text-accent' : 'text-gray-400 hover:text-white'}`}
              >
                Pomodoro
              </button>
              <button
                onClick={() => setMode('shortBreak')}
                className={`px-4 py-1.5 rounded-full text-xs font-bold transition-colors ${mode === 'shortBreak' ? 'bg-green-500/20 text-green-300' : 'text-gray-400 hover:text-white'}`}
              >
                Short Break
              </button>
              <button
                onClick={() => setMode('longBreak')}
                className={`px-4 py-1.5 rounded-full text-xs font-bold transition-colors ${mode === 'longBreak' ? 'bg-[var(--accent-soft)] text-accent' : 'text-gray-400 hover:text-white'}`}
              >
                Long Break
              </button>
            </div>
          )}

          {/* Timer Display */}
          {isEditingTime ? (
            <form onSubmit={handleTimeEditSubmit} className="flex items-center gap-2">
              <input
                type="number"
                min="1"
                max="999"
                value={customMinutes}
                onChange={(e) => setCustomMinutes(e.target.value)}
                autoFocus
                onBlur={handleTimeEditSubmit}
                className="bg-transparent border-b-2 border-accent text-8xl md:text-9xl font-thin font-mono tracking-tighter tabular-nums text-white text-center w-48 outline-none"
              />
            </form>
          ) : (
            <div
              onClick={() => {
                if (!isActive) {
                  setCustomMinutes(Math.ceil(timeLeft / 60).toString());
                  setIsEditingTime(true);
                }
              }}
              className={`text-8xl md:text-9xl font-thin font-mono tracking-tighter tabular-nums transition-colors duration-500 cursor-pointer hover:text-white ${isActive ? 'text-indigo-200 drop-shadow-[0_0_15px_rgba(165,180,252,0.3)]' : 'text-gray-400'}`}
              title="Click to edit time"
            >
              {formatTime(timeLeft)}
            </div>
          )}

          {/* Primary Controls */}
          <div className="flex items-center justify-center gap-6 mt-8 opacity-90 transition-opacity">
            <button
              onClick={toggleTimer}
              className={`w-14 h-14 rounded-full border flex items-center justify-center transition-all ${isActive ? 'bg-[var(--accent-soft)] border-[var(--accent-soft)] text-accent hover:bg-[var(--accent-soft)]' : 'bg-white/5 border-white/10 text-gray-300 hover:text-white hover:bg-white/10 hover:border-white/20 hover:scale-105'}`}
            >
              {isActive ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" className="ml-1" />}
            </button>

            <button
              onClick={handleReset}
              className="w-10 h-10 rounded-full bg-transparent border border-transparent flex items-center justify-center text-gray-600 hover:text-gray-400 hover:bg-white/5 transition-all"
            >
              <RotateCcw size={18} />
            </button>
          </div>

          {/* Secondary Feature Toggles */}
          <div className="flex items-center gap-6 mt-12 px-6 py-2 bg-black/40 border border-white/5 rounded-full backdrop-blur-md">
            {/* Pomodoro Toggle */}
            <button
              onClick={togglePomodoro}
              className={`flex items-center gap-2 text-xs font-bold uppercase tracking-widest transition-colors ${isPomodoroEnabled ? 'text-accent' : 'text-gray-500 hover:text-gray-300'}`}
            >
              <Clock size={14} />
              Pomodoro
            </button>
            <div className="w-[1px] h-4 bg-white/10" />

            {/* Music Sync Toggle */}
            <button
              onClick={toggleAutoSyncMusic}
              className={`flex items-center gap-2 text-xs font-bold uppercase tracking-widest transition-colors ${autoSyncMusic ? 'text-accent' : 'text-gray-500 hover:text-gray-300'}`}
              title="Auto-pause music when timer finishes"
            >
              <Music size={14} />
              Sync Music
            </button>
          </div>

        </div>
      </div>

      {/* --- COMPONENT B: PLAYLIST SELECTION --- */}
      <div className="z-20 w-full max-w-2xl px-6 mt-8">
        <div className="flex items-center justify-between mb-4 px-1">
          <span className="text-xs font-bold text-gray-500 uppercase tracking-widest">
            Quick Focus Mixes
          </span>
          <button
            onClick={() => {
              setActiveTab('music');
            }}
            className="text-xs text-accent hover:text-accent transition-colors flex items-center gap-1"
          >
            Open Music App <Play size={10} />
          </button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <button
            onClick={() => {
              localStorage.setItem('atheletia_music_taste_prompt', 'instrumental deep focus mix for coding and studying');
              window.dispatchEvent(new CustomEvent('atheletia:music-taste-prompt', { detail: 'instrumental deep focus mix for coding and studying' }));
              setActiveTab('music');
            }}
            className="group relative overflow-hidden rounded-xl bg-purple-500/10 border border-purple-400/20 hover:border-purple-300/50 transition-all duration-300 text-left h-32 flex flex-col justify-end p-4"
          >
            <div className="absolute inset-0 bg-gradient-to-br from-purple-500/20 via-transparent to-cyan-500/10" />
            <div className="relative z-10">
              <span className="text-sm font-bold text-white">AI Focus Mix</span>
              <span className="mt-1 block text-[10px] text-purple-200 font-medium">Taste AI playlist</span>
            </div>
          </button>
          {playlists.slice(0, 2).map((playlist) => (
            <button
              key={playlist.id}
              onClick={() => setActivePlaylist(playlist.id)}
              className="group relative overflow-hidden rounded-xl bg-white/5 border border-white/5 hover:border-white/20 transition-all duration-300 text-left h-32 flex flex-col justify-end p-4"
            >
              {/* Background Image */}
              {playlist.tracks.length > 0 && (
                <>
                  <img
                    src={playlist.tracks[0].thumbnail}
                    alt=""
                    className="absolute inset-0 w-full h-full object-cover opacity-60 group-hover:opacity-40 group-hover:scale-105 transition-all duration-500"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black via-black/50 to-transparent" />
                </>
              )}

              <div className="relative z-10 flex items-center justify-between w-full">
                <div className="flex flex-col gap-1 min-w-0">
                  <span className="text-sm font-bold text-white truncate drop-shadow-md">
                    {playlist.name}
                  </span>
                  <span className="text-[10px] text-gray-300 font-medium">
                    {playlist.tracks.length} tracks
                  </span>
                </div>

                <div className="w-8 h-8 rounded-full bg-accent text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all scale-75 group-hover:scale-100 shadow-lg">
                  <Play size={14} fill="currentColor" className="ml-0.5" />
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* --- COMPONENT C: AMBIENT TOGGLE --- */}
      <div className="z-20 mt-10 flex items-center gap-4 bg-white/5 px-6 py-3 rounded-full border border-white/5 backdrop-blur-md">
        <Moon size={16} className={dndEnabled ? 'text-accent' : 'text-gray-500'} />
        <span className={`text-xs font-bold uppercase tracking-widest ${dndEnabled ? 'text-indigo-200' : 'text-gray-500'}`}>
          Do Not Disturb
        </span>

        <button
          onClick={() => setDndEnabled(!dndEnabled)}
          className={`
            w-10 h-5 rounded-full relative transition-colors duration-300
            ${dndEnabled ? 'bg-[var(--accent-strong)]' : 'bg-gray-800'}
          `}
        >
          <div className={`
            absolute top-1 w-3 h-3 rounded-full bg-white transition-all duration-300 shadow-sm
            ${dndEnabled ? 'left-6' : 'left-1'}
          `} />
        </button>
      </div>

    </div>
  );
};
