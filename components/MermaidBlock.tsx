import React, { useEffect, useMemo, useState } from 'react';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';

let mermaidInitialized = false;
let mermaidThemeMode = '';

const ensureMermaidInit = () => {
  const scheme = document.documentElement.dataset.themeScheme === 'light' ? 'default' : 'dark';
  if (mermaidInitialized && mermaidThemeMode === scheme) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: scheme,
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
    <div
      className="my-3 overflow-x-auto rounded-lg border border-[#333] bg-[#111] p-2 [&>svg]:h-auto [&>svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['foreignObject'] }) }}
    />
  );
};

export const MermaidBlock = React.memo(MermaidBlockInner, (prev, next) => prev.chart === next.chart);
MermaidBlock.displayName = 'MermaidBlock';
