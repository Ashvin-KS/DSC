import { create } from 'zustand';
import { LS_PLAYLISTS } from '../lib/constants';

export interface Track {
    id: string;
    title: string;
    thumbnail: string;
}

export interface Playlist {
    id: number;
    name: string;
    tracks: Track[];
}

export interface MusicLibrary {
    likedSongs: Track[];
    recentlyPlayed: Track[];
}

interface MusicState {
    playlists: Playlist[];
    likedSongs: Track[];
    recentlyPlayed: Track[];
    queue: Track[]; // The active context array (search, liked, playlist)
    activePlaylistId: number | null;
    currentTrack: Track | null;
    currentIndex: number;
    isPlaying: boolean;
    duration: number;
    currentTime: number;
    volume: number;

    // Actions
    setPlaylists: (playlists: Playlist[]) => void;
    setLibrary: (library: MusicLibrary) => void;
    setActivePlaylist: (id: number) => void;
    setTrack: (track: Track, context: Track[], index: number) => void;
    play: () => void;
    pause: () => void;
    togglePlay: () => void;
    nextTrack: () => void;
    prevTrack: () => void;
    updateProgress: (currentTime: number, duration: number) => void;
    setVolume: (volume: number) => void;
    toggleLike: (track: Track) => void;
    addToRecentlyPlayed: (track: Track) => void;

    // Playlist Management
    createPlaylist: (name: string) => void;
    deletePlaylist: (id: number) => void;
    addTrackToPlaylist: (playlistId: number, track: Track) => void;
    removeTrackFromPlaylist: (playlistId: number, trackIndex: number) => void;

    // Engine Control Flags (used by UI to signal Engine)
    seekTo: number | null;
    setSeek: (time: number) => void;
    clearSeek: () => void;
}

const savePlaylistsToStorage = (playlists: Playlist[]) => {
    localStorage.setItem(LS_PLAYLISTS, JSON.stringify(playlists));
    if (window.atheletiaAPI?.music) {
        window.atheletiaAPI.music.savePlaylists(playlists).catch(console.error);
    }
};

// Initial playlist migration
const migratePlaylists = () => {
    const current = localStorage.getItem(LS_PLAYLISTS);
    if (!current) {
        const legacy = localStorage.getItem('musicapp_playlists') || localStorage.getItem('allentire_playlists');
        if (legacy) {
            localStorage.setItem(LS_PLAYLISTS, legacy);
            localStorage.removeItem('musicapp_playlists');
            localStorage.removeItem('allentire_playlists');
        }
    }
};
migratePlaylists();

const saveLibraryToStorage = (library: MusicLibrary) => {
    localStorage.setItem('atheletia_music_library', JSON.stringify(library));
    if (window.atheletiaAPI?.music) {
        window.atheletiaAPI.music.saveLibrary(library).catch(console.error);
    }
};

// Initial library load & migration
const getInitialLibrary = (): MusicLibrary => {
    try {
        const stored = localStorage.getItem('atheletia_music_library');
        if (stored) return JSON.parse(stored);

        // Migration
        const old = localStorage.getItem('nexus_music_library') || localStorage.getItem('allentire_music_library');
        if (old) {
            const data = JSON.parse(old);
            localStorage.setItem('atheletia_music_library', old);
            localStorage.removeItem('nexus_music_library');
            localStorage.removeItem('allentire_music_library');
            return data;
        }
    } catch (e) {
        console.warn('Failed to load music library storage', e);
    }
    return { likedSongs: [], recentlyPlayed: [] };
};

const initialLibrary = getInitialLibrary();

export const useMusicStore = create<MusicState>((set, get) => ({
    playlists: [],
    likedSongs: initialLibrary.likedSongs,
    recentlyPlayed: initialLibrary.recentlyPlayed,
    queue: [],
    activePlaylistId: null,
    currentTrack: null,
    currentIndex: 0,
    isPlaying: false,
    duration: 0,
    currentTime: 0,
    volume: 100,
    seekTo: null,

    setPlaylists: (playlists) => set({ playlists }),
    setLibrary: (library) => set({ likedSongs: library.likedSongs || [], recentlyPlayed: library.recentlyPlayed || [] }),

    setActivePlaylist: (id) => {
        set({ activePlaylistId: id });
        const playlist = get().playlists.find(p => p.id === id);
        if (playlist && playlist.tracks.length > 0) {
            get().setTrack(playlist.tracks[0], playlist.tracks, 0);
            get().play();
        }
    },

    setTrack: (track, context, index) => {
        set({ currentTrack: track, queue: context, currentIndex: index });
        get().addToRecentlyPlayed(track);
    },

    play: () => set({ isPlaying: true }),
    pause: () => set({ isPlaying: false }),
    togglePlay: () => set((state) => ({ isPlaying: !state.isPlaying })),

    nextTrack: () => {
        const { queue, currentIndex } = get();
        if (!queue || queue.length === 0) return;

        const nextIndex = (currentIndex + 1) % queue.length;
        const newTrack = queue[nextIndex];
        set({
            currentTrack: newTrack,
            currentIndex: nextIndex,
            isPlaying: true
        });
        get().addToRecentlyPlayed(newTrack);
    },

    prevTrack: () => {
        const { queue, currentIndex, currentTime } = get();
        if (!queue || queue.length === 0) return;

        if (currentTime > 3) {
            set({ seekTo: 0 });
            return;
        }

        const prevIndex = (currentIndex - 1 + queue.length) % queue.length;
        const newTrack = queue[prevIndex];
        set({
            currentTrack: newTrack,
            currentIndex: prevIndex,
            isPlaying: true
        });
        get().addToRecentlyPlayed(newTrack);
    },

    updateProgress: (currentTime, duration) => set({ currentTime, duration }),
    setVolume: (volume) => set({ volume }),

    toggleLike: (track) => {
        const { likedSongs } = get();
        const isLiked = likedSongs.some(t => t.id === track.id);
        const newLikedSongs = isLiked
            ? likedSongs.filter(t => t.id !== track.id)
            : [...likedSongs, track];

        set({ likedSongs: newLikedSongs });
        saveLibraryToStorage({ likedSongs: newLikedSongs, recentlyPlayed: get().recentlyPlayed });
    },

    addToRecentlyPlayed: (track) => {
        const { recentlyPlayed, likedSongs } = get();
        // Remove if it's already there to move it to the front
        const filtered = recentlyPlayed.filter(t => t.id !== track.id);
        const newRecentlyPlayed = [track, ...filtered].slice(0, 50); // Cap at 50

        set({ recentlyPlayed: newRecentlyPlayed });
        saveLibraryToStorage({ likedSongs, recentlyPlayed: newRecentlyPlayed });
    },

    setSeek: (time) => set({ seekTo: time }),
    clearSeek: () => set({ seekTo: null }),

    // Playlist Management
    createPlaylist: (name) => {
        const newPlaylist: Playlist = {
            id: Date.now(),
            name,
            tracks: []
        };
        const updatedPlaylists = [...get().playlists, newPlaylist];
        set({ playlists: updatedPlaylists });
        savePlaylistsToStorage(updatedPlaylists);
    },

    deletePlaylist: (id) => {
        const updatedPlaylists = get().playlists.filter(p => p.id !== id);
        set({ playlists: updatedPlaylists });
        if (get().activePlaylistId === id) {
            set({ activePlaylistId: null, currentTrack: null, isPlaying: false });
        }
        savePlaylistsToStorage(updatedPlaylists);
    },

    addTrackToPlaylist: (playlistId, track) => {
        const updatedPlaylists = get().playlists.map(p => {
            if (p.id === playlistId) {
                return { ...p, tracks: [...p.tracks, track] };
            }
            return p;
        });
        set({ playlists: updatedPlaylists });
        savePlaylistsToStorage(updatedPlaylists);
    },

    removeTrackFromPlaylist: (playlistId, trackIndex) => {
        const updatedPlaylists = get().playlists.map(p => {
            if (p.id === playlistId) {
                return { ...p, tracks: p.tracks.filter((_, i) => i !== trackIndex) };
            }
            return p;
        });
        set({ playlists: updatedPlaylists });
        savePlaylistsToStorage(updatedPlaylists);
    },
}));
