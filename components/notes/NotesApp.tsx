import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    Folder, File, ChevronRight, ChevronDown, Plus, Trash2,
    FolderOpen, Edit3, Save, X, RefreshCw, FolderPlus, FilePlus
} from 'lucide-react';
import { cacheFileContent, cacheFileTree, getCachedFileContent, getCachedFileTree, invalidateFileTreeCache } from '../../lib/notesCache';

interface FileNode {
    name: string;
    path: string;
    isDirectory: boolean;
    children?: FileNode[];
}

// Simple markdown renderer (supports headers, code, blockquotes, links)
const renderMarkdown = (content: string, vaultPath: string) => {
    if (!content) return null;

    const lines = content.split('\n');
    const elements: React.ReactNode[] = [];
    let inCodeBlock = false;
    let codeContent = '';
    let codeLanguage = '';

    lines.forEach((line, i) => {
        // Code blocks
        if (line.startsWith('```')) {
            if (!inCodeBlock) {
                inCodeBlock = true;
                codeLanguage = line.slice(3).trim();
                codeContent = '';
            } else {
                inCodeBlock = false;
                elements.push(
                    <pre key={i} style={{
                        background: '#1e1e1e',
                        padding: '12px',
                        borderRadius: '6px',
                        overflow: 'auto',
                        fontSize: '13px',
                        margin: '12px 0'
                    }}>
                        <code>{codeContent}</code>
                    </pre>
                );
            }
            return;
        }

        if (inCodeBlock) {
            codeContent += line + '\n';
            return;
        }

        // Headers
        if (line.startsWith('#### ')) {
            elements.push(<h4 key={i} style={{ color: '#fff', marginTop: '16px' }}>{line.slice(5)}</h4>);
            return;
        }
        if (line.startsWith('### ')) {
            elements.push(<h3 key={i} style={{ color: '#fff', marginTop: '20px' }}>{line.slice(4)}</h3>);
            return;
        }
        if (line.startsWith('## ')) {
            elements.push(<h2 key={i} style={{ color: '#fff', marginTop: '24px' }}>{line.slice(3)}</h2>);
            return;
        }
        if (line.startsWith('# ')) {
            elements.push(<h1 key={i} style={{ color: '#fff', marginTop: '28px' }}>{line.slice(2)}</h1>);
            return;
        }

        // Horizontal rule
        if (line.match(/^---+$/)) {
            elements.push(<hr key={i} style={{ border: '1px solid #333', margin: '20px 0' }} />);
            return;
        }

        // Blockquotes
        if (line.startsWith('> ')) {
            elements.push(
                <blockquote key={i} style={{
                    borderLeft: '3px solid #7c3aed',
                    paddingLeft: '16px',
                    color: '#d4d4d4',
                    margin: '8px 0'
                }}>
                    {line.slice(2)}
                </blockquote>
            );
            return;
        }

        // Obsidian image embed: ![[filename.png]]
        const imageMatch = line.match(/!\[\[([^\]]+)\]\]/);
        if (imageMatch) {
            const imageName = imageMatch[1];
            // Try to find image in vault
            elements.push(
                <div key={i} style={{ margin: '12px 0', color: '#888', fontStyle: 'italic' }}>
                    📷 [Image: {imageName}]
                </div>
            );
            return;
        }

        // Normal paragraph
        if (line.trim()) {
            // Parse inline formatting safely (no dangerouslySetInnerHTML)
            const parts: React.ReactNode[] = [];
            const inlineRegex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
            let lastIndex = 0;
            let match: RegExpExecArray | null;
            let partKey = 0;
            while ((match = inlineRegex.exec(line)) !== null) {
                if (match.index > lastIndex) {
                    parts.push(line.slice(lastIndex, match.index));
                }
                const token = match[0];
                if (token.startsWith('**') && token.endsWith('**')) {
                    parts.push(<strong key={`${i}-${partKey++}`}>{token.slice(2, -2)}</strong>);
                } else if (token.startsWith('*') && token.endsWith('*')) {
                    parts.push(<em key={`${i}-${partKey++}`}>{token.slice(1, -1)}</em>);
                } else if (token.startsWith('`') && token.endsWith('`')) {
                    parts.push(<code key={`${i}-${partKey++}`} style={{ background: '#333', padding: '2px 6px', borderRadius: '4px' }}>{token.slice(1, -1)}</code>);
                }
                lastIndex = match.index + token.length;
            }
            if (lastIndex < line.length) {
                parts.push(line.slice(lastIndex));
            }

            elements.push(
                <p key={i} style={{ margin: '8px 0', lineHeight: '1.6' }}>{parts.length > 0 ? parts : line}</p>
            );
        } else {
            elements.push(<br key={i} />);
        }
    });

    return elements;
};

// File Tree Item Component
const FileTreeItem: React.FC<{
    node: FileNode;
    depth: number;
    selectedPath: string | null;
    onSelect: (path: string) => void;
    onRefresh: () => void;
    expandedFolders: Set<string>;
    toggleFolder: (path: string) => void;
}> = React.memo(({ node, depth, selectedPath, onSelect, onRefresh, expandedFolders, toggleFolder }) => {
    const isExpanded = expandedFolders.has(node.path);
    const isSelected = selectedPath === node.path;

    return (
        <div>
            <div
                onClick={() => node.isDirectory ? toggleFolder(node.path) : onSelect(node.path)}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 8px',
                    paddingLeft: `${8 + depth * 16}px`,
                    cursor: 'pointer',
                    background: isSelected ? '#2d2d2d' : 'transparent',
                    borderRadius: '4px',
                    color: isSelected ? '#fff' : '#b3b3b3',
                    fontSize: '13px',
                }}
            >
                {node.isDirectory ? (
                    <>
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {isExpanded ? <FolderOpen size={16} color="#f9a825" /> : <Folder size={16} color="#f9a825" />}
                    </>
                ) : (
                    <>
                        <span style={{ width: 14 }} />
                        <File size={16} color="#7c3aed" />
                    </>
                )}
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {node.name.replace('.md', '')}
                </span>
            </div>

            {node.isDirectory && isExpanded && node.children && (
                <div>
                    {node.children.map((child) => (
                        <FileTreeItem
                            key={child.path}
                            node={child}
                            depth={depth + 1}
                            selectedPath={selectedPath}
                            onSelect={onSelect}
                            onRefresh={onRefresh}
                            expandedFolders={expandedFolders}
                            toggleFolder={toggleFolder}
                        />
                    ))}
                </div>
            )}
        </div>
    );
});

export const NotesApp: React.FC = () => {
    // Default to the Notes folder in the project
    const DEFAULT_VAULT = '';

    const [vaultPath, setVaultPath] = useState<string | null>(() => {
        return localStorage.getItem('notes_vaultPath') || DEFAULT_VAULT;
    });
    const [fileTree, setFileTree] = useState<FileNode[]>([]);
    const [selectedFile, setSelectedFile] = useState<string | null>(() => {
        return localStorage.getItem('notes_selectedFile');
    });
    const [fileContent, setFileContent] = useState<string>('');
    const [isEditing, setIsEditing] = useState(false);
    const [editContent, setEditContent] = useState('');
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
    const [showNewFileInput, setShowNewFileInput] = useState(false);
    const [newFileName, setNewFileName] = useState('');

    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Auto-connect to default vault or saved vault
    useEffect(() => {
        const saved = localStorage.getItem('notes_vaultPath');
        if (!saved) {
            // Only set default if nothing is saved
            localStorage.setItem('notes_vaultPath', DEFAULT_VAULT);
        }
    }, []);

    const loadFileTree = useCallback(async (force = false) => {
        if (!vaultPath || !window.nexusAPI?.notes) return;
        const cached = !force ? getCachedFileTree(vaultPath) : null;
        if (cached) {
            setFileTree(cached.tree);
            return;
        }
        const tree = await window.nexusAPI.notes.getFileTree(vaultPath);
        cacheFileTree(vaultPath, tree);
        setFileTree(tree);
    }, [vaultPath]);

    const selectVault = async () => {
        if (!window.nexusAPI?.notes) {
            alert('Notes API not available. Make sure you are running in the Tauri desktop app.');
            return;
        }
        const path = await window.nexusAPI.notes.selectVault();
        if (path) {
            setVaultPath(path);
            localStorage.setItem('notes_vaultPath', path);
        }
    };

    const openFile = useCallback(async (filePath: string, force = false) => {
        if (!window.nexusAPI?.notes) return;
        const content = !force
            ? getCachedFileContent(filePath) ?? await window.nexusAPI.notes.readFile(filePath)
            : await window.nexusAPI.notes.readFile(filePath);
        if (content !== null) {
            cacheFileContent(filePath, content);
            setSelectedFile(filePath);
            localStorage.setItem('notes_selectedFile', filePath);
            setFileContent(content);
            setIsEditing(false);
        }
    }, []);

    // Load file tree when vault changes
    useEffect(() => {
        if (vaultPath && window.nexusAPI?.notes) {
            loadFileTree();
            if (selectedFile) {
                openFile(selectedFile);
            }
        }
    }, [vaultPath, selectedFile, loadFileTree, openFile]);

    const saveFile = async () => {
        if (!selectedFile || !window.nexusAPI?.notes) return;
        const success = await window.nexusAPI.notes.writeFile(selectedFile, editContent);
        if (success) {
            cacheFileContent(selectedFile, editContent);
            setFileContent(editContent);
            setIsEditing(false);
        }
    };

    const createNewFile = async () => {
        if (!vaultPath || !newFileName.trim() || !window.nexusAPI?.notes) return;
        const result = await window.nexusAPI.notes.createFile(vaultPath, newFileName);
        if (result.success && result.path) {
            setShowNewFileInput(false);
            setNewFileName('');
            invalidateFileTreeCache(vaultPath);
            await loadFileTree();
            openFile(result.path);
        } else {
            alert(result.error || 'Failed to create file');
        }
    };

    const toggleFolder = (path: string) => {
        setExpandedFolders(prev => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    };

    const startEditing = () => {
        setEditContent(fileContent);
        setIsEditing(true);
        setTimeout(() => textareaRef.current?.focus(), 0);
    };

    // No vault selected
    if (!vaultPath) {
        return (
            <div style={{
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '16px',
                color: '#b3b3b3'
            }}>
                <Folder size={64} color="#7c3aed" />
                <h2 style={{ color: '#fff' }}>Welcome to Notes</h2>
                <p>Select a folder containing your markdown files</p>
                <button
                    onClick={selectVault}
                    style={{
                        padding: '12px 24px',
                        background: '#7c3aed',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        fontSize: '14px',
                        fontWeight: '600'
                    }}
                >
                    Open Vault Folder
                </button>
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', height: '100%', background: '#121212' }}>
            {/* Sidebar */}
            <div style={{
                width: '280px',
                background: '#1a1a1a',
                borderRight: '1px solid #2d2d2d',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden'
            }}>
                {/* Vault Header */}
                <div style={{
                    padding: '12px',
                    borderBottom: '1px solid #2d2d2d',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px'
                }}>
                    <Folder size={18} color="#7c3aed" />
                    <span style={{
                        flex: 1,
                        fontSize: '13px',
                        color: '#fff',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                    }}>
                        {vaultPath.split(/[/\\]/).pop()}
                    </span>
                    <button onClick={() => loadFileTree(true)} style={iconBtnStyle}><RefreshCw size={14} /></button>
                    <button onClick={() => setShowNewFileInput(true)} style={iconBtnStyle}><FilePlus size={14} /></button>
                </div>

                {/* New File Input */}
                {showNewFileInput && (
                    <div style={{ padding: '8px', borderBottom: '1px solid #2d2d2d' }}>
                        <input
                            autoFocus
                            value={newFileName}
                            onChange={(e) => setNewFileName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && createNewFile()}
                            placeholder="New note name..."
                            style={{
                                width: '100%',
                                padding: '8px',
                                background: '#2d2d2d',
                                border: 'none',
                                borderRadius: '4px',
                                color: '#fff',
                                fontSize: '13px'
                            }}
                        />
                    </div>
                )}

                {/* File Tree */}
                <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
                    {fileTree.map((node) => (
                        <FileTreeItem
                            key={node.path}
                            node={node}
                            depth={0}
                            selectedPath={selectedFile}
                            onSelect={openFile}
                            onRefresh={loadFileTree}
                            expandedFolders={expandedFolders}
                            toggleFolder={toggleFolder}
                        />
                    ))}
                </div>

                {/* Change Vault */}
                <button
                    onClick={selectVault}
                    style={{
                        margin: '8px',
                        padding: '8px',
                        background: '#2d2d2d',
                        border: 'none',
                        borderRadius: '4px',
                        color: '#888',
                        fontSize: '12px',
                        cursor: 'pointer'
                    }}
                >
                    Change Vault
                </button>
            </div>

            {/* Editor/Viewer */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {selectedFile ? (
                    <>
                        {/* Header */}
                        <div style={{
                            padding: '12px 16px',
                            borderBottom: '1px solid #2d2d2d',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '12px'
                        }}>
                            <h3 style={{ flex: 1, margin: 0, fontSize: '16px', color: '#fff' }}>
                                {selectedFile.split(/[/\\]/).pop()?.replace('.md', '')}
                            </h3>
                            {isEditing ? (
                                <>
                                    <button onClick={saveFile} style={{ ...actionBtnStyle, background: '#1ed760' }}>
                                        <Save size={14} /> Save
                                    </button>
                                    <button onClick={() => setIsEditing(false)} style={actionBtnStyle}>
                                        <X size={14} /> Cancel
                                    </button>
                                </>
                            ) : (
                                <button onClick={startEditing} style={actionBtnStyle}>
                                    <Edit3 size={14} /> Edit
                                </button>
                            )}
                        </div>

                        {/* Content */}
                        <div style={{ flex: 1, overflow: 'auto', padding: '24px' }}>
                            {isEditing ? (
                                <textarea
                                    ref={textareaRef}
                                    value={editContent}
                                    onChange={(e) => setEditContent(e.target.value)}
                                    style={{
                                        width: '100%',
                                        height: '100%',
                                        background: '#1a1a1a',
                                        border: '1px solid #2d2d2d',
                                        borderRadius: '8px',
                                        color: '#d4d4d4',
                                        fontSize: '14px',
                                        fontFamily: 'monospace',
                                        padding: '16px',
                                        resize: 'none',
                                        outline: 'none'
                                    }}
                                />
                            ) : (
                                <div style={{ color: '#d4d4d4', maxWidth: '800px' }}>
                                    {renderMarkdown(fileContent, vaultPath)}
                                </div>
                            )}
                        </div>
                    </>
                ) : (
                    <div style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#666'
                    }}>
                        Select a note to view
                    </div>
                )}
            </div>
        </div>
    );
};

const iconBtnStyle: React.CSSProperties = {
    background: 'transparent',
    border: 'none',
    color: '#888',
    cursor: 'pointer',
    padding: '4px'
};

const actionBtnStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 12px',
    background: '#2d2d2d',
    border: 'none',
    borderRadius: '4px',
    color: '#fff',
    fontSize: '12px',
    cursor: 'pointer'
};

export default NotesApp;
