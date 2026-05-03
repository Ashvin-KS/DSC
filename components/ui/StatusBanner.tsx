import React from 'react';
import { AlertCircle, CheckCircle2, Info, Loader2 } from 'lucide-react';

type StatusTone = 'info' | 'success' | 'warning' | 'error' | 'loading';

interface StatusBannerProps {
  tone?: StatusTone;
  title: string;
  message?: string;
  action?: React.ReactNode;
  className?: string;
}

const toneStyles: Record<StatusTone, { icon: React.ElementType; shell: string; iconClass: string }> = {
  info: {
    icon: Info,
    shell: 'border-cyan-500/25 bg-cyan-500/10 text-cyan-100',
    iconClass: 'text-cyan-300',
  },
  success: {
    icon: CheckCircle2,
    shell: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-100',
    iconClass: 'text-emerald-300',
  },
  warning: {
    icon: AlertCircle,
    shell: 'border-amber-500/25 bg-amber-500/10 text-amber-100',
    iconClass: 'text-amber-300',
  },
  error: {
    icon: AlertCircle,
    shell: 'border-red-500/25 bg-red-500/10 text-red-100',
    iconClass: 'text-red-300',
  },
  loading: {
    icon: Loader2,
    shell: 'border-cyan-500/25 bg-cyan-500/10 text-cyan-100',
    iconClass: 'text-cyan-300 animate-spin',
  },
};

export const StatusBanner: React.FC<StatusBannerProps> = ({
  tone = 'info',
  title,
  message,
  action,
  className = '',
}) => {
  const styles = toneStyles[tone];
  const Icon = styles.icon;

  return (
    <div className={`rounded-lg border px-4 py-3 ${styles.shell} ${className}`}>
      <div className="flex items-start gap-3">
        <Icon size={16} className={`mt-0.5 shrink-0 ${styles.iconClass}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{title}</p>
          {message && <p className="mt-1 text-xs text-gray-300/85">{message}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  );
};

