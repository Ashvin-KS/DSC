import React, { useMemo, useState, useEffect, useRef } from 'react';
import { Code2, Copy, Maximize2, Monitor, Loader2 } from 'lucide-react';

const buildDocument = (html: string) => `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src data: blob:;" />
  <style>
    html, body { margin: 0; min-height: 100%; background: #0b0b0f; color: #f4f4f5; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
  </style>
</head>
<body>
${html}
</body>
</html>`;

export function VisualizeBlock({ html }: { html: string }) {
  const [mode, setMode] = useState<'preview' | 'code'>('preview');
  const [expanded, setExpanded] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const srcDoc = useMemo(() => buildDocument(html), [html]);

  useEffect(() => {
    setIsLoaded(false);
  }, [html]);

  const handleIframeLoad = () => {
    setIsLoaded(true);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(html);
    } catch {
      // Clipboard may be unavailable in some runtimes.
    }
  };

  return (
    <div className={`my-3 overflow-hidden rounded-lg border border-cyan-500/20 bg-[#07090d] ${expanded ? 'fixed inset-6 z-[220]' : ''}`}>
      <div className="flex items-center justify-between gap-2 border-b border-white/10 bg-white/[0.04] px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-cyan-200">
          <Monitor size={14} />
          Visualize
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setMode(mode === 'preview' ? 'code' : 'preview')}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-white/10 px-2 text-[11px] text-gray-300 hover:bg-white/10"
            title={mode === 'preview' ? 'Show code' : 'Show preview'}
          >
            <Code2 size={12} />
            {mode === 'preview' ? 'Code' : 'Preview'}
          </button>
          <button onClick={copy} className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/10 text-gray-300 hover:bg-white/10" title="Copy HTML">
            <Copy size={12} />
          </button>
          <button onClick={() => setExpanded((v) => !v)} className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/10 text-gray-300 hover:bg-white/10" title={expanded ? 'Collapse' : 'Expand'}>
            <Maximize2 size={12} />
          </button>
        </div>
      </div>

      {mode === 'preview' ? (
        <div className={`relative bg-white ${expanded ? 'h-[calc(100%-44px)]' : 'h-80'}`}>
          {!isLoaded && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#0b0b0f]">
              <div className="flex flex-col items-center gap-2">
                <Loader2 size={20} className="animate-spin text-cyan-400" />
                <span className="text-xs text-gray-500">Rendering...</span>
              </div>
            </div>
          )}
          <iframe
            ref={iframeRef}
            title="Visualize preview"
            sandbox="allow-scripts"
            srcDoc={srcDoc}
            onLoad={handleIframeLoad}
            className="w-full h-full"
          />
        </div>
      ) : (
        <pre className={`overflow-auto whitespace-pre-wrap p-4 text-xs leading-relaxed text-gray-200 ${expanded ? 'h-[calc(100%-44px)]' : 'max-h-80'}`}>
          <code>{html}</code>
        </pre>
      )}
    </div>
  );
}
