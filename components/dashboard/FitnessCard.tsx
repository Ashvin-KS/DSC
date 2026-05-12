import React from 'react';
import { Activity } from 'lucide-react';
import { Card } from '../ui/Card';
import { useNavStore } from '../../store/useNavStore';
import { useWorkoutStore } from '../../store/useWorkoutStore';

export const FitnessCard: React.FC = () => {
  const setActiveTab = useNavStore((s) => s.setActiveTab);
  const days = useWorkoutStore((s) => s.days);
  const activeDayId = useWorkoutStore((s) => s.activeDayId);
  const completedSets = useWorkoutStore((s) => s.completedSets);
  const stats = useWorkoutStore((s) => s.stats);
  const activeDay = days.find((day) => day.id === activeDayId) || days[0];
  // SVG Configuration
  const size = 100;
  const strokeWidth = 6;
  const radius = 40;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  const totalSets = activeDay?.exercises.reduce((sum, exercise) => sum + Math.max(1, exercise.sets), 0) || 0;
  const doneSets = activeDay?.exercises.reduce((sum, exercise) => {
    const key = `${activeDay.id}:${exercise.id}`;
    return sum + (completedSets[key] || []).filter(Boolean).length;
  }, 0) || 0;
  const percentage = totalSets ? Math.round((doneSets / totalSets) * 100) : 0;
  const offset = circumference - (percentage / 100) * circumference;

  return (
    <Card title="Fitness" icon={Activity} className="col-span-1">
      <button onClick={() => setActiveTab('workout')} className="flex h-full w-full flex-col items-center justify-center relative py-2 text-left">
        <div className="relative w-28 h-28 flex items-center justify-center">
          {/* SVG Ring */}
          <svg 
            width={size} 
            height={size} 
            viewBox={`0 0 ${size} ${size}`} 
            className="transform -rotate-90 w-full h-full overflow-visible"
          >
            {/* Background Circle */}
            <circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke="#262626"
              strokeWidth={strokeWidth}
            />
            {/* Progress Circle */}
            <circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke="#f97316" // Orange-500
              strokeWidth={strokeWidth}
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              strokeLinecap="round"
              className="drop-shadow-[0_0_4px_rgba(249,115,22,0.4)] transition-all duration-1000 ease-out"
            />
          </svg>
          
          {/* Inner Text */}
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-2xl font-bold text-white tracking-tight">{percentage}%</span>
            <span className="text-[10px] text-orange-500 uppercase font-bold tracking-wider">Today</span>
          </div>
        </div>
        <div className="mt-2 text-center">
          <div className="text-xs font-semibold text-gray-200">{activeDay?.title || 'Workout'}</div>
          <div className="text-[10px] text-gray-500">{stats.currentStreak} day streak</div>
        </div>
      </button>
    </Card>
  );
};
