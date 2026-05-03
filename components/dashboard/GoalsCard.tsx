import React from 'react';
import { Target, Check, Pencil, Calendar } from 'lucide-react';
import { Card } from '../ui/Card';

export interface DashboardTask {
  title: string;
  due_date?: string;
  status: string;
  source: string;
}

interface GoalsCardProps {
  deadlines: DashboardTask[];
  onEdit: () => void;
}

export const GoalsCard: React.FC<GoalsCardProps> = ({ deadlines, onEdit }) => {
  return (
    <Card
      title="Upcoming Deadlines"
      icon={Target}
      className="col-span-1 md:col-span-2"
      action={
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          className="p-1.5 hover:bg-[#262626] rounded text-gray-600 hover:text-white transition-colors group"
          title="View All"
        >
          <Pencil size={14} className="group-hover:scale-110 transition-transform" />
        </button>
      }
    >
      <div className="flex flex-col justify-start h-full gap-3 overflow-y-auto pr-2">
        {deadlines.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-4">
            <p className="text-sm font-medium text-gray-400">No imminent deadlines.</p>
            <p className="text-xs text-gray-600 mt-1">Deadlines detected in manual entries or AI summaries will appear here.</p>
          </div>
        ) : (
          deadlines.map((task, idx) => {
            const isCompleted = task.status.toLowerCase() === 'completed';
            const isUrgent = task.due_date?.toLowerCase().includes('today') || task.due_date?.toLowerCase().includes('tomorrow');

            return (
              <div
                key={idx}
                className={`
                  group flex items-center justify-between p-3 rounded-lg border transition-all duration-200
                  ${isCompleted
                    ? 'bg-emerald-900/10 border-emerald-900/30'
                    : isUrgent ? 'bg-amber-500/5 border-amber-500/20' : 'bg-[#0a0a0a] border-[#262626]'
                  }
                `}
              >
                <div className="flex flex-col gap-0.5">
                  <span className={`
                    text-sm font-medium transition-colors duration-200 line-clamp-1
                    ${isCompleted ? 'text-gray-500 line-through' : 'text-gray-200'}
                  `}>
                    {task.title}
                  </span>
                  {task.due_date && (
                    <span className="text-[10px] text-gray-500 flex items-center gap-1">
                      <Calendar size={10} /> {task.due_date}
                    </span>
                  )}
                </div>

                {isCompleted ? (
                  <div className="w-5 h-5 rounded flex items-center justify-center bg-emerald-500 text-black flex-shrink-0">
                    <Check size={12} className="stroke-[3px]" />
                  </div>
                ) : (
                  <div className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded border flex-shrink-0 ${isUrgent ? 'text-amber-400 bg-amber-400/10 border-amber-400/20' : 'text-gray-400 border-gray-600'}`}>
                    Active
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
};