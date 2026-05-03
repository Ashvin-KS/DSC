import { create } from 'zustand';

export type Tab = 'dashboard' | 'code' | 'brain' | 'schedule' | 'zen' | 'music' | 'chat' | 'activity' | 'diary' | 'settings';

interface NavState {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  hasUnsavedChanges: boolean;
  setHasUnsavedChanges: (val: boolean) => void;
}

export const useNavStore = create<NavState>((set, get) => ({
  activeTab: 'dashboard',
  hasUnsavedChanges: false,
  setHasUnsavedChanges: (val) => set({ hasUnsavedChanges: val }),
  setActiveTab: (tab) => {
    if (!get().hasUnsavedChanges || window.confirm('You have unsaved changes. Are you sure you want to leave without saving?')) {
      set({ activeTab: tab, hasUnsavedChanges: false });
    }
  },
}));