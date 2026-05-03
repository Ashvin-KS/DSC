import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useNavStore } from './store/useNavStore';

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

interface MutationResult {
  success: boolean;
  path?: string;
  newPath?: string;
  error?: string;
}

interface VaultIndexStats {
  indexed_files: number;
  indexed_chunks: number;
  vault_path: string;
  cancelled: boolean;
}

interface VaultSearchHit {
  path: string;
  summary: string;
  snippet: string;
  score: number;
}

interface VaultSearchResult {
  indexedFiles: number;
  indexedChunks: number;
  route: string;
  promptContext: string;
  hits: VaultSearchHit[];
}

const isTauriRuntime = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function initAtheletiaApi() {
  if (!isTauriRuntime()) {
    return;
  }

  window.atheletiaAPI = {
    platform: 'tauri',
    send: () => { },
    on: () => { },
    notes: {
      selectVault: async () => {
        const result = await open({
          directory: true,
          multiple: false,
          title: 'Select Notes Vault Folder',
        });
        if (typeof result === 'string') {
          return result;
        }
        return null;
      },
      getFileTree: (vaultPath: string) =>
        invoke<FileNode[]>('notes_get_file_tree', { vaultPath }),
      reindexVault: (vaultPath: string) =>
        invoke<VaultIndexStats>('notes_reindex_vault', { vaultPath }),
      reindexSubtree: (subtreePath: string, vaultPath?: string) =>
        invoke<VaultIndexStats>('notes_reindex_subtree', { subtreePath, vaultPath }),
      cancelVaultReindex: () =>
        invoke<boolean>('notes_cancel_vault_reindex'),
      searchVault: (vaultPath: string, query: string, maxHits?: number) =>
        invoke<VaultSearchResult>('notes_search_vault', { vaultPath, query, maxHits }),
      readFile: (filePath: string) =>
        invoke<string | null>('notes_read_file', { filePath }),
      writeFile: (filePath: string, content: string) =>
        invoke<boolean>('notes_write_file', { filePath, content }),
      createFile: (dirPath: string, fileName: string) =>
        invoke<MutationResult>('notes_create_file', { dirPath, fileName }),
      createFolder: (dirPath: string, folderName: string) =>
        invoke<MutationResult>('notes_create_folder', { dirPath, folderName }),
      delete: (itemPath: string) =>
        invoke<MutationResult>('notes_delete', { itemPath }),
      rename: (oldPath: string, newName: string) =>
        invoke<MutationResult>('notes_rename', { oldPath, newName }),
      moveFile: (sourcePath: string, destinationPath: string) =>
        invoke<MutationResult>('notes_move_file', { sourcePath, destinationPath }),
      ensureDir: (dirPath: string) =>
        invoke<MutationResult>('notes_ensure_dir', { dirPath }),
    },
    leetcode: {
      readCsv: () => invoke<string | null>('leetcode_read_csv'),
      getCsvPath: () => invoke<string>('leetcode_get_csv_path'),
      saveCsv: (csvContent: string) => invoke<boolean>('leetcode_save_csv', { csvContent }),
    },
    browser: {
      openInApp: (url: string) => invoke<boolean>('browser_open_in_app', { url }),
      createChild: (url: string, x: number, y: number, width: number, height: number) =>
        invoke<boolean>('browser_create_child', { url, x, y, width, height }),
      updateChildBounds: (x: number, y: number, width: number, height: number) =>
        invoke<boolean>('browser_update_child_bounds', { x, y, width, height }),
      closeChild: () => invoke<boolean>('browser_close_child'),
    },
    app: {
      minimizeToTray: () => invoke<boolean>('app_minimize_to_tray'),
      showWindow: () => invoke<boolean>('app_show_window'),
      showWindowPage: (page: string) => invoke<boolean>('app_show_window_page', { page }),
      quit: () => invoke<boolean>('app_quit'),
      getIncognitoStatus: () => invoke<{ active: boolean; remainingSeconds: number }>('app_get_incognito_status'),
      toggleIncognito: () => invoke<{ active: boolean; remainingSeconds: number }>('app_toggle_incognito'),
      setIncognitoFor: (minutes: number) =>
        invoke<{ active: boolean; remainingSeconds: number }>('app_set_incognito_for', { minutes }),
      getGameMode: () => invoke<boolean>('app_get_game_mode'),
      toggleGameMode: () => invoke<boolean>('app_toggle_game_mode'),
      refreshAi: () => invoke<boolean>('app_refresh_ai'),
      clearNotifications: () => invoke<boolean>('app_clear_notifications'),
      musicControl: (action: string) => invoke<boolean>('app_music_control', { action }),
      musicSelectPlaylist: (playlistId: number) =>
        invoke<boolean>('app_music_playlist_select', { playlistId }),
      timerControl: (action: string, minutes?: number) => invoke<boolean>('app_timer_control', { action, minutes }),
      toggleTrayPanel: () => invoke<boolean>('app_toggle_tray_panel'),
    },
    google: {
      checkAuth: () => invoke<boolean>('google_check_auth'),
      signIn: () => invoke<boolean>('google_sign_in'),
      signOut: () => invoke<boolean>('google_sign_out'),
      listEvents: (timeMin: string, timeMax: string) =>
        invoke<any[]>('google_list_events', { timeMin, timeMax }),
      addEvent: (event: any) => invoke<string | { error: string }>('google_add_event', { event }),
      updateEvent: (id: string, event: any) =>
        invoke<boolean | { error: string }>('google_update_event', { id, event }),
      deleteEvent: (id: string) =>
        invoke<boolean | { error: string }>('google_delete_event', { id }),
      tasks: {
        list: (tasklistId?: string) => invoke<any[]>('google_tasks_list', { tasklistId }),
        getLists: () => invoke<any[]>('google_tasks_get_lists'),
        add: (tasklistId: string | undefined, taskData: { title: string; notes?: string; due?: string }) =>
          invoke<string>('google_tasks_add', { tasklistId, taskData }),
        update: (tasklistId: string | undefined, taskId: string, task: any) =>
          invoke<boolean>('google_tasks_update', { tasklistId, taskId, task }),
        delete: (tasklistId: string | undefined, taskId: string) =>
          invoke<boolean>('google_tasks_delete', { tasklistId, taskId }),
      },
    },
    music: {
      openWindow: async () => {
        useNavStore.getState().setActiveTab('music');
        return true;
      },
      search: (query: string) => invoke<any[]>('music_search', { query }),
      getPlaylists: () => invoke<any[]>('music_get_playlists'),
      savePlaylists: (playlists: any) => invoke<boolean>('music_save_playlists', { playlists }),
      getLibrary: () => invoke<any>('music_get_library'),
      saveLibrary: (library: any) => invoke<boolean>('music_save_library', { library }),
    },
    intent: {
      getActivityStats: (startTime: number, endTime: number) =>
        invoke<any>('get_activity_stats', { startTime, endTime }),
      getActivities: (startTime: number, endTime: number, limit?: number) =>
        invoke<any[]>('get_activities', { startTime, endTime, limit: limit ?? 200 }),
      getChatSessions: () => invoke<any[]>('get_chat_sessions'),
      createChatSession: () => invoke<any>('create_chat_session'),
      deleteChatSession: (sessionId: string) => invoke<boolean>('delete_chat_session', { sessionId }),
      getChatMessages: (sessionId: string) => invoke<any[]>('get_chat_messages', { sessionId }),
      sendChatMessage: (
        sessionId: string,
        message: string,
        model?: string,
        provider?: string,
        timeRange?: string,
        selectedSources?: string[],
        _unused?: string[],
        apiKey?: string
      ) => invoke<any>('send_chat_message', { sessionId, message, model, provider, timeRange, selectedSources, apiKey }),
      startActivityTracker: () => invoke<boolean>('start_activity_tracker'),
      getDashboardOverview: (refresh?: boolean) => invoke<any>('dashboard_get_overview', { refresh }),
      refreshDashboardOverview: () => invoke<any>('dashboard_refresh_overview'),
      summarizeDashboardItem: (itemType: string, itemName: string, context?: string) =>
        invoke<string>('dashboard_summarize_item', { itemType, itemName, context }),
      upsertDashboardDeadline: (item: any) => invoke<any>('dashboard_upsert_deadline', { item }),
      deleteDashboardDeadline: (title: string) => invoke<any>('dashboard_delete_deadline', { title }),
      upsertDashboardProject: (project: any) => invoke<any>('dashboard_upsert_project', { project }),
      deleteDashboardProject: (name: string) => invoke<any>('dashboard_delete_project', { name }),
    },
    diary: {
      getEntries: (date?: string) => invoke<any[]>('diary_get_entries', { date }),
      saveEntry: (entry: any) => invoke<any>('diary_save_entry', { entry }),
      deleteEntry: (id: string) => invoke<boolean>('diary_delete_entry', { id }),
      generateEntry: (date: string, extraContext?: string, model?: string, apiKey?: string, provider?: string) =>
        invoke<string>('diary_generate_entry', { date, extraContext, model, apiKey, provider }),
    },
    settings: {
      get: () => invoke<any>('settings_get'),
      save: (settings: any) => invoke<boolean>('settings_save', { settings }),
      validateApiKey: (provider: string, apiKey?: string) =>
        invoke<{ valid: boolean; provider: string; message: string }>('settings_validate_api_key', { provider, apiKey }),
      getNvidiaModels: (apiKey?: string) => invoke<any[]>('settings_get_nvidia_models', { apiKey }),
      getLMStudioModels: (baseUrl?: string) => invoke<any[]>('settings_get_lmstudio_models', { baseUrl }),
      nvidiaChatCompletion: (
        model: string,
        messages: { role: string; content: string }[],
        maxTokens?: number,
        temperature?: number,
        apiKey?: string,
      ) => invoke<any>('settings_nvidia_chat_completion', { model, messages, maxTokens, temperature, apiKey }),
      chatCompletion: (
        model: string,
        messages: { role: string; content: string }[],
        maxTokens?: number,
        temperature?: number,
        apiKey?: string,
        provider?: string,
      ) => invoke<any>('settings_chat_completion', { model, messages, maxTokens, temperature, apiKey, provider }),
      lmstudioChatCompletion: (
        model: string,
        messages: { role: string; content: string }[],
        maxTokens?: number,
        temperature?: number,
        baseUrl?: string,
      ) => invoke<any>('settings_lmstudio_chat_completion', { model, messages, maxTokens, temperature, baseUrl }),
      brainChatStream: (
        model: string,
        messages: { role: string; content: string }[],
        useLocal: boolean,
        maxTokens?: number,
        temperature?: number,
        baseUrl?: string,
        apiKey?: string,
        provider?: string,
      ) => invoke<void>('brain_chat_stream', { model, messages, useLocal, maxTokens, temperature, baseUrl, apiKey, provider }),
      brainCancelStream: () => invoke<boolean>('brain_cancel_stream'),
    },
    storage: {
      getStats: () => invoke<any>('storage_get_stats'),
      clearAll: () => invoke<boolean>('storage_clear_all'),
      exportData: (filePath: string) => invoke<boolean>('storage_export_data', { filePath }),
      importData: (filePath: string, replaceExisting?: boolean) =>
        invoke<boolean>('storage_import_data', { filePath, replaceExisting }),
    },
  };
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    atheletiaAPI?: {
      platform: string;
      send: (channel: string, data: any) => void;
      on: (channel: string, func: any) => void;
      notes: {
        selectVault: () => Promise<string | null>;
        getFileTree: (vaultPath: string) => Promise<FileNode[]>;
        reindexVault: (vaultPath: string) => Promise<VaultIndexStats>;
        reindexSubtree: (subtreePath: string, vaultPath?: string) => Promise<VaultIndexStats>;
        cancelVaultReindex: () => Promise<boolean>;
        searchVault: (vaultPath: string, query: string, maxHits?: number) => Promise<VaultSearchResult>;
        readFile: (filePath: string) => Promise<string | null>;
        writeFile: (filePath: string, content: string) => Promise<boolean>;
        createFile: (dirPath: string, fileName: string) => Promise<MutationResult>;
        createFolder: (dirPath: string, folderName: string) => Promise<MutationResult>;
        delete: (itemPath: string) => Promise<MutationResult>;
        rename: (oldPath: string, newName: string) => Promise<MutationResult>;
        moveFile: (sourcePath: string, destinationPath: string) => Promise<MutationResult>;
        ensureDir: (dirPath: string) => Promise<MutationResult>;
      };
      leetcode: {
        readCsv: () => Promise<string | null>;
        getCsvPath: () => Promise<string>;
        saveCsv: (csvContent: string) => Promise<boolean>;
      };
      browser: {
        openInApp: (url: string) => Promise<boolean>;
        createChild: (url: string, x: number, y: number, width: number, height: number) => Promise<boolean>;
        updateChildBounds: (x: number, y: number, width: number, height: number) => Promise<boolean>;
        closeChild: () => Promise<boolean>;
      };
      app: {
        minimizeToTray: () => Promise<boolean>;
        showWindow: () => Promise<boolean>;
        showWindowPage: (page: string) => Promise<boolean>;
        quit: () => Promise<boolean>;
        getIncognitoStatus: () => Promise<{ active: boolean; remainingSeconds: number }>;
        toggleIncognito: () => Promise<{ active: boolean; remainingSeconds: number }>;
        setIncognitoFor: (minutes: number) => Promise<{ active: boolean; remainingSeconds: number }>;
        getGameMode: () => Promise<boolean>;
        toggleGameMode: () => Promise<boolean>;
        refreshAi: () => Promise<boolean>;
        clearNotifications: () => Promise<boolean>;
        musicControl: (action: string) => Promise<boolean>;
        musicSelectPlaylist: (playlistId: number) => Promise<boolean>;
        timerControl: (action: string, minutes?: number) => Promise<boolean>;
        toggleTrayPanel: () => Promise<boolean>;
      };
      music?: {
        openWindow: () => Promise<boolean>;
        search: (query: string) => Promise<any[]>;
        getPlaylists: () => Promise<any[]>;
        savePlaylists: (playlists: any) => Promise<boolean>;
        getLibrary: () => Promise<{ likedSongs: any[]; recentlyPlayed: any[] }>;
        saveLibrary: (library: { likedSongs: any[]; recentlyPlayed: any[] }) => Promise<boolean>;
      };
      intent?: {
        getActivityStats: (startTime: number, endTime: number) => Promise<any>;
        getActivities: (startTime: number, endTime: number, limit?: number) => Promise<any[]>;
        getChatSessions: () => Promise<any[]>;
        createChatSession: () => Promise<any>;
        deleteChatSession: (sessionId: string) => Promise<boolean>;
        getChatMessages: (sessionId: string) => Promise<any[]>;
        sendChatMessage: (sessionId: string, message: string, model?: string, provider?: string, timeRange?: string, selectedSources?: string[], _unused?: string[], apiKey?: string) => Promise<any>;
        startActivityTracker: () => Promise<boolean>;

        getDashboardOverview: (refresh?: boolean) => Promise<any>;
        refreshDashboardOverview: () => Promise<any>;
        summarizeDashboardItem: (itemType: string, itemName: string, context?: string) => Promise<string>;
        upsertDashboardDeadline: (item: any) => Promise<any>;
        deleteDashboardDeadline: (title: string) => Promise<any>;
        upsertDashboardProject: (project: any) => Promise<any>;
        deleteDashboardProject: (name: string) => Promise<any>;
      };
      diary?: {
        getEntries: (date?: string) => Promise<any[]>;
        saveEntry: (entry: any) => Promise<any>;
        deleteEntry: (id: string) => Promise<boolean>;
        generateEntry: (date: string, extraContext?: string, model?: string, apiKey?: string, provider?: string) => Promise<string>;
      };
      settings?: {
        get: () => Promise<any>;
        save: (settings: any) => Promise<boolean>;
        validateApiKey: (provider: string, apiKey?: string) => Promise<{ valid: boolean; provider: string; message: string }>;
        getNvidiaModels: (apiKey?: string) => Promise<any[]>;
        getLMStudioModels: (baseUrl?: string) => Promise<any[]>;
        nvidiaChatCompletion: (
          model: string,
          messages: { role: string; content: string }[],
          maxTokens?: number,
          temperature?: number,
          apiKey?: string,
        ) => Promise<any>;
        chatCompletion: (
          model: string,
          messages: { role: string; content: string }[],
          maxTokens?: number,
          temperature?: number,
          apiKey?: string,
          provider?: string,
        ) => Promise<any>;
        lmstudioChatCompletion: (
          model: string,
          messages: { role: string; content: string }[],
          maxTokens?: number,
          temperature?: number,
          baseUrl?: string,
        ) => Promise<any>;
        brainChatStream: (
          model: string,
          messages: { role: string; content: string }[],
          useLocal: boolean,
          maxTokens?: number,
          temperature?: number,
          baseUrl?: string,
          apiKey?: string,
          provider?: string,
        ) => Promise<void>;
        brainCancelStream: () => Promise<boolean>;
      };
      storage?: {
        getStats: () => Promise<any>;
        clearAll: () => Promise<boolean>;
        exportData: (filePath: string) => Promise<boolean>;
        importData: (filePath: string, replaceExisting?: boolean) => Promise<boolean>;
      };
      google: {
        checkAuth: () => Promise<boolean>;
        signIn: () => Promise<boolean>;
        signOut: () => Promise<boolean>;
        listEvents: (timeMin: string, timeMax: string) => Promise<any[]>;
        addEvent: (event: any) => Promise<string | { error: string }>;
        updateEvent: (id: string, event: any) => Promise<boolean | { error: string }>;
        deleteEvent: (id: string) => Promise<boolean | { error: string }>;
        tasks: {
          list: (tasklistId?: string) => Promise<any[]>;
          getLists: () => Promise<any[]>;
          add: (tasklistId: string | undefined, taskData: { title: string; notes?: string; due?: string }) => Promise<string>;
          update: (tasklistId: string | undefined, taskId: string, task: any) => Promise<boolean>;
          delete: (tasklistId: string | undefined, taskId: string) => Promise<boolean>;
        };
      };
    };
  }
}
