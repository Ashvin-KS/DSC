import React from 'react';
import {
  LayoutGrid, Code2, Brain, CalendarClock, Headphones, Music2,
  MessageSquare, Activity, BookOpen, Settings2
} from 'lucide-react';
import { useNavStore, Tab } from '../../store/useNavStore';

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
];

export const Sidebar: React.FC = () => {
  const { activeTab, setActiveTab } = useNavStore();

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
      className="fixed left-0 top-0 h-full w-14 sm:w-16 flex flex-col items-center py-4 sm:py-6 z-sidebar"
      style={{ background: 'var(--bg-elev-1)', borderRight: '1px solid var(--border-soft)' }}
    >
      {/* Main nav */}
      <div className="flex flex-col gap-7 flex-1">
        {MAIN_NAV.map((item) => (
          <NavButton key={item.id} {...item} />
        ))}
      </div>

      {/* Settings — pinned at bottom */}
      <div className="mt-4 pt-4 w-full flex flex-col items-center" style={{ borderTop: '1px solid var(--border-soft)' }}>
        <NavButton id="settings" icon={Settings2} label="Settings" />
      </div>
    </aside>
  );
};
