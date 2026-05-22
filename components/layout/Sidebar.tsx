import React from 'react';
import {
  LayoutGrid, Code2, Brain, CalendarClock, Headphones, Music2,
  MessageSquare, Activity, BookOpen, Settings2, Dumbbell, User
} from 'lucide-react';
import { useNavStore, Tab } from '../../store/useNavStore';
import { useIntentStore } from '../../store/useIntentStore';

const MAIN_NAV: { id: Tab; icon: React.ElementType; label: string }[] = [
  { id: 'dashboard', icon: LayoutGrid, label: 'Dashboard' },
  { id: 'chat', icon: MessageSquare, label: 'Chat' },
  { id: 'activity', icon: Activity, label: 'Activity' },
  { id: 'diary', icon: BookOpen, label: 'Diary' },
  { id: 'code', icon: Code2, label: 'Code' },
  { id: 'brain', icon: Brain, label: 'Brain' },
  { id: 'schedule', icon: CalendarClock, label: 'Schedule' },
  { id: 'zen', icon: Headphones, label: 'Zen Mode' },
  { id: 'music', icon: Music2, label: 'Music' },
  { id: 'workout', icon: Dumbbell, label: 'Workout' },
];

const getInitials = (name: string) => {
  const parts = (name || '').trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return '?';
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

export const Sidebar: React.FC = () => {
  const { activeTab, setActiveTab } = useNavStore();
  const settings = useIntentStore((s) => s.settings);
  const setShowOnboarding = useIntentStore((s) => s.setShowOnboarding);
  const setOnboardingStep = useIntentStore((s) => s.setOnboardingStep);

  const profileName = settings?.profileName || '';
  const profileColor = settings?.profileColor || '#6366f1';
  const initials = getInitials(profileName);

  const handleProfileClick = () => {
    setActiveTab('settings');
  };

  const NavButton = ({ id, icon: Icon, label }: { id: Tab; icon: React.ElementType; label: string }) => {
    const isActive = activeTab === id;
    return (
      <button
        key={id}
        onClick={() => setActiveTab(id)}
        className={`
          group relative flex items-center justify-center w-10 h-10 rounded-xl transition-all duration-300
          ${isActive ? 'text-white' : 'text-gray-500 hover:text-gray-300'}
        `}
        style={isActive ? { color: 'var(--text-strong)' } : undefined}
        aria-label={label}
      >
        {/* Active Glow */}
        {isActive && (
          <div className="absolute inset-0 rounded-xl blur-md" style={{ background: 'var(--accent-soft)' }} />
        )}
        <Icon
          size={22}
          className="relative z-10 transition-all duration-300"
          style={isActive ? { filter: 'drop-shadow(0 0 8px var(--accent))' } : undefined}
        />
        {/* Tooltip */}
        <div
          className="absolute left-14 rounded px-2 py-1 text-xs opacity-0 transition-opacity whitespace-nowrap pointer-events-none z-dropdown group-hover:opacity-100"
          style={{
            background: 'var(--bg-elev-2)',
            border: '1px solid var(--border-strong)',
            color: 'var(--text-strong)',
          }}
        >
          {label}
        </div>
      </button>
    );
  };

  return (
    <aside
      className="fixed left-0 top-0 h-full w-14 sm:w-16 flex flex-col items-center py-3 z-sidebar"
      style={{ background: 'var(--bg-elev-1)', borderRight: '1px solid var(--border-soft)' }}
    >
      {/* Sleek Logo / Accent element at the top instead of non-functional window controls */}
      <div className="mb-4 relative flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500/10 to-purple-500/10 border border-white/[0.06]">
        <div className="w-2.5 h-2.5 rounded-full bg-accent animate-pulse" style={{ boxShadow: '0 0 10px var(--accent)' }} />
      </div>

      {/* Main nav */}
      <div className="flex flex-col gap-2.5 flex-1 overflow-y-auto scrollbar-none py-2">
        {MAIN_NAV.map((item) => (
          <NavButton key={item.id} {...item} />
        ))}
      </div>

      {/* Settings & Profile — pinned at bottom */}
      <div className="mt-auto pt-3 w-full flex flex-col items-center gap-2" style={{ borderTop: '1px solid var(--border-soft)' }}>
        <NavButton id="settings" icon={Settings2} label="Settings" />

        {/* Profile Button — designed to beautifully match other nav items and launch Profile Onboarding on click */}
        <button
          onClick={handleProfileClick}
          className={`
            group relative flex items-center justify-center w-10 h-10 rounded-xl transition-all duration-300 hover:scale-105 cursor-pointer
            ${profileName ? '' : 'text-gray-500 hover:text-gray-300 bg-white/[0.03] border border-white/[0.08] hover:bg-white/[0.06] hover:border-white/[0.12]'}
          `}
          style={
            profileName
              ? {
                  backgroundColor: profileColor,
                  color: '#ffffff',
                  boxShadow: `0 0 12px ${profileColor}40`,
                  border: '1.5px solid rgba(255, 255, 255, 0.15)',
                }
              : undefined
          }
          aria-label={profileName ? `Profile: ${profileName}` : 'Setup Profile'}
        >
          {profileName ? (
            <span className="text-xs font-bold select-none tracking-wider">{initials}</span>
          ) : (
            <User size={18} className="text-gray-500 group-hover:text-gray-300 transition-colors" />
          )}

          {/* Tooltip */}
          <div
            className="absolute left-14 rounded px-2 py-1 text-xs opacity-0 transition-opacity whitespace-nowrap pointer-events-none z-dropdown group-hover:opacity-100"
            style={{
              background: 'var(--bg-elev-2)',
              border: '1px solid var(--border-strong)',
              color: 'var(--text-strong)',
            }}
          >
            {profileName ? `${profileName} (${settings?.profileRole || 'User'})` : 'Setup Profile'}
          </div>
        </button>
      </div>
    </aside>
  );
};
