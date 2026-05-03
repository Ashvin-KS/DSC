import React from 'react';
import { Terminal, Github, Pencil } from 'lucide-react';
import { Card } from '../ui/Card';

interface Project {
  name: string;
  update: string;
  files_changed: number;
}

interface ProjectsCardProps {
  projects?: Project[];
  onProjectClick?: (project: Project) => void;
  onManage?: () => void;
}

export const ProjectsCard: React.FC<ProjectsCardProps> = ({ projects = [], onProjectClick, onManage }) => {
  return (
    <Card
      title="Active Builds"
      icon={Terminal}
      className="col-span-1 md:col-span-2"
      action={
        <button
          onClick={(e) => {
            e.stopPropagation();
            onManage?.();
          }}
          className="p-1.5 hover:bg-[#262626] rounded text-gray-600 hover:text-white transition-colors group"
          title="Manage Projects"
        >
          <Pencil size={14} className="group-hover:scale-110 transition-transform" />
        </button>
      }
    >
      <div className="flex flex-col justify-start h-full gap-5 overflow-y-auto pr-2">
        {projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-4">
            <p className="text-sm font-medium text-gray-400">No active builds detected today.</p>
            <p className="text-xs text-gray-600 mt-1">Code changes will appear here.</p>
          </div>
        ) : (
          projects.map((project, idx) => {
            // Pseudo-random progress / color purely for visual flair based on index
            const progress = Math.min(100, 20 + project.files_changed * 10);
            const color = idx % 2 === 0 ? 'bg-cyan-500' : 'bg-emerald-500';
            const statusColor = idx % 2 === 0
              ? 'text-cyan-400 bg-cyan-400/10 border-cyan-400/20'
              : 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20';

            return (
              <button
                key={idx}
                type="button"
                onClick={() => onProjectClick?.(project)}
                className="flex flex-col gap-2 text-left rounded-lg hover:bg-white/[0.02] transition-colors p-1 -m-1"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-2">
                    <Github size={14} className="text-gray-500 mt-0.5 flex-shrink-0" />
                    <div className="flex flex-col">
                      <span className="text-sm font-bold text-gray-200">{project.name}</span>
                      <span className="text-[10px] text-gray-500 leading-tight line-clamp-2 mt-0.5">{project.update}</span>
                    </div>
                  </div>
                  <span className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded border flex-shrink-0 ${statusColor}`}>
                    {project.files_changed > 0 ? `${project.files_changed} files` : 'Active'}
                  </span>
                </div>

                <div className="w-full h-1.5 bg-[#262626] rounded-full overflow-hidden mt-1">
                  <div
                    className={`h-full rounded-full ${color} shadow-[0_0_8px_rgba(255,255,255,0.1)] transition-all duration-1000 ease-out`}
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </button>
            );
          })
        )}
      </div>
    </Card>
  );
};