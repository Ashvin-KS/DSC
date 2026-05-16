import React, { useState, useRef, useEffect } from 'react';
import { useMusicStore, Track } from '../store/useMusicStore';
import { StatusBanner } from '../components/ui/StatusBanner';
import { useIntentStore } from '../store/useIntentStore';
import { getProviderKey, resolveProviderForModel } from '../lib/modelFetch';
import {
  sendChatMessage as chatServiceSend,
  createChatSession as chatServiceCreateSession,
  deleteChatSession as chatServiceDeleteSession,
} from '../services/chatService';

import { Home, Search, Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Repeat, Shuffle, Plus, Trash2, Music, Heart, Clock, Wand2 } from 'lucide-react';
import './MusicApp.css';

const TASTE_STAGES = ['taste', 'search', 'build', 'saved'] as const;

const HISTORY_SEPARATOR_RE = /\s*(?:\u2014|\u2013|-)\s*/;
const TASTE_BASE_SOURCES = ['apps', 'screen', 'media'] as const;

const TASTE_PROMPT_STOPWORDS = new Set([
  'songs',
  'song',
  'music',
  'create',
  'make',
  'give',
  'playlist',
  'playlists',
  'mix',
  'track',
  'tracks',
  'official',
  'audio',
  'video',
  'lyrics',
  'lyric',
  'the',
  'a',
  'an',
  'of',
  'and',
  'or',
  'for',
  'to',
  'from',
  'with',
  'just',
  'but',
  'its',
  'my',
  'your',
  'me',
  'based',
  'heard',
  'hear',
  'listened',
  'listening',
  'history',
  'recent',
  'all',
  'time',
  'have',
  'i',
]);

const parseJsonArray = (text: string): string[] | null => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = fenced || text;
  const first = raw.indexOf('[');
  const last = raw.lastIndexOf(']');
  if (first < 0 || last <= first) return null;
  try {
    const parsed = JSON.parse(raw.slice(first, last + 1));
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : null;
  } catch {
    return null;
  }
};

const TASTE_SEARCH_QUERY_LIMIT = 80;
const TASTE_PLAYLIST_TRACK_LIMIT = 80;

const normalizeForSearchMatch = (value: string): string =>
  value
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const TASTE_NOISE_TERMS = [
  'playlist', 'jukebox', 'mix', 'hits', 'top', 'best', 'evergreen', 'all time',
  'radio', 'collections', 'collection', 'full album', 'songs',
];

const TASTE_RESULT_NOISE_TERMS = [
  'playlist', 'jukebox', 'mix', 'compilation', 'non stop', 'full album',
  'top ', 'best ', 'evergreen', 'medley',
];

const isTasteResultNoiseTitle = (normalizedTitle: string): boolean =>
  TASTE_RESULT_NOISE_TERMS.some((term) => normalizedTitle.includes(term));

const splitTasteHistoryEntry = (entry: string): { title: string; artist: string } => {
  const parts = entry.split(HISTORY_SEPARATOR_RE).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return { title: entry.trim(), artist: '' };
  return { title: parts[0], artist: parts.slice(1).join(' - ') };
};

const isTasteNoiseEntry = (entry: string): boolean => {
  const normalized = normalizeForSearchMatch(entry);
  if (!normalized) return true;
  if (entry.includes('|')) return true;
  return TASTE_NOISE_TERMS.some((term) => normalized.includes(term));
};

const toTasteSearchQuery = (entry: string): string | null => {
  const { title, artist } = splitTasteHistoryEntry(entry);
  if (!title || isTasteNoiseEntry(title)) return null;
  const normalizedArtist = normalizeForSearchMatch(artist);
  const isUnknownArtist = normalizedArtist === 'unknown artist' || normalizedArtist === 'unknown';
  if (artist && !isUnknownArtist && !isTasteNoiseEntry(artist)) return `${title} - ${artist}`;
  return title;
};

const dedupePreserveOrder = (values: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
};

const tastePromptTokens = (prompt: string): string[] =>
  prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !TASTE_PROMPT_STOPWORDS.has(token));

const rankTasteHistory = (history: string[], prompt: string): string[] => {
  const tokens = tastePromptTokens(prompt);
  if (tokens.length === 0) return history;

  return history
    .map((entry, index) => {
      const normalized = normalizeForSearchMatch(entry);
      const score = tokens.reduce((total, token) => total + (normalized.includes(token) ? 1 : 0), 0);
      return { entry, index, score };
    })
    .filter((item) => item.score > 0 && !isTasteNoiseEntry(item.entry))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.entry);
};

const scoreTasteSearchResult = (track: Track, query: string): number => {
  const title = normalizeForSearchMatch(track.title);
  const queryText = normalizeForSearchMatch(query);
  if (!title || !queryText) return 0;

  let score = 0;
  if (isTasteResultNoiseTitle(title)) {
    score -= 6;
  }

  const tokens = queryText
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !TASTE_PROMPT_STOPWORDS.has(token));

  if (title.includes(queryText) || queryText.includes(title)) score += 8;
  for (const token of tokens) {
    if (title.includes(token)) score += 1;
  }
  return score;
};

const pickFirstTasteSongResult = (tracks: Track[], query: string): Track | null => {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const queryTokens = normalizeForSearchMatch(query)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !TASTE_PROMPT_STOPWORDS.has(token));

  for (const track of tracks) {
    const title = normalizeForSearchMatch(track.title);
    if (!title) continue;
    if (isTasteResultNoiseTitle(title)) continue;
    if (queryTokens.length > 0 && !queryTokens.some((token) => title.includes(token))) continue;
    return track;
  }

  return pickBestTasteSearchResult(tracks, query);
};

const pickBestTasteSearchResult = (tracks: Track[], query: string): Track | null => {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const ranked = tracks
    .map((track, index) => ({ track, index, score: scoreTasteSearchResult(track, query) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked[0]?.track || null;
};

export const MusicView: React.FC = () => {
  const {
    playlists,
    likedSongs,
    recentlyPlayed,
    queue,
    activePlaylistId,
    currentTrack,
    currentIndex,
    isPlaying,
    duration,
    currentTime,
    setPlaylists,
    setLibrary,
    setActivePlaylist,
    setTrack,
    play,
    pause,
    togglePlay,
    nextTrack,
    prevTrack,
    volume,
    setVolume,
    setSeek,
    createPlaylist,
    createPlaylistWithTracks,
    deletePlaylist,
    addTrackToPlaylist,
    removeTrackFromPlaylist,
    toggleLike,
    musicStatusMessage,
    setMusicStatusMessage,
  } = useMusicStore();
  const settings = useIntentStore((s) => s.settings);

  const [currentView, setCurrentView] = useState('home');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false);
  const [isShuffle, setIsShuffle] = useState(false);
  const [isRepeat, setIsRepeat] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [previousVolume, setPreviousVolume] = useState(100);

  // Playlist Modal State
  const [showPlaylistModal, setShowPlaylistModal] = useState(false);
  const [trackToAdd, setTrackToAdd] = useState<Track | null>(null);

  // In-Playlist Search State
  const [playlistSearchQuery, setPlaylistSearchQuery] = useState('');
  const [playlistSearchResults, setPlaylistSearchResults] = useState<Track[]>([]);
  const [isPlaylistSearching, setIsPlaylistSearching] = useState(false);

  // UI state for creating playlist
  const [playlistNameInput, setPlaylistNameInput] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [tastePrompt, setTastePrompt] = useState('');
  const [tasteStage, setTasteStage] = useState<typeof TASTE_STAGES[number] | null>(null);
  const [tasteMessage, setTasteMessage] = useState('');
  const [tasteBusy, setTasteBusy] = useState(false);
  const [tasteTracks, setTasteTracks] = useState<Track[]>([]);

  const progressBarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const pendingPrompt = localStorage.getItem('atheletia_music_taste_prompt');
    if (pendingPrompt) {
      localStorage.removeItem('atheletia_music_taste_prompt');
      setTastePrompt(pendingPrompt);
      setCurrentView('taste');
    }
    const onTastePrompt = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      setTastePrompt(detail || 'Deep focus mix with instrumental tracks');
      setCurrentView('taste');
    };
    window.addEventListener('atheletia:music-taste-prompt', onTastePrompt);
    return () => window.removeEventListener('atheletia:music-taste-prompt', onTastePrompt);
  }, []);

  // Search via Tauri backend to avoid CORS and ensure stability
  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setLoading(true);
    setCurrentView('search');
    setMusicStatusMessage('');
    try {
      if (window.atheletiaAPI?.music?.search) {
        const results = await window.atheletiaAPI.music.search(searchQuery);
        setSearchResults(results);
      } else {
        setMusicStatusMessage('Music search is unavailable in this runtime.');
      }
    } catch (err) {
      console.error('Search failed', err);
      setMusicStatusMessage(err instanceof Error ? err.message : 'Music search failed.');
    }
    setLoading(false);
  };

  const handleNext = () => {
    if (isShuffle) {
      if (queue && queue.length > 0) {
        const randomIndex = Math.floor(Math.random() * queue.length);
        setTrack(queue[randomIndex], queue, randomIndex);
        play();
      }
    } else {
      nextTrack();
    }
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressBarRef.current) return;
    const rect = progressBarRef.current.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    setSeek(percent * duration);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseInt(e.target.value);
    setVolume(v);
    if (v > 0) {
      setIsMuted(false);
      setPreviousVolume(v);
    }
  };

  const toggleMute = () => {
    if (isMuted) {
      setVolume(previousVolume || 50);
      setIsMuted(false);
    } else {
      setPreviousVolume(volume);
      setVolume(0);
      setIsMuted(true);
    }
  };

  const formatTime = (t: number) => {
    if (isNaN(t)) return '0:00';
    return `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}`;
  };

  const activePlaylist = playlists.find(p => p.id === activePlaylistId);

  const handleAddToPlaylist = (track: Track) => {
    setTrackToAdd(track);
    setShowPlaylistModal(true);
  };

  const executeAddTrack = (playlistId: number) => {
    if (trackToAdd) {
      addTrackToPlaylist(playlistId, trackToAdd);
      setShowPlaylistModal(false);
      setTrackToAdd(null);
    }
  };

  const handlePlaylistSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!playlistSearchQuery.trim()) return;
    setIsPlaylistSearching(true);
    setMusicStatusMessage('');
    try {
      if (window.atheletiaAPI?.music?.search) {
        const results = await window.atheletiaAPI.music.search(playlistSearchQuery);
        setPlaylistSearchResults(results);
      } else {
        setMusicStatusMessage('Playlist search is unavailable in this runtime.');
      }
    } catch (err) {
      console.error('Playlist search failed', err);
      setMusicStatusMessage(err instanceof Error ? err.message : 'Playlist search failed.');
    }
    setIsPlaylistSearching(false);
  };

  const handleCreatePlaylistSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (playlistNameInput.trim()) {
      createPlaylist(playlistNameInput.trim());
      setPlaylistNameInput('');
      setShowCreateForm(false);
    }
  };

  const handleGenerateTaste = async () => {
    if (!tastePrompt.trim() || tasteBusy) return;
    setTasteBusy(true);
    setTasteTracks([]);
    setMusicStatusMessage('');
    const advance = (stage: typeof TASTE_STAGES[number], message: string) => {
      setTasteStage(stage);
      setTasteMessage(message);
    };
    try {
      advance('taste', 'Asking AI via Chat agent...');
      const model = (settings as any)?.defaultModel || (settings as any)?.ai?.model || 'meta/llama-3.3-70b-instruct';
      const provider = resolveProviderForModel(model, (settings as any)?.defaultProvider || (settings as any)?.ai?.provider, 'nvidia');
      const apiKey = getProviderKey(settings as any, provider)
        || getProviderKey(settings as any, 'openai')
        || getProviderKey(settings as any, 'nvidia')
        || getProviderKey(settings as any, 'anthropic')
        || getProviderKey(settings as any, 'groq')
        || getProviderKey(settings as any, 'gemini')
        || '';

      const session = await chatServiceCreateSession();
      const sessionId = session?.id || (session as any);
      if (!sessionId) throw new Error('Could not create chat session.');

      type TasteAssistantAction = {
        kind?: string;
        suggested_time_range?: string | null;
        enable_sources?: string[];
        retry_message?: string;
      };

      // Same marker contract as ChatPage.parseAssistantAction.
      const parseAction = (text: string): { clean: string; action: TasteAssistantAction | null } => {
        const marker = /\[\[IF_ACTION:(\{[\s\S]*\})\]\]/m;
        const match = text.match(marker);
        if (!match) return { clean: text, action: null };
        let action: TasteAssistantAction | null = null;
        try { action = JSON.parse(match[1]) as TasteAssistantAction; } catch { /* ignore */ }
        return { clean: text.replace(marker, '').trim(), action };
      };

      const normalizeTasteSources = (sources?: string[]): string[] =>
        (sources || []).filter((source) =>
          ['apps', 'screen', 'media', 'browser', 'files'].includes(String(source).trim().toLowerCase())
        );

      // --- Helper: extract text after tool-call JSON blocks ---
      const extractAnswer = (content: string): string => {
        let depth = 0, inStr = false, esc = false, lastClosed = -1;
        for (let i = 0; i < content.length; i++) {
          const ch = content[i];
          if (inStr) { if (esc) { esc = false; continue; } if (ch === '\\') { esc = true; continue; } if (ch === '"') inStr = false; continue; }
          if (ch === '"') { inStr = true; continue; }
          if (ch === '{') { depth++; continue; }
          if (ch === '}' && depth > 0) { depth--; if (depth === 0) lastClosed = i; continue; }
        }
        if (lastClosed < 0) return content;
        return content.slice(lastClosed + 1).trim();
      };

      // --- Helper: try all parsing strategies on response text ---
      const extractSongsFromText = (text: string): string[] => {
        // Strategy 1: parse from answer tail (after tool-call JSON)
        const tail = extractAnswer(text);
        const fromTail = parseJsonArray(tail);
        if (fromTail && fromTail.length > 0) return fromTail;

        // Strategy 2: parse from full text (response may not have tool-call blocks)
        const fromFull = parseJsonArray(text);
        if (fromFull && fromFull.length > 0) return fromFull;

        return [];
      };

      const chatPrompt = `You are a precise music curator. The user wants songs matching: "${tastePrompt.trim()}". Use the music/media history tools to retrieve the user's listened songs. From those results, find ALL songs that match the user's request. Return ONLY a JSON array of strings in the format ["Song Title - Artist", ...]. Do not include markdown formatting, explanations, code fences, or any other text. Output ONLY the pure JSON array.`;
      const baseSources = [...TASTE_BASE_SOURCES];
      let response = await chatServiceSend(
        sessionId,
        chatPrompt,
        model,
        provider,
        'all_time',
        baseSources as any,
        apiKey
      );

      let rawText = typeof response === 'string' ? response : (response?.content || '');
      console.log('[TasteAI] Raw response:', rawText);
      let { clean, action } = parseAction(rawText);
      console.log('[TasteAI] Cleaned text:', clean);

      const needsScopeRetry =
        action?.kind === 'confirm_scope_or_sources'
        || rawText.includes('[[IF_ACTION:')
        || /additional sources enabled/i.test(rawText);

      if (needsScopeRetry) {
        console.log('[TasteAI] Scope action:', action);
        advance('taste', 'Confirming Chat scope and retrying...');

        const enabledSources = normalizeTasteSources(action?.enable_sources);
        const retrySources = Array.from(new Set([...baseSources, ...enabledSources]));
        const retryTimeRange = action?.suggested_time_range || 'all_time';
        const retryMessage: string = action?.retry_message || chatPrompt;

        response = await chatServiceSend(
          sessionId,
          retryMessage,
          model,
          provider,
          retryTimeRange,
          retrySources as any,
          apiKey
        );

        rawText = typeof response === 'string' ? response : (response?.content || '');
        console.log('[TasteAI] Raw retry response:', rawText);
        const parsed2 = parseAction(rawText);
        clean = parsed2.clean;
        action = parsed2.action;
        console.log('[TasteAI] Cleaned retry text:', clean);
      }

      chatServiceDeleteSession(sessionId).catch(() => {});

      const queries = dedupePreserveOrder(extractSongsFromText(clean));
      console.log('[TasteAI] Parsed songs:', queries);
      advance('taste', `AI found ${queries.length} matching songs`);

      if (queries.length === 0) {
        const preview = rawText.slice(0, 300).replace(/\n/g, ' ');
        throw new Error(`Taste AI: no songs parsed. AI responded: "${preview}"`);
      }

      const searchQueries = dedupePreserveOrder(
        (queries ?? [])
          .map((entry) => toTasteSearchQuery(entry))
          .filter((entry): entry is string => Boolean(entry))
      ).slice(0, TASTE_SEARCH_QUERY_LIMIT);

      advance('search', `Searching YouTube for ${searchQueries.length} tracks`);
      const found: Track[] = [];
      const batchSize = 5;
      for (let i = 0; i < searchQueries.length; i += batchSize) {
        const batch = searchQueries.slice(i, i + batchSize);
        const batchResults = await Promise.allSettled(
          batch.map((query) => window.atheletiaAPI?.music?.search?.(query) || Promise.resolve([]))
        );
        for (let resultIndex = 0; resultIndex < batchResults.length; resultIndex += 1) {
          const result = batchResults[resultIndex];
          if (result.status !== 'fulfilled') continue;
          const tracks = result.value;
          if (!Array.isArray(tracks)) continue;
          const track = pickFirstTasteSongResult(tracks, batch[resultIndex]);
          if (track?.id && !found.some((item) => item.id === track.id)) {
            found.push(track);
          }
        }
        setTasteTracks(found.slice(0, TASTE_PLAYLIST_TRACK_LIMIT));
        if (found.length >= TASTE_PLAYLIST_TRACK_LIMIT) break;
      }

      advance('build', 'Building the playlist');
      const tracks = found.slice(0, TASTE_PLAYLIST_TRACK_LIMIT);
      if (tracks.length === 0) {
        throw new Error('No tracks were found for that taste prompt.');
      }
      const name = `Taste AI - ${tastePrompt.trim().slice(0, 32)}`;
      const id = await createPlaylistWithTracks(name, tracks);
      setActivePlaylist(id);
      setCurrentView('playlist');
      advance('saved', 'Saved. Press play to start');
    } catch (err) {
      console.error('Taste AI failed', err);
      setMusicStatusMessage(err instanceof Error ? err.message : String(err) || 'Taste AI playlist generation failed.');
      setTasteStage(null);
    } finally {
      setTasteBusy(false);
    }
  };

  return (
    <div className="music-app">
      <div className="app-container">
        <div className="main-wrapper">

          {/* LEFT SIDEBAR */}
          <div className="left-sidebar">
            <div className="nav-section">

              <div
                className={`nav-item ${currentView === 'home' ? 'active' : ''}`}
                onClick={() => setCurrentView('home')}
              >
                <Home size={24} /> UI Home
              </div>
              <div
                className={`nav-item ${currentView === 'search' ? 'active' : ''}`}
                onClick={() => { setCurrentView('search'); document.getElementById('search-input')?.focus(); }}
              >
                <Search size={24} /> Search UI
              </div>
              <div
                className={`nav-item ${currentView === 'taste' ? 'active' : ''}`}
                onClick={() => setCurrentView('taste')}
              >
                <Wand2 size={24} /> Taste AI
              </div>
            </div>

            <div className="library-section">
              <div className="library-header">
                <h3><Music size={18} /> Your Library</h3>
                <button onClick={() => setShowCreateForm(true)}><Plus size={18} /></button>
              </div>

              {showCreateForm && (
                <form className="create-form" onSubmit={handleCreatePlaylistSubmit}>
                  <input
                    type="text"
                    placeholder="Playlist Name"
                    value={playlistNameInput}
                    onChange={(e) => setPlaylistNameInput(e.target.value)}
                    autoFocus
                  />
                  <div className="create-form-buttons">
                    <button type="button" className="btn-cancel" onClick={() => setShowCreateForm(false)}>Cancel</button>
                    <button type="submit" className="btn-create">Create</button>
                  </div>
                </form>
              )}

              <div className="playlist-list">
                <div
                  className={`playlist-item ${currentView === 'liked' ? 'active' : ''}`}
                  onClick={() => setCurrentView('liked')}
                >
                  <div className="icon-box liked">
                    <Heart size={20} fill="currentColor" />
                  </div>
                  <div className="playlist-info">
                    <h4>Liked Songs</h4>
                    <span>Playlist • {likedSongs.length} songs</span>
                  </div>
                </div>

                <div
                  className={`playlist-item ${currentView === 'recent' ? 'active' : ''}`}
                  onClick={() => setCurrentView('recent')}
                >
                  <div className="icon-box recent">
                    <Clock size={20} />
                  </div>
                  <div className="playlist-info">
                    <h4>Recently Played</h4>
                    <span>History • {recentlyPlayed.length} songs</span>
                  </div>
                </div>

                {playlists.map(p => (
                  <div
                    key={p.id}
                    className={`playlist-item ${activePlaylistId === p.id ? 'active' : ''}`}
                    onClick={() => { setActivePlaylist(p.id); setCurrentView('playlist'); }}
                  >
                    <img src={p.tracks[0]?.thumbnail || 'https://via.placeholder.com/180'} alt="" />
                    <div className="playlist-info">
                      <h4>{p.name}</h4>
                      <span>Playlist • {p.tracks.length} songs</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* MAIN VIEW */}
          <div className="main-view">
            {musicStatusMessage && (
              <div style={{ padding: '16px 24px 0 24px' }}>
                <StatusBanner
                  tone="error"
                  title="Music action failed"
                  message={musicStatusMessage}
                  action={
                    <button
                      onClick={() => setMusicStatusMessage('')}
                      className="rounded-md border border-red-400/30 px-2.5 py-1 text-xs text-red-100 hover:bg-red-500/15"
                    >
                      Dismiss
                    </button>
                  }
                />
              </div>
            )}

            <div className="top-bar">
              <form onSubmit={handleSearch} className="search-container">
                <Search size={20} color="#b3b3b3" />
                <input
                  id="search-input"
                  type="text"
                  placeholder="What do you want to play?"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </form>
            </div>

            {(currentView === 'home' || currentView === 'taste') && (
              <div style={{ padding: '24px' }}>
                <h2 style={{ fontSize: '32px', marginBottom: '24px' }}>Good afternoon</h2>

                <div style={{ marginBottom: '28px', border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.035)', borderRadius: '8px', padding: '16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', marginBottom: '12px' }}>
                    <div>
                      <h3 style={{ fontSize: '20px', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}><Wand2 size={20} /> Taste AI</h3>
                      <p style={{ color: '#9ca3af', margin: '4px 0 0', fontSize: '13px' }}>Prompt a vibe. It uses your all-time listened music, searches YouTube, and saves a playlist.</p>
                    </div>
                    <button
                      onClick={handleGenerateTaste}
                      disabled={tasteBusy || !tastePrompt.trim()}
                      className="btn-add-tag"
                      style={{ minWidth: '130px', opacity: tasteBusy || !tastePrompt.trim() ? 0.5 : 1 }}
                    >
                      {tasteBusy ? 'Generating' : 'Generate'}
                    </button>
                  </div>
                  <input
                    value={tastePrompt}
                    onChange={(event) => setTastePrompt(event.target.value)}
                    placeholder="e.g. gym drill energy, late night coding, UK indie nostalgia"
                    style={{ width: '100%', border: '1px solid rgba(255,255,255,0.1)', background: '#111', color: '#fff', borderRadius: '6px', padding: '12px', outline: 'none' }}
                  />
                  {(tasteStage || tasteTracks.length > 0) && (
                    <div style={{ marginTop: '14px' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${TASTE_STAGES.length}, minmax(0, 1fr))`, gap: '6px' }}>
                        {TASTE_STAGES.map((stage, index) => {
                          const currentIndex = tasteStage ? TASTE_STAGES.indexOf(tasteStage) : -1;
                          const active = index <= currentIndex;
                          return (
                            <div key={stage} style={{ height: '6px', borderRadius: '999px', background: active ? '#1ed760' : 'rgba(255,255,255,0.1)' }} />
                          );
                        })}
                      </div>
                      <div style={{ marginTop: '8px', color: '#b3b3b3', fontSize: '12px' }}>{tasteMessage}</div>
                      {tasteTracks.length > 0 && (
                        <div style={{ marginTop: '10px', display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '4px' }}>
                          {tasteTracks.slice(0, 8).map((track) => (
                            <img key={track.id} src={track.thumbnail} alt="" style={{ width: '44px', height: '44px', borderRadius: '4px', objectFit: 'cover' }} />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {recentlyPlayed.length > 0 && (
                  <div className="results-grid" style={{ marginBottom: '32px' }}>
                    {recentlyPlayed.slice(0, 6).map((track, idx) => (
                      <div
                        key={`recent-${track.id}-${idx}`}
                        className="recent-grid-item"
                        onClick={() => { setTrack(track, recentlyPlayed, idx); play(); }}
                      >
                        <img src={track.thumbnail} alt="" />
                        <h4>{track.title}</h4>
                        <button className="play-btn">
                          <Play size={20} fill="currentColor" className="ml-0.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <h3 style={{ fontSize: '24px', marginBottom: '16px' }}>Your Playlists</h3>
                {playlists.length > 0 ? (
                  <div className="results-grid">
                    {playlists.map(p => (
                      <div
                        key={p.id}
                        className="result-card"
                        onClick={() => { setActivePlaylist(p.id); setCurrentView('playlist'); }}
                      >
                        <div className="thumb-wrap">
                          <img src={p.tracks[0]?.thumbnail || 'https://via.placeholder.com/180'} alt="" />
                        </div>
                        <h4>{p.name}</h4>
                        <span className="subtitle">Playlist • {p.tracks.length} songs</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ color: '#b3b3b3' }}>No playlists yet. Create one in the sidebar!</p>
                )}
              </div>
            )}

            {currentView === 'search' && (
              <div className="search-results" style={{ padding: '24px 0' }}>
                <h2 style={{ padding: '0 24px', marginBottom: '16px' }}>{loading ? 'Searching...' : 'Search Results'}</h2>
                {!loading && searchResults.length > 0 && (
                  <table className="track-table">
                    <thead>
                      <tr>
                        <th className="index-col">#</th>
                        <th>Title</th>
                        <th style={{ width: '40px' }}></th>
                        <th style={{ width: '40px' }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {searchResults.map((track, index) => {
                        const isLiked = likedSongs.some(t => t.id === track.id);
                        return (
                          <tr
                            key={`search-${track.id}-${index}`}
                            className={`track-row ${currentTrack?.id === track.id ? 'active' : ''}`}
                          >
                            <td className="index-col" onClick={() => { setTrack(track, searchResults, index); play(); }}>
                              {currentTrack?.id === track.id && isPlaying ? <span style={{ color: '#1ed760' }}>♪</span> : index + 1}
                            </td>
                            <td onClick={() => { setTrack(track, searchResults, index); play(); }}>
                              <div className="title-col">
                                <img src={track.thumbnail} alt="" className="track-thumb" />
                                <div>
                                  <p className="track-title">{track.title}</p>
                                </div>
                              </div>
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <button
                                className={`heart-btn ${isLiked ? 'liked' : ''}`}
                                onClick={(e) => { e.stopPropagation(); toggleLike(track); }}
                                title="Like"
                              >
                                <Heart size={16} fill={isLiked ? 'currentColor' : 'none'} />
                              </button>
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <button
                                className="action-icon"
                                onClick={(e) => { e.stopPropagation(); handleAddToPlaylist(track); }}
                                title="Add to Active Playlist"
                                style={{ padding: '6px' }}
                              >
                                <Plus size={18} />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {currentView === 'playlist' && activePlaylist && (
              <div>
                <div className="playlist-header">
                  <img className="header-cover" src={activePlaylist.tracks[0]?.thumbnail || 'https://via.placeholder.com/180'} alt="" />
                  <div className="header-info">
                    <p className="type-text">Playlist</p>
                    <h1 className="playlist-name">{activePlaylist.name}</h1>
                    <p className="owner-info">{activePlaylist.tracks.length} songs</p>
                  </div>
                </div>

                <div className="action-bar">
                  <button className="btn-play-large" onClick={() => { if (activePlaylist.tracks.length > 0) { setTrack(activePlaylist.tracks[0], activePlaylist.tracks, 0); play(); } }}>
                    <Play size={28} fill="currentColor" className="ml-1" />
                  </button>
                  <button className="action-icon" onClick={() => deletePlaylist(activePlaylist.id)} title="Delete Playlist">
                    <Trash2 size={24} />
                  </button>
                </div>

                <table className="track-table">
                  <thead>
                    <tr>
                      <th className="index-col">#</th>
                      <th>Title</th>
                      <th style={{ width: '40px' }}></th>
                      <th style={{ width: '80px', textAlign: 'center' }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activePlaylist.tracks.map((track, index) => {
                      const isLiked = likedSongs.some(t => t.id === track.id);
                      return (
                        <tr
                          key={`${track.id}-${index}`}
                          className={`track-row ${currentTrack?.id === track.id ? 'active' : ''}`}
                        >
                          <td className="index-col" onClick={() => { setTrack(track, activePlaylist.tracks, index); play(); }}>
                            {currentTrack?.id === track.id && isPlaying ? <span style={{ color: '#1ed760' }}>♪</span> : index + 1}
                          </td>
                          <td onClick={() => { setTrack(track, activePlaylist.tracks, index); play(); }}>
                            <div className="title-col">
                              <img src={track.thumbnail} alt="" className="track-thumb" />
                              <div>
                                <p className="track-title">{track.title}</p>
                              </div>
                            </div>
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <button
                              className={`heart-btn ${isLiked ? 'liked' : ''}`}
                              onClick={(e) => { e.stopPropagation(); toggleLike(track); }}
                            >
                              <Heart size={16} fill={isLiked ? 'currentColor' : 'none'} />
                            </button>
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <button
                              onClick={(e) => { e.stopPropagation(); removeTrackFromPlaylist(activePlaylist.id, index); }}
                              style={{ background: 'transparent', border: 'none', color: '#666', cursor: 'pointer' }}
                            >
                              <Trash2 size={16} />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>

                <div className="in-playlist-search-container">
                  <h2>Let's find something for your playlist</h2>
                  <form onSubmit={handlePlaylistSearch} className="in-playlist-search-bar">
                    <Search size={20} color="#b3b3b3" />
                    <input
                      type="text"
                      placeholder="Search for songs or episodes"
                      value={playlistSearchQuery}
                      onChange={(e) => setPlaylistSearchQuery(e.target.value)}
                    />
                  </form>
                  {isPlaylistSearching && <p style={{ color: '#b3b3b3' }}>Searching...</p>}
                  {!isPlaylistSearching && playlistSearchResults.length > 0 && (
                    <table className="track-table">
                      <tbody>
                        {playlistSearchResults.map((track, idx) => (
                          <tr key={`pl-search-${track.id}-${idx}`} className="track-row">
                            <td>
                              <div className="title-col">
                                <img src={track.thumbnail} alt="" className="track-thumb" />
                                <div>
                                  <p className="track-title">{track.title}</p>
                                </div>
                              </div>
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <button
                                className="btn-add-tag"
                                onClick={() => addTrackToPlaylist(activePlaylist.id, track)}
                              >
                                Add
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            )}

            {(currentView === 'liked' || currentView === 'recent') && (
              <div>
                <div className="playlist-header">
                  <div className={`header-cover static-cover ${currentView === 'liked' ? 'liked' : 'recent'}`}>
                    {currentView === 'liked' ? <Heart size={64} fill="currentColor" /> : <Clock size={64} />}
                  </div>
                  <div className="header-info">
                    <p className="type-text">{currentView === 'liked' ? 'Playlist' : 'History'}</p>
                    <h1 className="playlist-name">{currentView === 'liked' ? 'Liked Songs' : 'Recently Played'}</h1>
                    <p className="owner-info">{(currentView === 'liked' ? likedSongs : recentlyPlayed).length} songs</p>
                  </div>
                </div>

                <div className="action-bar">
                  <button className="btn-play-large" onClick={() => {
                    const list = currentView === 'liked' ? likedSongs : recentlyPlayed;
                    if (list.length > 0) { setTrack(list[0], list, 0); play(); }
                  }}>
                    <Play size={28} fill="currentColor" className="ml-1" />
                  </button>
                </div>

                <table className="track-table">
                  <thead>
                    <tr>
                      <th className="index-col">#</th>
                      <th>Title</th>
                      <th style={{ width: '40px' }}></th>
                      <th style={{ width: '40px' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(currentView === 'liked' ? likedSongs : recentlyPlayed).map((track, index) => {
                      const isLiked = likedSongs.some(t => t.id === track.id);
                      const contextList = currentView === 'liked' ? likedSongs : recentlyPlayed;
                      return (
                        <tr
                          key={`${track.id}-${index}`}
                          className={`track-row ${currentTrack?.id === track.id ? 'active' : ''}`}
                        >
                          <td className="index-col" onClick={() => { setTrack(track, contextList, index); play(); }}>
                            {currentTrack?.id === track.id && isPlaying ? <span style={{ color: '#1ed760' }}>♪</span> : index + 1}
                          </td>
                          <td onClick={() => { setTrack(track, contextList, index); play(); }}>
                            <div className="title-col">
                              <img src={track.thumbnail} alt="" className="track-thumb" />
                              <div>
                                <p className="track-title">{track.title}</p>
                              </div>
                            </div>
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <button
                              className={`heart-btn ${isLiked ? 'liked' : ''}`}
                              onClick={(e) => { e.stopPropagation(); toggleLike(track); }}
                            >
                              <Heart size={16} fill={isLiked ? 'currentColor' : 'none'} />
                            </button>
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <button
                              className="action-icon"
                              onClick={(e) => { e.stopPropagation(); handleAddToPlaylist(track); }}
                              title="Add to Playlist"
                              style={{ padding: '6px' }}
                            >
                              <Plus size={18} />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* RIGHT SIDEBAR */}
          <div className="right-sidebar">
            {currentTrack ? (
              <div className="artist-card">
                <img src={currentTrack.thumbnail} alt="" />
                <div className="artist-card-content">
                  <h3>{currentTrack.title}</h3>
                  <p>Up Next</p>
                </div>
              </div>
            ) : (
              <div style={{ color: '#b3b3b3', textAlign: 'center', marginTop: '40px' }}>
                No track loaded
              </div>
            )}
          </div>
        </div>

        {/* PLAYLIST MODAL */}
        {showPlaylistModal && (
          <div className="playlist-modal-overlay" onClick={() => { setShowPlaylistModal(false); setTrackToAdd(null); }}>
            <div className="playlist-modal" onClick={(e) => e.stopPropagation()}>
              <h3>Add to playlist</h3>
              <div className="modal-playlist-list">
                {playlists.length === 0 ? (
                  <p style={{ color: '#b3b3b3', textAlign: 'center' }}>No playlists yet. Create one on the left!</p>
                ) : (
                  playlists.map(p => (
                    <div key={p.id} className="modal-playlist-item" onClick={() => executeAddTrack(p.id)}>
                      <img src={p.tracks[0]?.thumbnail || 'https://via.placeholder.com/180'} alt="" />
                      <span>{p.name}</span>
                    </div>
                  ))
                )}
              </div>
              <button className="btn-close-modal" onClick={() => { setShowPlaylistModal(false); setTrackToAdd(null); }}>Close</button>
            </div>
          </div>
        )}

        {/* PLAYBAR */}
        <div className="playbar">
          <div className="track-info-bar">
            {currentTrack && (() => {
              const isLiked = likedSongs.some(t => t.id === currentTrack.id);
              return (
                <>
                  <img src={currentTrack.thumbnail} alt="" />
                  <div style={{ marginRight: '16px' }}>
                    <span style={{ display: 'block', color: '#fff', fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '160px' }}>{currentTrack.title}</span>
                    <span style={{ display: 'block', color: '#b3b3b3', fontSize: '12px' }}>{activePlaylist?.name || 'Local'}</span>
                  </div>
                  <button
                    className={`heart-btn ${isLiked ? 'liked' : ''}`}
                    onClick={() => toggleLike(currentTrack)}
                    style={{ marginLeft: 'auto' }}
                  >
                    <Heart size={16} fill={isLiked ? 'currentColor' : 'none'} />
                  </button>
                </>
              )
            })()}
          </div>

          <div className="playbar-controls">
            <div className="control-buttons">
              <button className={`control-btn ${isShuffle ? 'active' : ''}`} onClick={() => setIsShuffle(!isShuffle)}>
                <Shuffle size={18} color={isShuffle ? '#1ed760' : '#b3b3b3'} />
              </button>
              <button className="control-btn" onClick={prevTrack}>
                <SkipBack size={24} fill="currentColor" />
              </button>
              <button className="control-btn main" onClick={togglePlay}>
                {isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" className="ml-1" />}
              </button>
              <button className="control-btn" onClick={handleNext}>
                <SkipForward size={24} fill="currentColor" />
              </button>
              <button className={`control-btn ${isRepeat ? 'active' : ''}`} onClick={() => setIsRepeat(!isRepeat)}>
                <Repeat size={18} color={isRepeat ? '#1ed760' : '#b3b3b3'} />
              </button>
            </div>
            <div className="progress-section">
              <span className="time-display" style={{ textAlign: 'right' }}>{formatTime(currentTime)}</span>
              <div className="progress-bar" ref={progressBarRef} onClick={handleProgressClick}>
                <div className="progress" style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}></div>
              </div>
              <span className="time-display">{formatTime(duration)}</span>
            </div>
          </div>

          <div className="volume-section">
            <button className="control-btn" onClick={toggleMute}>
              {isMuted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            <input
              type="range"
              min="0"
              max="100"
              value={isMuted ? 0 : volume}
              onChange={handleVolumeChange}
              className="volume-slider"
              style={{ accentColor: '#1ed760' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

