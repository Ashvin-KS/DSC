import React, { useRef, useEffect } from 'react';
import YouTube from 'react-youtube';
import { useMusicStore } from '../../store/useMusicStore';
import { usePlaylistLoader } from '../../hooks/usePlaylistLoader';
import { PLAYER_STATE } from '../../lib/constants';

export const MusicEngine: React.FC = () => {
    // Store
    const {
        setPlaylists,
        setLibrary,
        currentTrack,
        isPlaying,
        nextTrack,
        prevTrack,
        play,
        pause,
        togglePlay,
        updateProgress,
        seekTo,
        clearSeek,
        volume
    } = useMusicStore();

    const playerRef = useRef<any>(null);
    const intervalRef = useRef<number | null>(null);

    // Load playlists using custom hook
    usePlaylistLoader(setPlaylists, setLibrary);

    // Handle Play/Pause changes from Store
    useEffect(() => {
        if (!playerRef.current) return;
        if (isPlaying) {
            playerRef.current.playVideo();
            startTimer();
        } else {
            playerRef.current.pauseVideo();
            stopTimer();
        }
    }, [isPlaying]);

    // Handle Seek changes from Store
    useEffect(() => {
        if (seekTo !== null && playerRef.current) {
            playerRef.current.seekTo(seekTo, true);
            clearSeek();
        }
    }, [seekTo, clearSeek]);

    // Handle Volume changes from Store
    useEffect(() => {
        if (playerRef.current) {
            playerRef.current.setVolume(volume);
        }
    }, [volume]);

    // Player Event Handlers
    const onPlayerReady = (event: any) => {
        playerRef.current = event.target;
        playerRef.current.setVolume(volume);
        if (isPlaying) playerRef.current.playVideo();
    };

    const onPlayerStateChange = (event: any) => {
        const duration = playerRef.current?.getDuration() || 0;

        // Sync duration immediately
        updateProgress(playerRef.current?.getCurrentTime() || 0, duration);

        if (event.data === PLAYER_STATE.PLAYING) {
            if (!isPlaying) play(); // Sync store if player started internally
            startTimer();
        } else if (event.data === PLAYER_STATE.PAUSED || event.data === PLAYER_STATE.ENDED) {
            if (isPlaying && event.data === PLAYER_STATE.PAUSED) pause(); // Sync store if paused internally
            stopTimer();
        }

        if (event.data === PLAYER_STATE.ENDED) {
            nextTrack();
        }
    };

    const startTimer = () => {
        stopTimer();
        intervalRef.current = window.setInterval(() => {
            if (playerRef.current) {
                updateProgress(
                    playerRef.current.getCurrentTime(),
                    playerRef.current.getDuration()
                );
            }
        }, 500); // Update every 500ms
    };

    const stopTimer = () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
    };

    // Cleanup
    useEffect(() => () => stopTimer(), []);

    // Wire OS/browser media controls (keyboard media keys, lock screen controls, etc.).
    useEffect(() => {
        if (!('mediaSession' in navigator)) return;
        const mediaSession = navigator.mediaSession;
        try {
            mediaSession.setActionHandler('play', () => play());
            mediaSession.setActionHandler('pause', () => pause());
            mediaSession.setActionHandler('nexttrack', () => nextTrack());
            mediaSession.setActionHandler('previoustrack', () => prevTrack());
        } catch {
            // Some platforms do not support every action.
        }

        return () => {
            try {
                mediaSession.setActionHandler('play', null);
                mediaSession.setActionHandler('pause', null);
                mediaSession.setActionHandler('nexttrack', null);
                mediaSession.setActionHandler('previoustrack', null);
            } catch {
                // ignore cleanup failures on unsupported actions
            }
        };
    }, [play, pause, nextTrack, prevTrack]);

    // Fallback for environments that surface media keys as keyboard events.
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const key = (event.key || '').toLowerCase();
            if (key === 'mediatracknext' || key === 'audiotracknext') {
                event.preventDefault();
                nextTrack();
            } else if (key === 'mediatrackprevious' || key === 'audiotrackprevious') {
                event.preventDefault();
                prevTrack();
            } else if (key === 'mediaplaypause') {
                event.preventDefault();
                togglePlay();
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [nextTrack, prevTrack, togglePlay]);

    useEffect(() => {
        if (!('mediaSession' in navigator)) return;
        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }, [isPlaying]);

    useEffect(() => {
        if (!('mediaSession' in navigator) || !currentTrack || typeof MediaMetadata === 'undefined') return;
        navigator.mediaSession.metadata = new MediaMetadata({
            title: currentTrack.title,
            artist: 'Nexus Music',
            artwork: currentTrack.thumbnail
                ? [{ src: currentTrack.thumbnail, sizes: '512x512', type: 'image/jpeg' }]
                : []
        });
    }, [currentTrack]);

    if (!currentTrack) return null;

    return (
        <div style={{ position: 'absolute', top: -9999, left: -9999 }}>
            <YouTube
                videoId={currentTrack.id}
                opts={{ height: '1', width: '1', playerVars: { autoplay: 1, controls: 0 } }}
                onReady={onPlayerReady}
                onStateChange={onPlayerStateChange}
            />
        </div>
    );
};
