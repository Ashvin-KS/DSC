import { useEffect } from 'react';
import { LS_PLAYLISTS } from '../lib/constants';
import { Playlist, MusicLibrary } from '../store/useMusicStore';

export const usePlaylistLoader = (
    setPlaylists: (playlists: Playlist[]) => void,
    setLibrary: (library: MusicLibrary) => void
) => {
    useEffect(() => {
        let mounted = true;
        const loadData = async () => {
            try {
                if (window.atheletiaAPI?.music) {
                    // Load Playlists
                    const pData = await window.atheletiaAPI.music.getPlaylists();
                    if (mounted && Array.isArray(pData) && pData.length > 0) {
                        setPlaylists(pData);
                    }

                    // Load Library (Liked & Recent)
                    const lData = await window.atheletiaAPI.music.getLibrary();
                    if (mounted && lData) {
                        setLibrary({
                            likedSongs: lData.likedSongs || [],
                            recentlyPlayed: lData.recentlyPlayed || []
                        });
                    }
                    return;
                }
            } catch (err) {
                console.error('Failed to load music data from IPC', err);
            }

            if (!mounted) return;

            // Fallback to localStorage
            const savedP = localStorage.getItem(LS_PLAYLISTS);
            if (savedP) {
                try { setPlaylists(JSON.parse(savedP)); } catch { /* ignore corrupt data */ }
            }

            const savedL = localStorage.getItem('atheletia_music_library') || localStorage.getItem('nexus_music_library');
            if (savedL) {
                try { setLibrary(JSON.parse(savedL)); } catch { /* ignore corrupt data */ }
            }
        };
        loadData();
        return () => { mounted = false; };
    }, [setPlaylists, setLibrary]);
};
