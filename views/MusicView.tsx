import React, { useState, useRef, useEffect } from 'react';
import { useMusicStore, Track } from '../store/useMusicStore';

import { Home, Search, Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Repeat, Shuffle, Plus, Trash2, Music, Heart, Clock } from 'lucide-react';
import './MusicApp.css';

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
    deletePlaylist,
    addTrackToPlaylist,
    removeTrackFromPlaylist,
    toggleLike,
  } = useMusicStore();

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

  const progressBarRef = useRef<HTMLDivElement>(null);

  // Search via Tauri backend to avoid CORS and ensure stability
  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setLoading(true);
    setCurrentView('search');
    try {
      if (window.atheletiaAPI?.music) {
        const results = await window.atheletiaAPI.music.search(searchQuery);
        setSearchResults(results);
      } else {
        console.warn('Music API not available on this platform.');
      }
    } catch (err) {
      console.error('Search failed', err);
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
    try {
      if (window.atheletiaAPI?.music) {
        const results = await window.atheletiaAPI.music.search(playlistSearchQuery);
        setPlaylistSearchResults(results);
      }
    } catch (err) {
      console.error('Playlist search failed', err);
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

            {currentView === 'home' && (
              <div style={{ padding: '24px' }}>
                <h2 style={{ fontSize: '32px', marginBottom: '24px' }}>Good afternoon</h2>

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

