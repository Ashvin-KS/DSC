import React, { useEffect, useMemo, useState } from 'react';
import mermaid from 'mermaid';

let mermaidInitialized = false;
let mermaidThemeMode = '';

const ensureMermaidInit = () => {
  const isLight = document.documentElement.dataset.themeScheme === 'light';
  const scheme = isLight ? 'default' : 'dark';
  if (mermaidInitialized && mermaidThemeMode === scheme) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: scheme,
    flowchart: {
      htmlLabels: true,
      useMaxWidth: true
    },
    sequence: {
      useMaxWidth: true
    },
    themeVariables: {
      darkMode: !isLight,
      fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      primaryTextColor: isLight ? '#172033' : '#eef4ff',
      secondaryTextColor: isLight ? '#243044' : '#d8e0ee',
      tertiaryTextColor: isLight ? '#243044' : '#d8e0ee',
      nodeTextColor: isLight ? '#172033' : '#eef4ff',
      textColor: isLight ? '#172033' : '#eef4ff',
      mainBkg: isLight ? '#f8fbff' : '#141d28',
      secondBkg: isLight ? '#eef5ff' : '#182231',
      tertiaryBkg: isLight ? '#e7eef9' : '#202d3e',
      primaryBorderColor: isLight ? '#6f8199' : '#b6c1d4',
      lineColor: isLight ? '#516175' : '#b6c1d4',
      edgeLabelBackground: isLight ? '#ffffff' : '#101720'
    },
    securityLevel: 'strict',
    suppressErrorRendering: true
  } as any);
  mermaidInitialized = true;
  mermaidThemeMode = scheme;
};

interface MermaidBlockProps {
  chart: string;
}

const MermaidBlockInner: React.FC<MermaidBlockProps> = ({ chart }) => {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const renderId = useMemo(() => `mermaid-${Math.random().toString(36).slice(2, 10)}`, []);
  const normalizedChart = chart.replace(/\r\n/g, '\n').trim();

  useEffect(() => {
    let cancelled = false;

    const render = async () => {
      if (!normalizedChart) {
        setSvg('');
        setError('Empty Mermaid diagram');
        return;
      }

      try {
        ensureMermaidInit();
        const result = await mermaid.render(renderId, normalizedChart);
        if (cancelled) return;
        setSvg(result.svg);
        setError(null);
      } catch (err: any) {
        if (cancelled) return;
        setSvg('');
        setError(err?.message || 'Mermaid rendering failed');
      }
    };

    render();
    return () => {
      cancelled = true;
    };
  }, [normalizedChart, renderId]);

  if (error) {
    return (
      <div className="my-3 rounded-lg border border-red-500/30 bg-red-950/10 p-3">
        <div className="mb-2 text-xs text-red-300">Mermaid render error: {error}</div>
        <pre className="overflow-x-auto text-xs text-gray-300">{normalizedChart}</pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="my-3 rounded-lg border border-[#333] bg-[#1a1a1a] p-3 text-xs text-gray-400">
        Rendering Mermaid diagram...
      </div>
    );
  }

  return (
    <>
      <style>{`
        .atheletia-mermaid text,
        .atheletia-mermaid tspan,
        .atheletia-mermaid .nodeLabel,
        .atheletia-mermaid .label,
        .atheletia-mermaid .label text,
        .atheletia-mermaid .label span {
          color: var(--text-strong) !important;
          fill: var(--text-strong) !important;
        }

        .atheletia-mermaid .edgeLabel,
        .atheletia-mermaid .edgeLabel span,
        .atheletia-mermaid .edgeLabel text {
          color: var(--text-main) !important;
          fill: var(--text-main) !important;
          background-color: var(--bg-canvas) !important;
        }

        .atheletia-mermaid .node rect,
        .atheletia-mermaid .node circle,
        .atheletia-mermaid .node ellipse,
        .atheletia-mermaid .node polygon,
        .atheletia-mermaid .node path {
          fill: var(--bg-elev-1) !important;
          stroke: var(--text-muted) !important;
        }
      `}</style>
      <div
        className="atheletia-mermaid my-3 overflow-x-auto rounded-lg border border-[#333] bg-[#111] p-2 [&>svg]:h-auto [&>svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </>
  );
};

export const MermaidBlock = React.memo(MermaidBlockInner, (prev, next) => prev.chart === next.chart);
MermaidBlock.displayName = 'MermaidBlock';
