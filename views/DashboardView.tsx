import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Card } from '../components/ui/Card';
import { LeetCodeCard } from '../components/dashboard/LeetCodeCard';
import { FitnessCard } from '../components/dashboard/FitnessCard';
import { GoalsCard } from '../components/dashboard/GoalsCard';
import { NewsCard } from '../components/dashboard/NewsCard';
import { ProjectsCard } from '../components/dashboard/ProjectsCard';
import { DetailModal } from '../components/dashboard/DetailModal';
import { GraduationCap, AlertTriangle, Sparkles, RefreshCw } from 'lucide-react';
import { NewsManager } from '../components/dashboard/NewsManager';
import { TaskAlerter } from '../components/dashboard/TaskAlerter';
import type { Goal } from '../components/dashboard/GoalsManager';
import { StatusBanner } from '../components/ui/StatusBanner';

type ViewMode = 'grid' | 'goals' | 'news';
type ModalType = 'assignments' | 'projects' | null;
const DASHBOARD_AUTO_REFRESH_MS = 5 * 60 * 60 * 1000;

type ExpandedDetail = {
  kind: 'deadline' | 'project' | 'contact';
  title: string;
  subtitle?: string;
  body: string;
  aiSummary?: string;
  loadingSummary?: boolean;
};

const getDashboardErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
};

const agoFromUnix = (ts?: number) => {
  if (!ts) return 'recently';
  const diff = Math.floor((Date.now() / 1000 - ts) / 60);
  if (diff < 1) return 'just now';
  if (diff < 60) return `${diff}m ago`;
  const h = Math.floor(diff / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

// ─── Dashboard ────────────────────────────────────────────────────────────────
export const DashboardView: React.FC = () => {
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [showAlerter, setShowAlerter] = useState(false);
  const [openModal, setOpenModal] = useState<ModalType>(null);
  const [expandedDetail, setExpandedDetail] = useState<ExpandedDetail | null>(null);
  const [overview, setOverview] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingDeadlineTitle, setEditingDeadlineTitle] = useState<string | null>(null);
  const [deadlineForm, setDeadlineForm] = useState({ title: '', due_date: '', status: 'pending', source: 'manual' });
  const [editingProjectName, setEditingProjectName] = useState<string | null>(null);
  const [projectForm, setProjectForm] = useState({ name: '', update: '', files_changed: 0 });
  const primaryDeadline = overview?.deadlines?.[0] ?? null;
  const dashboardAlertGoals = useMemo<Goal[]>(() => {
    return (overview?.deadlines || [])
      .filter((item: any) => String(item?.status || 'pending').toLowerCase() !== 'completed')
      .slice(0, 8)
      .map((item: any, index: number) => ({
        id: index + 1,
        text: item?.title || 'Untitled deadline',
        completed: false,
      }));
  }, [overview?.deadlines]);

  React.useEffect(() => {
    const loadOverview = async () => {
      try {
        setLoadError(null);
        if (window.atheletiaAPI?.intent?.getDashboardOverview) {
          const data = await window.atheletiaAPI.intent.getDashboardOverview(false);
          if (data) setOverview(data);
        }
      } catch (e) {
        console.warn('Failed to load dashboard overview', e);
        setLoadError(e instanceof Error ? e.message : 'Failed to load dashboard overview.');
      } finally {
        setLoading(false);
      }
    };
    loadOverview();
  }, []);

  const handleRefresh = useCallback(async () => {
    setLoading(true);
    try {
      setLoadError(null);
      if (window.atheletiaAPI?.intent?.refreshDashboardOverview) {
        const data = await window.atheletiaAPI.intent.refreshDashboardOverview();
        if (data) setOverview(data);
      }
    } catch (e) {
      console.warn('Failed to refresh dashboard overview', e);
      setLoadError(e instanceof Error ? e.message : 'Failed to refresh dashboard overview.');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleMigrateAlerts = useCallback(async (goalIds: number[]) => {
    const selected = dashboardAlertGoals.filter((goal) => goalIds.includes(goal.id));
    if (selected.length === 0) {
      setShowAlerter(false);
      return;
    }

    try {
      setActionError(null);
      if (!window.atheletiaAPI?.intent?.upsertDashboardDeadline) {
        throw new Error('Dashboard bridge is unavailable in this runtime.');
      }
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dueDate = tomorrow.toISOString().slice(0, 10);
      let latestOverview = overview;

      for (const goal of selected) {
        latestOverview = await window.atheletiaAPI.intent.upsertDashboardDeadline({
          title: goal.text,
          due_date: dueDate,
          status: 'pending',
          source: 'system_check',
        });
      }
      if (latestOverview) setOverview(latestOverview);
    } catch (e) {
      console.warn('Failed to move alert items', e);
      setActionError(getDashboardErrorMessage(e, 'Failed to move alert items.'));
    } finally {
      setShowAlerter(false);
    }
  }, [dashboardAlertGoals, overview]);

  const resetDeadlineForm = () => {
    setEditingDeadlineTitle(null);
    setDeadlineForm({ title: '', due_date: '', status: 'pending', source: 'manual' });
  };

  const resetProjectForm = () => {
    setEditingProjectName(null);
    setProjectForm({ name: '', update: '', files_changed: 0 });
  };

  const handleSaveDeadline = async () => {
    if (!deadlineForm.title.trim()) return;
    try {
      setActionError(null);
      if (!window.atheletiaAPI?.intent?.upsertDashboardDeadline) {
        throw new Error('Dashboard bridge is unavailable in this runtime.');
      }
      const updated = await window.atheletiaAPI.intent.upsertDashboardDeadline({
        title: deadlineForm.title.trim(),
        due_date: deadlineForm.due_date.trim() || null,
        status: deadlineForm.status || 'pending',
        source: deadlineForm.source || 'manual',
      });
      if (!updated) {
        throw new Error('Dashboard deadline save returned no data.');
      }
      setOverview(updated);
      resetDeadlineForm();
    } catch (e) {
      console.warn('Failed to save deadline', e);
      setActionError(getDashboardErrorMessage(e, 'Failed to save deadline.'));
    }
  };

  const handleDeleteDeadline = async (title: string) => {
    try {
      setActionError(null);
      if (!window.atheletiaAPI?.intent?.deleteDashboardDeadline) {
        throw new Error('Dashboard bridge is unavailable in this runtime.');
      }
      const updated = await window.atheletiaAPI.intent.deleteDashboardDeadline(title);
      if (!updated) {
        throw new Error('Dashboard deadline delete returned no data.');
      }
      setOverview(updated);
      if (editingDeadlineTitle?.toLowerCase() === title.toLowerCase()) {
        resetDeadlineForm();
      }
    } catch (e) {
      console.warn('Failed to delete deadline', e);
      setActionError(getDashboardErrorMessage(e, 'Failed to delete deadline.'));
    }
  };

  const handleSaveProject = async () => {
    if (!projectForm.name.trim()) return;
    try {
      setActionError(null);
      if (!window.atheletiaAPI?.intent?.upsertDashboardProject) {
        throw new Error('Dashboard bridge is unavailable in this runtime.');
      }
      const updated = await window.atheletiaAPI.intent.upsertDashboardProject({
        name: projectForm.name.trim(),
        update: projectForm.update.trim() || 'Manual project update',
        files_changed: Number(projectForm.files_changed) || 0,
      });
      if (!updated) {
        throw new Error('Dashboard project save returned no data.');
      }
      setOverview(updated);
      resetProjectForm();
    } catch (e) {
      console.warn('Failed to save project', e);
      setActionError(getDashboardErrorMessage(e, 'Failed to save project.'));
    }
  };

  const handleDeleteProject = async (name: string) => {
    try {
      setActionError(null);
      if (!window.atheletiaAPI?.intent?.deleteDashboardProject) {
        throw new Error('Dashboard bridge is unavailable in this runtime.');
      }
      const updated = await window.atheletiaAPI.intent.deleteDashboardProject(name);
      if (!updated) {
        throw new Error('Dashboard project delete returned no data.');
      }
      setOverview(updated);
      if (editingProjectName?.toLowerCase() === name.toLowerCase()) {
        resetProjectForm();
      }
    } catch (e) {
      console.warn('Failed to delete project', e);
      setActionError(getDashboardErrorMessage(e, 'Failed to delete project.'));
    }
  };

  const openDeadlineDetail = (item: any) => {
    const detail: ExpandedDetail = {
      kind: 'deadline',
      title: item?.title || 'Deadline',
      subtitle: item?.due_date ? `Due: ${item.due_date}` : 'Due date not detected',
      body: `Status: ${item?.status || 'pending'}\nSource: ${item?.source || 'unknown'}\n\nThis item is kept in dashboard history and merged with fresh activity evidence on refresh.`,
      loadingSummary: true,
    };
    setExpandedDetail(detail);
    summarizeExpandedDetail(detail);
  };

  const openProjectDetail = (project: any) => {
    const otherProjects = (overview?.projects || [])
      .filter((p: any) => (p?.name || '').toLowerCase() !== (project?.name || '').toLowerCase())
      .slice(0, 8)
      .map((p: any) => `• ${p.name} (${p.files_changed || 0} files)`)
      .join('\n');

    const detail: ExpandedDetail = {
      kind: 'project',
      title: project?.name || 'Project',
      subtitle: `${project?.files_changed ?? 0} file change(s) detected`,
      body: `${project?.update || 'No project update details available.'}${otherProjects ? `\n\nOther detected projects:\n${otherProjects}` : ''}`,
      loadingSummary: true,
    };
    setExpandedDetail(detail);
    summarizeExpandedDetail(detail);
  };

  const summarizeExpandedDetail = async (detail: ExpandedDetail) => {
    try {
      if (!window.atheletiaAPI?.intent?.summarizeDashboardItem) {
        setExpandedDetail((prev) => prev ? { ...prev, loadingSummary: false } : prev);
        return;
      }
      const summary = await window.atheletiaAPI.intent.summarizeDashboardItem(detail.kind, detail.title, detail.body);
      setExpandedDetail((prev) => {
        if (!prev || prev.title !== detail.title || prev.kind !== detail.kind) return prev;
        return { ...prev, aiSummary: summary, loadingSummary: false };
      });
    } catch {
      setExpandedDetail((prev) => prev ? { ...prev, loadingSummary: false } : prev);
    }
  };

  useEffect(() => {
    const intervalId = setInterval(async () => {
      try {
        if (window.atheletiaAPI?.intent?.refreshDashboardOverview) {
          const data = await window.atheletiaAPI.intent.refreshDashboardOverview();
          if (data) setOverview(data);
        }
      } catch (e) {
        console.warn('Auto refresh failed', e);
      }
    }, DASHBOARD_AUTO_REFRESH_MS);

    return () => clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const onTrayRefresh = () => {
      handleRefresh();
    };
    window.addEventListener('atheletia:refresh-dashboard', onTrayRefresh);
    return () => window.removeEventListener('atheletia:refresh-dashboard', onTrayRefresh);
  }, [handleRefresh]);

  // We no longer manage local goals array. Deadlines are provided from backend via AI.
  if (viewMode === 'news') {
    return (
      <NewsManager onBack={() => setViewMode('grid')} />
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Dashboard Header */}
      <div className="flex items-center justify-between px-4 md:px-8 pt-2 pb-6">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Command Center</h1>
          <p className="text-xs text-gray-500">System Nominal. Welcome back.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 hover:bg-cyan-500/15 transition-all text-xs font-bold uppercase tracking-wider shadow-sm disabled:opacity-50"
            title="Refresh all dashboard data"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh Dashboard
          </button>
          <button
            onClick={() => setShowAlerter(true)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#161616] border border-[#262626] text-amber-500 hover:bg-amber-500/10 hover:border-amber-500/30 transition-all text-xs font-bold uppercase tracking-wider shadow-sm"
          >
            <AlertTriangle size={14} />
            System Check
          </button>
        </div>
      </div>

      {loadError && (
        <div className="px-4 md:px-8 pb-4">
          <StatusBanner
            tone="error"
            title="Dashboard data is unavailable"
            message={loadError}
            action={
              <button
                onClick={handleRefresh}
                className="rounded-md border border-red-400/30 px-2.5 py-1 text-xs text-red-100 hover:bg-red-500/15"
              >
                Retry
              </button>
            }
          />
        </div>
      )}

      {actionError && (
        <div className="px-4 md:px-8 pb-4">
          <StatusBanner
            tone="error"
            title="Dashboard action failed"
            message={actionError}
          />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 px-4 md:px-8 pb-8 animate-in fade-in zoom-in duration-500">

        {/* --- TOP ROW --- */}

        {/* 1. LeetCode Card — has its own internal modal */}
        <LeetCodeCard />

        {/* 2. Fitness Card — has its own internal modal */}
        <FitnessCard />

        {/* 3. Daily Focus / Deadlines (2 cols) */}
        <GoalsCard
          deadlines={overview?.deadlines || []}
          onEdit={() => setOpenModal('assignments')}
        />

        {/* --- MIDDLE ROW --- */}

        {/* 4. Smart Briefing / News (2 cols) */}
        <NewsCard
          summary={overview?.summary}
          loading={loading}
          onRefresh={handleRefresh}
        />

        {/* 5. Assignments (1 col) — click opens modal */}
        <button
          onClick={() => setOpenModal('assignments')}
          className="col-span-1 text-left group"
        >
          <Card title="Assignments" icon={GraduationCap} className="col-span-1 h-full hover:border-red-500/30 transition-colors cursor-pointer">
            <div className="flex flex-col justify-center h-full">
              <div className="flex flex-col p-4 bg-[#0a0a0a] rounded-lg border border-[#262626] gap-3">
                {primaryDeadline ? (
                  <>
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]" />
                      <span className="text-xs font-bold text-red-400 uppercase tracking-wider">{primaryDeadline.status || 'Pending'}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-sm font-bold text-gray-200 leading-tight line-clamp-2">{primaryDeadline.title}</span>
                      <span className="text-xs text-gray-500 mt-1">{primaryDeadline.due_date || 'Due date not detected'}</span>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col">
                    <span className="text-sm font-bold text-gray-200 leading-tight">No active assignments</span>
                    <span className="text-xs text-gray-500 mt-1">Detected deadlines will appear here.</span>
                  </div>
                )}
              </div>
            </div>
          </Card>
        </button>

        {/* 6. Projects Hub (2 cols) — has its own internal expand */}
        <ProjectsCard
          projects={overview?.projects || []}
          onProjectClick={openProjectDetail}
          onManage={() => setOpenModal('projects')}
        />
      </div>

      <TaskAlerter
        isOpen={showAlerter}
        onClose={() => setShowAlerter(false)}
        pendingGoals={dashboardAlertGoals}
        onMigrate={(goalIds) => { void handleMigrateAlerts(goalIds); }}
      />

      {/* ─── Detail Modals ─────────────────────────────────────────── */}

      <DetailModal
        title="Assignments & Deadlines"
        isOpen={openModal === 'assignments'}
        onClose={() => setOpenModal(null)}
      >
        <div className="space-y-3">
          <div className="p-3 bg-[#0a0a0a] border border-[#222] rounded-xl space-y-2">
            <p className="text-xs font-semibold text-cyan-400 uppercase tracking-wider">
              {editingDeadlineTitle ? 'Edit Deadline' : 'Add Deadline'}
            </p>
            <input
              value={deadlineForm.title}
              onChange={(e) => setDeadlineForm((p) => ({ ...p, title: e.target.value }))}
              placeholder="Title"
              className="w-full px-3 py-2 text-sm bg-[#111] border border-[#333] rounded text-gray-200 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
            />
            <input
              value={deadlineForm.due_date}
              onChange={(e) => setDeadlineForm((p) => ({ ...p, due_date: e.target.value }))}
              placeholder="Due (e.g. Today, 2026-03-01, tomorrow 5pm)"
              className="w-full px-3 py-2 text-sm bg-[#111] border border-[#333] rounded text-gray-200 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
            />
            <div className="flex gap-2">
              <select
                value={deadlineForm.status}
                onChange={(e) => setDeadlineForm((p) => ({ ...p, status: e.target.value }))}
                className="flex-1 px-3 py-2 text-sm bg-[#111] border border-[#333] rounded text-gray-200 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
              >
                <option value="pending">pending</option>
                <option value="active">active</option>
                <option value="completed">completed</option>
              </select>
              <button
                onClick={handleSaveDeadline}
                className="px-3 py-2 text-xs font-semibold rounded bg-cyan-500/20 border border-cyan-500/30 text-cyan-300"
              >
                {editingDeadlineTitle ? 'Save' : 'Add'}
              </button>
              {editingDeadlineTitle && (
                <button
                  onClick={resetDeadlineForm}
                  className="px-3 py-2 text-xs font-semibold rounded bg-[#1d1d1d] border border-[#333] text-gray-300"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>

          {(!overview?.deadlines || overview.deadlines.length === 0) ? (
            <div className="p-4 text-center text-sm text-gray-500 bg-[#0a0a0a] rounded-xl border border-[#222]">
              No pending assignments detected today.
            </div>
          ) : (
            overview.deadlines.map((a: any, i: number) => (
              <div
                key={i}
                className="w-full text-left flex items-start gap-3 p-3 bg-[#0a0a0a] border border-[#222] rounded-xl"
              >
                <button
                  type="button"
                  onClick={() => openDeadlineDetail(a)}
                  className="flex-1 text-left flex items-start gap-3"
                >
                  <div className={`w-2 h-2 rounded-full mt-1 flex-shrink-0 bg-amber-500`} />
                  <div>
                    <p className="text-sm font-semibold text-gray-200">{a.title}</p>
                    <p className="text-xs text-gray-500 mt-0.5">Due: {a.due_date || 'Unknown'}</p>
                  </div>
                </button>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => {
                      setEditingDeadlineTitle(a.title);
                      setDeadlineForm({
                        title: a.title || '',
                        due_date: a.due_date || '',
                        status: a.status || 'pending',
                        source: a.source || 'manual',
                      });
                    }}
                    className="px-2 py-1 text-[10px] rounded bg-[#1d1d1d] border border-[#333] text-gray-300"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDeleteDeadline(a.title)}
                    className="px-2 py-1 text-[10px] rounded bg-red-500/10 border border-red-500/30 text-red-300"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </DetailModal>

      <DetailModal
        title="Projects"
        isOpen={openModal === 'projects'}
        onClose={() => {
          setOpenModal(null);
          resetProjectForm();
        }}
      >
        <div className="space-y-3">
          <div className="p-3 bg-[#0a0a0a] border border-[#222] rounded-xl space-y-2">
            <p className="text-xs font-semibold text-cyan-400 uppercase tracking-wider">
              {editingProjectName ? 'Edit Project' : 'Add Project'}
            </p>
            <input
              value={projectForm.name}
              onChange={(e) => setProjectForm((p) => ({ ...p, name: e.target.value }))}
              placeholder="Project name"
              className="w-full px-3 py-2 text-sm bg-[#111] border border-[#333] rounded text-gray-200 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
            />
            <input
              value={projectForm.update}
              onChange={(e) => setProjectForm((p) => ({ ...p, update: e.target.value }))}
              placeholder="Update summary"
              className="w-full px-3 py-2 text-sm bg-[#111] border border-[#333] rounded text-gray-200 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
            />
            <div className="flex gap-2">
              <input
                type="number"
                min={0}
                value={projectForm.files_changed}
                onChange={(e) => setProjectForm((p) => ({ ...p, files_changed: Number(e.target.value) || 0 }))}
                placeholder="Files changed"
                className="w-36 px-3 py-2 text-sm bg-[#111] border border-[#333] rounded text-gray-200 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
              />
              <button
                onClick={handleSaveProject}
                className="px-3 py-2 text-xs font-semibold rounded bg-cyan-500/20 border border-cyan-500/30 text-cyan-300"
              >
                {editingProjectName ? 'Save' : 'Add'}
              </button>
              {editingProjectName && (
                <button
                  onClick={resetProjectForm}
                  className="px-3 py-2 text-xs font-semibold rounded bg-[#1d1d1d] border border-[#333] text-gray-300"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>

          {(!overview?.projects || overview.projects.length === 0) ? (
            <div className="p-4 text-center text-sm text-gray-500 bg-[#0a0a0a] rounded-xl border border-[#222]">
              No projects detected yet.
            </div>
          ) : (
            overview.projects.map((p: any, i: number) => (
              <div
                key={i}
                className="w-full text-left flex items-start gap-3 p-3 bg-[#0a0a0a] border border-[#222] rounded-xl"
              >
                <button type="button" onClick={() => openProjectDetail(p)} className="flex-1 text-left">
                  <p className="text-sm font-semibold text-gray-200">{p.name}</p>
                  <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{p.update}</p>
                </button>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => {
                      setEditingProjectName(p.name);
                      setProjectForm({
                        name: p.name || '',
                        update: p.update || '',
                        files_changed: Number(p.files_changed) || 0,
                      });
                    }}
                    className="px-2 py-1 text-[10px] rounded bg-[#1d1d1d] border border-[#333] text-gray-300"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDeleteProject(p.name)}
                    className="px-2 py-1 text-[10px] rounded bg-red-500/10 border border-red-500/30 text-red-300"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </DetailModal>



      <DetailModal
        title={expandedDetail?.title || 'Details'}
        isOpen={!!expandedDetail}
        onClose={() => setExpandedDetail(null)}
      >
        <div className="space-y-3">
          {expandedDetail?.subtitle && (
            <p className="text-xs text-cyan-400">{expandedDetail.subtitle}</p>
          )}
          <div className="p-3 bg-[#0a0a0a] border border-[#222] rounded-xl">
            <p className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">{expandedDetail?.body}</p>
          </div>
          <div className="p-3 bg-[#0a0a0a] border border-cyan-500/20 rounded-xl">
            <p className="text-xs font-semibold text-cyan-400 mb-2 uppercase tracking-wider">AI Summary</p>
            {expandedDetail?.loadingSummary ? (
              <p className="text-sm text-gray-500">Generating AI summary...</p>
            ) : (
              <p className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">
                {expandedDetail?.aiSummary || 'No AI summary available yet.'}
              </p>
            )}
          </div>
        </div>
      </DetailModal>
    </div>
  );
};
