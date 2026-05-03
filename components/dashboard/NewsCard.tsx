import React from 'react';
import { Brain, RefreshCw, Loader2 } from 'lucide-react';
import { Card } from '../ui/Card';

interface NewsCardProps {
  summary?: string;
  loading?: boolean;
  onRefresh?: () => void;
}

export const NewsCard: React.FC<NewsCardProps> = ({ summary, loading, onRefresh }) => {
  return (
    <Card
      title="System Overview"
      icon={Brain}
      className="col-span-1 md:col-span-2"
      action={
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (onRefresh) onRefresh();
          }}
          disabled={loading}
          className="p-1.5 hover:bg-[#262626] rounded text-gray-600 hover:text-white transition-colors group disabled:opacity-50"
          title="Refresh AI Analysis"
        >
          {loading ? (
            <Loader2 size={14} className="animate-spin text-cyan-500" />
          ) : (
            <RefreshCw size={14} className="group-hover:rotate-180 transition-transform duration-500" />
          )}
        </button>
      }
    >
      <div className="flex flex-col h-full overflow-y-auto pr-2">
        {loading && !summary ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-4 gap-2">
            <Brain className="w-8 h-8 text-cyan-500/30 animate-pulse" />
            <p className="text-xs font-medium text-gray-400">Analyzing daily activity...</p>
          </div>
        ) : !summary ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-4">
            <p className="text-sm font-medium text-gray-400">No data points.</p>
            <p className="text-[10px] text-gray-600 mt-1">NVIDIA NIM generated summary requires activity.</p>
          </div>
        ) : (
          <div className="text-sm font-medium text-gray-300 leading-relaxed tracking-wide">
            {summary.split('\n').map((line, i) => (
              <p key={i} className={i > 0 ? 'mt-2' : ''}>
                {line}
              </p>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
};