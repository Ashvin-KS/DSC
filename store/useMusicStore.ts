import { create } from 'zustand';
import { LS_PLAYLISTS } from '../lib/constants';
import { useNotificationStore } from './useNotificationStore';

let initialMusicStatusMessage = '';

const getMusicErrorMessage = (error: unknown, fallback: string) => {
    if (error instanceof Error && error.message.trim()) {
        return error.message;
    }
    if (typeof error === 'string' && error.trim()) {
        return error;
    }
    return fallback;
};

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
    musicStatusMessage: string;
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
    setMusicStatusMessage: (message: string) => void;

    // Playlist Management
    createPlaylist: (name: string) => void;
    createPlaylistWithTracks: (name: string, tracks: Track[]) => Promise<number>;
    deletePlaylist: (id: number) => void;
    addTrackToPlaylist: (playlistId: number, track: Track) => void;
    removeTrackFromPlaylist: (playlistId: number, trackIndex: number) => void;

    // Engine Control Flags (used by UI to signal Engine)
    seekTo: number | null;
    setSeek: (time: number) => void;
    clearSeek: () => void;
}

const savePlaylistsToStorage = async (playlists: Playlist[]) => {
    localStorage.setItem(LS_PLAYLISTS, JSON.stringify(playlists));
    if (window.atheletiaAPI?.music?.savePlaylists) {
        await window.atheletiaAPI.music.savePlaylists(playlists);
    }
};

// Initial playlist migration
const migratePlaylists = () => {
    try {
        const current = localStorage.getItem(LS_PLAYLISTS);
        if (!current) {
            const legacy = localStorage.getItem('musicapp_playlists') || localStorage.getItem('allentire_playlists');
            if (legacy) {
                localStorage.setItem(LS_PLAYLISTS, legacy);
                localStorage.removeItem('musicapp_playlists');
                localStorage.removeItem('allentire_playlists');
            }
        }
    } catch (error) {
        initialMusicStatusMessage = `Failed to migrate music playlists: ${getMusicErrorMessage(error, 'Unknown error')}`;
    }
};
migratePlaylists();

const saveLibraryToStorage = async (library: MusicLibrary) => {
    localStorage.setItem('atheletia_music_library', JSON.stringify(library));
    if (window.atheletiaAPI?.music?.saveLibrary) {
        await window.atheletiaAPI.music.saveLibrary(library);
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
    musicStatusMessage: initialMusicStatusMessage,
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
    setMusicStatusMessage: (message) => set({ musicStatusMessage: message }),

    setActivePlaylist: (id) => {
        set({ activePlaylistId: id });
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

    toggleLike: async (track) => {
        const { likedSongs } = get();
        const isLiked = likedSongs.some(t => t.id === track.id);
        const newLikedSongs = isLiked
            ? likedSongs.filter(t => t.id !== track.id)
            : [...likedSongs, track];

        set({ likedSongs: newLikedSongs });
        try {
            await saveLibraryToStorage({ likedSongs: newLikedSongs, recentlyPlayed: get().recentlyPlayed });
            set({ musicStatusMessage: '' });
        } catch (error) {
            set({ musicStatusMessage: `Failed to save liked songs: ${getMusicErrorMessage(error, 'Unknown error')}` });
        }
    },

    addToRecentlyPlayed: async (track) => {
        const { recentlyPlayed, likedSongs } = get();
        // Remove if it's already there to move it to the front
        const filtered = recentlyPlayed.filter(t => t.id !== track.id);
        const newRecentlyPlayed = [track, ...filtered].slice(0, 50); // Cap at 50

        set({ recentlyPlayed: newRecentlyPlayed });
        try {
            await saveLibraryToStorage({ likedSongs, recentlyPlayed: newRecentlyPlayed });
            set({ musicStatusMessage: '' });
        } catch (error) {
            set({ musicStatusMessage: `Failed to save recently played: ${getMusicErrorMessage(error, 'Unknown error')}` });
        }
    },

    setSeek: (time) => set({ seekTo: time }),
    clearSeek: () => set({ seekTo: null }),

    // Playlist Management
    createPlaylist: async (name) => {
        const newPlaylist: Playlist = {
            id: Date.now(),
            name,
            tracks: []
        };
        const updatedPlaylists = [...get().playlists, newPlaylist];
        set({ playlists: updatedPlaylists });
        try {
            await savePlaylistsToStorage(updatedPlaylists);
            set({ musicStatusMessage: '' });
        } catch (error) {
            set({ musicStatusMessage: `Failed to save playlists: ${getMusicErrorMessage(error, 'Unknown error')}` });
        }
    },

    createPlaylistWithTracks: async (name, tracks) => {
        const uniqueTracks = tracks.filter((track, index, list) => (
            track?.id && list.findIndex((candidate) => candidate.id === track.id) === index
        ));
        const newPlaylist: Playlist = {
            id: Date.now(),
            name,
            tracks: uniqueTracks
        };
        const updatedPlaylists = [...get().playlists, newPlaylist];
        set({ playlists: updatedPlaylists, activePlaylistId: newPlaylist.id });
        if (uniqueTracks[0]) {
            get().setTrack(uniqueTracks[0], uniqueTracks, 0);
        }
        try {
            await savePlaylistsToStorage(updatedPlaylists);
            set({ musicStatusMessage: '' });
            useNotificationStore.getState().pushNotification({
                type: 'success',
                title: 'Playlist saved',
                message: `${newPlaylist.name} has ${uniqueTracks.length} tracks.`,
                source: 'music',
            });
        } catch (error) {
            set({ musicStatusMessage: `Failed to save playlist: ${getMusicErrorMessage(error, 'Unknown error')}` });
        }
        return newPlaylist.id;
    },

    deletePlaylist: async (id) => {
        const updatedPlaylists = get().playlists.filter(p => p.id !== id);
        set({ playlists: updatedPlaylists });
        if (get().activePlaylistId === id) {
            set({ activePlaylistId: null, currentTrack: null, isPlaying: false });
        }
        try {
            await savePlaylistsToStorage(updatedPlaylists);
            set({ musicStatusMessage: '' });
        } catch (error) {
            set({ musicStatusMessage: `Failed to delete playlist: ${getMusicErrorMessage(error, 'Unknown error')}` });
        }
    },

    addTrackToPlaylist: async (playlistId, track) => {
        const updatedPlaylists = get().playlists.map(p => {
            if (p.id === playlistId) {
                return { ...p, tracks: [...p.tracks, track] };
            }
            return p;
        });
        set({ playlists: updatedPlaylists });
        try {
            await savePlaylistsToStorage(updatedPlaylists);
            set({ musicStatusMessage: '' });
        } catch (error) {
            set({ musicStatusMessage: `Failed to add track: ${getMusicErrorMessage(error, 'Unknown error')}` });
        }
    },

    removeTrackFromPlaylist: async (playlistId, trackIndex) => {
        const updatedPlaylists = get().playlists.map(p => {
            if (p.id === playlistId) {
                return { ...p, tracks: p.tracks.filter((_, i) => i !== trackIndex) };
            }
            return p;
        });
        set({ playlists: updatedPlaylists });
        try {
            await savePlaylistsToStorage(updatedPlaylists);
            set({ musicStatusMessage: '' });
        } catch (error) {
            set({ musicStatusMessage: `Failed to remove track: ${getMusicErrorMessage(error, 'Unknown error')}` });
        }
    },
}));
