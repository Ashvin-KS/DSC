type HandlerDeps = Record<string, any>;

export const createTryHandleVaultMultiFileChainIntent =
  (deps: HandlerDeps) =>
  async (messageText: string): Promise<boolean> => {
    const {
      extractVaultFolderListQuery,
      loadFileTree,
      resolveVaultDestinationDirectory,
      resolveVaultDestinationWithConfidence,
      syncVaultSubtreeInBackground,
      toVaultRelativePath,
      vaultActionRoot,
      vaultMultiFileChain,
      vaultPath,
      setVaultMultiFileChain,
      setVaultMessages,
      setVaultStatusMessage,
      isMultiFileVaultIntent,
      extractVaultDestinationHint,
      areEquivalentPaths,
      isMultiFileChainDoneSignal,
      parseMultiFileInstruction,
      normalizeMarkdownFileName,
      sanitizeProposedMarkdown,
      buildMultiFileStarterMarkdown,
      invalidateFileTreeCache,
    } = deps;

    if (!window.atheletiaAPI?.notes) return false;

    const userInput = (messageText || '').trim();
    if (!userInput) return false;

    if (!vaultMultiFileChain) {
      if (!isMultiFileVaultIntent(userInput)) return false;

      const destinationHint = extractVaultDestinationHint(userInput) || extractVaultFolderListQuery(userInput);
      const destinationResolution = resolveVaultDestinationWithConfidence(destinationHint, 6);
      const destinationPath = destinationResolution.resolvedPath
        || resolveVaultDestinationDirectory(destinationHint)
        || vaultActionRoot;

      setVaultMultiFileChain({
        baseTask: userInput,
        destinationPath,
        createdPaths: [],
      });

      const destinationLabel = toVaultRelativePath(destinationPath);
      const alternativeDestinations = destinationResolution.candidates
        .filter((path: string) => !areEquivalentPaths(path, destinationPath))
        .slice(0, 4)
        .map((path: string) => `- ${toVaultRelativePath(path)}`)
        .join('\n');

      setVaultMessages((prev: any[]) => [...prev, {
        sender: 'ai',
        text: `Multi-file chain started.\nBase task remembered: "${userInput}"\nDestination folder: ${destinationLabel}\n\nSend files one by one in this format:\nname :: markdown content\n\nYou can also send only a file name and I will create a starter note.\nType "done" when all files are created.${alternativeDestinations ? `\n\nOther matching folders:\n${alternativeDestinations}` : ''}`
      }]);
      setVaultStatusMessage(`Multi-file chain active in ${destinationLabel}.`);
      return true;
    }

    if (isMultiFileChainDoneSignal(userInput)) {
      const createdList = vaultMultiFileChain.createdPaths.length
        ? vaultMultiFileChain.createdPaths
          .map((path: string, index: number) => `${index + 1}. ${toVaultRelativePath(path)}`)
          .join('\n')
        : 'No files were created in this chain.';

      setVaultMessages((prev: any[]) => [...prev, {
        sender: 'ai',
        text: `Multi-file chain completed.\nBase task: "${vaultMultiFileChain.baseTask}"\n\nCreated files:\n${createdList}`
      }]);
      setVaultMultiFileChain(null);
      setVaultStatusMessage('Multi-file chain completed.');
      return true;
    }

    const perTurnDestinationHint = extractVaultDestinationHint(userInput);
    const perTurnDestination = perTurnDestinationHint
      ? (resolveVaultDestinationWithConfidence(perTurnDestinationHint, 6).resolvedPath
        || resolveVaultDestinationDirectory(perTurnDestinationHint)
        || vaultMultiFileChain.destinationPath)
      : vaultMultiFileChain.destinationPath;

    const instruction = parseMultiFileInstruction(userInput);
    if (!instruction.title) {
      setVaultMessages((prev: any[]) => [...prev, {
        sender: 'ai',
        text: `Multi-file chain is still active for "${vaultMultiFileChain.baseTask}".\nSend one file at a time like:\nname :: markdown content\n\nOr type "done" to finish.`
      }]);
      return true;
    }

    const normalizedTitle = normalizeMarkdownFileName(instruction.title);
    const ensured = await window.atheletiaAPI.notes.ensureDir(perTurnDestination);
    if (!ensured.success) {
      setVaultMessages((prev: any[]) => [...prev, {
        sender: 'ai',
        text: `Could not access destination folder ${toVaultRelativePath(perTurnDestination)}: ${ensured.error || 'unknown error'}`
      }]);
      return true;
    }

    const created = await window.atheletiaAPI.notes.createFile(perTurnDestination, normalizedTitle);
    if (!created.success || !created.path) {
      setVaultMessages((prev: any[]) => [...prev, {
        sender: 'ai',
        text: `Create note failed for ${normalizedTitle}: ${created.error || 'unknown error'}. Send a different file name or type "done".`
      }]);
      return true;
    }
    const createdPath = created.path;

    const cleanedContent = sanitizeProposedMarkdown(instruction.content || '', { aggressive: false })
      || instruction.content?.trim()
      || buildMultiFileStarterMarkdown(normalizedTitle);
    const wrote = await window.atheletiaAPI.notes.writeFile(createdPath, cleanedContent);
    if (!wrote) {
      setVaultMessages((prev: any[]) => [...prev, {
        sender: 'ai',
        text: `Created ${toVaultRelativePath(createdPath)}, but writing markdown content failed.`
      }]);
      return true;
    }

    invalidateFileTreeCache(vaultPath);
    syncVaultSubtreeInBackground(createdPath);
    void loadFileTree(true);

    setVaultMultiFileChain((prev: any) => {
      if (!prev) return prev;
      return {
        ...prev,
        destinationPath: perTurnDestination,
        createdPaths: [...prev.createdPaths, createdPath],
      };
    });

    setVaultMessages((prev: any[]) => [...prev, {
      sender: 'ai',
      text: `Created ${toVaultRelativePath(createdPath)}.\nBase task still active: "${vaultMultiFileChain.baseTask}"\nSend the next file (name :: content), or type "done".`
    }]);
    setVaultStatusMessage(`Created ${toVaultRelativePath(createdPath)} in multi-file chain.`);
    return true;
  };

export const createTryHandleVaultFileListIntent =
  (deps: HandlerDeps) =>
  (messageText: string): boolean => {
    const {
      collectMarkdownFilesForDirectory,
      extractVaultFolderListQuery,
      fileTree,
      pushVaultOpenChoiceMessage,
      selectedDirectoryPath,
      selectedFile,
      suggestVaultDirectoryPaths,
      toVaultRelativePath,
      vaultActionRoot,
      vaultPath,
      isBulkVaultOpenIntent,
      isVaultInventoryIntent,
      getDirectoryForNodePath,
      setVaultMessages,
    } = deps;

    const wantsBulkOpen = isBulkVaultOpenIntent(messageText);
    const wantsInventory = isVaultInventoryIntent(messageText);
    const folderQuery = extractVaultFolderListQuery(messageText);
    if (!folderQuery && !wantsBulkOpen && !wantsInventory) {
      return false;
    }

    if (wantsInventory && !folderQuery) {
      const rootDirectories = fileTree
        .filter((node: any) => node.isDirectory)
        .slice(0, 8);
      const rootNotes = collectMarkdownFilesForDirectory(vaultActionRoot, 200);

      if (!rootDirectories.length && !rootNotes.length) {
        setVaultMessages((prev: any[]) => [...prev, {
          sender: 'ai',
          text: 'The current vault has no markdown notes yet.'
        }]);
        return true;
      }

      const folderLines = rootDirectories
        .map((node: any, index: number) => `${index + 1}. ${toVaultRelativePath(node.path)}`)
        .join('\n');

      const options = rootDirectories.map((node: any) => ({
        id: `list_folder:${node.path}`,
        action: 'list_folder',
        value: node.path,
        label: node.name,
        description: toVaultRelativePath(node.path),
      }));

      setVaultMessages((prev: any[]) => [...prev, {
        sender: 'ai',
        text: `Vault overview: ${rootNotes.length} markdown ${rootNotes.length === 1 ? 'note' : 'notes'} indexed under ${rootDirectories.length} top-level ${rootDirectories.length === 1 ? 'folder' : 'folders'}.${folderLines ? `\n\nTop folders:\n${folderLines}` : ''}`,
        options: options.length ? options : undefined,
      }]);
      return true;
    }

    const fallbackDirectory =
      selectedDirectoryPath
      || (selectedFile ? getDirectoryForNodePath(selectedFile, fileTree, vaultPath) : null)
      || vaultActionRoot;

    const directoryCandidates = folderQuery
      ? suggestVaultDirectoryPaths(folderQuery, 6)
      : (fallbackDirectory ? [fallbackDirectory] : []);

    if (!directoryCandidates.length) {
      setVaultMessages((prev: any[]) => [...prev, {
        sender: 'ai',
        text: folderQuery
          ? `I could not find a folder matching "${folderQuery}" in this vault. Try a more specific folder name.`
          : 'I could not determine which folder to use. Select a folder in the vault tree or mention one explicitly.'
      }]);
      return true;
    }

    if (directoryCandidates.length > 1) {
      const options = directoryCandidates.slice(0, 6).map((path: string) => {
        const relative = toVaultRelativePath(path);
        return {
          id: `list_folder:${path}`,
          action: 'list_folder',
          value: path,
          label: (path.split(/[/\\]/).pop() || relative || path),
          description: relative,
        };
      });
      const lines = options
        .map((option: any, index: number) => `${index + 1}. ${option.description || option.label}`)
        .join('\n');

      setVaultMessages((prev: any[]) => [...prev, {
        sender: 'ai',
        text: `I found multiple folders matching "${folderQuery}". Pick one folder below and I will list the files so you can choose exactly which note to open.\n\n${lines}`,
        options,
      }]);
      return true;
    }

    const selectedDirectory = directoryCandidates[0];
    const files = collectMarkdownFilesForDirectory(selectedDirectory, 120);
    if (!files.length) {
      const locationLabel = toVaultRelativePath(selectedDirectory) || '.';
      setVaultMessages((prev: any[]) => [...prev, {
        sender: 'ai',
        text: `I found ${locationLabel}, but there are no markdown notes there.`
      }]);
      return true;
    }

    pushVaultOpenChoiceMessage(
      files,
      wantsBulkOpen
        ? `I can't open every file at once in Note mode. I found ${files.length} markdown ${files.length === 1 ? 'file' : 'files'} under ${toVaultRelativePath(selectedDirectory)}. Choose the exact file you want to open.`
        : `I found ${files.length} markdown ${files.length === 1 ? 'file' : 'files'} under ${toVaultRelativePath(selectedDirectory)}.`
    );
    return true;
  };

export const createHandleAiSend =
  (deps: HandlerDeps) =>
  async (
    messageText: string,
    sendOptions?: {
      displayUserText?: string;
      skipVaultFileListIntent?: boolean;
      skipVaultMultiFileChainIntent?: boolean;
    }
  ) => {
    const {
      isAiLoading,
      brainScope,
      vaultPath,
      setCurrentMessages,
      aiProvider,
      nvidiaApiKey,
      abortControllerRef,
      selectedContext,
      selectionRange,
      tiptapRange,
      isEditing,
      setSelectedContext,
      setTiptapRange,
      setSelectionRange,
      setIsAiLoading,
      setProposedAction,
      setVaultSearchMeta,
      setIsVaultSearchLoading,
      setVaultStatusMessage,
      tryHandleVaultMultiFileChainIntent,
      tryHandleVaultFileListIntent,
      editContent,
      fileContent,
      availableModels,
      selectedModel,
      DEFAULT_NIM_MODEL,
      buildBrainVaultContext,
      aiMode,
      selectedFile,
      buildBrainNoteContext,
      buildModelConversation,
      currentMessages,
      setStreamingMsgIndex,
      sanitizeVisibleBrainResponse,
      parseActionPayload,
      normalizeClarificationOptions,
      isExplicitWholeRewriteIntent,
      sanitizeProposedMarkdown,
      inferActionContentFromResponse,
      requestsCreateAndWriteInVault,
      extractRequestedNoteTitle,
      resolveVaultDestinationWithConfidence,
      vaultActionRoot,
      isBulkVaultOpenIntent,
      resolveVaultDestinationDirectory,
      selectedDirectoryPath,
      getDirectoryForNodePath,
      fileTree,
      collectMarkdownFilesForDirectory,
      toVaultRelativePath,
      buildVaultOpenOptions,
      buildVaultAnswerOptionsFromPaths,
      collectMarkdownPaths,
      getVaultDirectoryCandidates,
      resolveVaultFilePathWithConfidence,
      resolveVaultNodePathWithConfidence,
      buildBrainActionPreview,
      suggestVaultNotePaths,
      getErrorMessage,
      looksLikeClarificationQuestion,
      isAmbiguousOperationRequest,
      normalizeMarkdownFileName,
    } = deps;

    if (!messageText.trim() || isAiLoading) return;

    if (brainScope === 'vault' && !vaultPath) {
      setCurrentMessages((prev: any[]) => [...prev, {
        sender: 'ai',
        text: 'Select a vault folder first. Vault mode cannot search or mutate notes until a vault is chosen.'
      }]);
      return;
    }

    if (aiProvider === 'nvidia' && !nvidiaApiKey) {
      setCurrentMessages((prev: any[]) => [...prev, {
        sender: 'ai',
        text: 'NVIDIA API key is missing. Add it in Settings -> API Keys, or switch provider to local LM Studio.'
      }]);
      return;
    }

    abortControllerRef.current = new AbortController();

    const userMessage = messageText.trim();
    const userDisplayText = sendOptions?.displayUserText?.trim() || userMessage;
    const usedContext = selectedContext;
    const usedRange = selectionRange;
    const usedTiptapRange = tiptapRange;
    const wasEditing = isEditing;

    setCurrentMessages((prev: any[]) => [...prev, { sender: 'user', text: userDisplayText, context: brainScope === 'note' ? (usedContext || undefined) : undefined }]);
    setSelectedContext('');
    setTiptapRange(null);
    setSelectionRange(null);
    setIsAiLoading(true);
    setProposedAction(null);
    if (brainScope === 'vault') {
      setVaultSearchMeta(null);
      setIsVaultSearchLoading(true);
      setVaultStatusMessage('Searching the markdown vault for matching notes and folders...');
    }

    if (brainScope === 'vault' && !sendOptions?.skipVaultMultiFileChainIntent) {
      const handledByMultiFileChain = await tryHandleVaultMultiFileChainIntent(userMessage);
      if (handledByMultiFileChain) {
        abortControllerRef.current = null;
        setIsVaultSearchLoading(false);
        setIsAiLoading(false);
        return;
      }
    }

    if (brainScope === 'vault' && !sendOptions?.skipVaultFileListIntent && tryHandleVaultFileListIntent(userMessage)) {
      abortControllerRef.current = null;
      setIsVaultSearchLoading(false);
      setIsAiLoading(false);
      setVaultStatusMessage('Listed files directly from the current vault tree.');
      return;
    }

    try {
      const currentEditorContent = wasEditing ? editContent : fileContent;
      const fallbackModel = availableModels[0]?.id || DEFAULT_NIM_MODEL;
      const effectiveModel = availableModels.some((m: any) => m.id === selectedModel)
        ? selectedModel
        : fallbackModel;

      let systemPrompt = '';
      let contextPayload = '';
      if (brainScope === 'vault') {
        const vaultSearch = await window.atheletiaAPI?.notes?.searchVault?.(vaultPath, userMessage, 8);
        const asksEvidenceQuestion = /\b(what|which|where|find|search|summari[sz]e|explain|tell|show|list|contains?|inside|about)\b/i.test(userMessage);
        if (vaultSearch) {
          setVaultSearchMeta(vaultSearch);
          const hitCount = vaultSearch.hits?.length || 0;
          setVaultStatusMessage(
            hitCount > 0
              ? `Found ${hitCount} vault match${hitCount === 1 ? '' : 'es'} across ${vaultSearch.indexedFiles} indexed notes.`
              : `Searched ${vaultSearch.indexedFiles} indexed notes but found no direct match for that query.`
          );
          if (asksEvidenceQuestion && vaultSearch.indexedFiles === 0) {
            setCurrentMessages((prev: any[]) => [...prev, {
              sender: 'ai',
              text: 'The vault index has no markdown notes yet, so I cannot answer that from grounded note evidence. Reindex the vault after adding notes, then ask again.'
            }]);
            abortControllerRef.current = null;
            setIsVaultSearchLoading(false);
            setIsAiLoading(false);
            return;
          }
          if (asksEvidenceQuestion && hitCount === 0) {
            setCurrentMessages((prev: any[]) => [...prev, {
              sender: 'ai',
              text: `I searched ${vaultSearch.indexedFiles} indexed note${vaultSearch.indexedFiles === 1 ? '' : 's'} but found no grounded match for that question. Try a more specific keyword or reindex if the note was changed recently.`
            }]);
            abortControllerRef.current = null;
            setIsVaultSearchLoading(false);
            setIsAiLoading(false);
            return;
          }
        } else {
          setVaultStatusMessage('Vault search returned no result metadata.');
        }
        systemPrompt = `You are Atheletia Vault AI.

MODE:
VAULT MODE: search and organize the user's markdown vault.

Scope rules:
- Use only markdown note evidence from the provided vault context.
- The index root is fixed. Never use a destination outside that root.
- Do not invent files, folders, headings, or note contents.
- Prefer the current selected folder or current open note folder as the default destination when the user does not name one.
- Ask for destination clarification only when the user explicitly names a path and multiple strong matches exist.
- Never reveal hidden reasoning, chain-of-thought, or meta commentary.
- Do not write prefatory analysis like "The user asks", "According to instructions", or "In the vault evidence".
- If nothing relevant is found, answer briefly and directly in plain language.

Allowed JSON actions:
- create_note
- edit_note
- create_folder
- move_note
- open_note
- rename_note
- delete_item
- ask_question

Output rules:
- If no filesystem action is needed, respond in plain markdown only.
- If an action is needed, include exactly one JSON object wrapped in <atheletia_action_json>...</atheletia_action_json>.
- For create_note include: action, title, destination_path, content, explanation.
- For edit_note include: action, target_path, target_text (optional), content, explanation.
- For create_folder include: action, title, destination_path, explanation.
- For move_note include: action, source_path, destination_path, explanation.
- For open_note include: action, target_path, explanation.
- For rename_note include: action, target_path, new_name, explanation.
- For delete_item include: action, target_path, explanation.
- For ask_question include: action, question, options (array), allow_free_text (bool), free_text_placeholder (optional), explanation.
- If clarification is needed, do not ask a plain-text question; emit ask_question JSON.
- For open_note or edit_note, target_path must be an absolute path or a path relative to the index root.
- For create_note and edit_note also mirror markdown body in <atheletia_content>...</atheletia_content>.
- If destination is ambiguous after explicit user path input, emit ask_question instead of emitting a filesystem mutation.
- For open_note, edit_note, move_note, rename_note, and delete_item: if multiple path candidates are possible, emit ask_question with concrete path options.
- For create_note and create_folder: omit destination_path when the user did not specify one and rely on the current selected folder / open note folder / vault root default.
- For edit_note, if it is unclear whether user wants rewrite vs append vs section-only edits, emit ask_question first.
- Use provided candidate folders/notes when you must disambiguate.
- If destination evidence is weak, leave destination_path blank instead of inventing a folder.`;
        contextPayload = buildBrainVaultContext({
          userMessage,
          vaultSearch,
        });
      } else {
        const currentEditorContent = wasEditing ? editContent : fileContent;
        const isSelectionActive = Boolean(usedContext && usedContext.trim());
        contextPayload = selectedFile
          ? buildBrainNoteContext({
            content: currentEditorContent,
            userMessage,
            notePath: selectedFile,
            selectedText: usedContext || undefined,
            selectedRange: usedRange || undefined,
          })
          : 'No note currently open.';

        systemPrompt = aiMode === 'edit'
          ? `You are Atheletia AI, an editor assistant with an orchestration layer.\n\nMODE:\nEDIT MODE: return precise edit actions.\n\nYou are given cleaned note context built from the current note only. Use the ACTIVE SELECTION first when it exists; it is the highest-priority target and should override older chat context.\n\nOutput rules:\n- Always include ONE JSON object at the end of the response.\n- Wrap the JSON in <atheletia_action_json>...</atheletia_action_json> tags.\n- JSON action must be one of: insert_content, create_note, replace_selection, insert_at_cursor, find_and_replace, replace_all, ask_question.\n- For find_and_replace, include exact target_text from the provided note context.\n- For any edit action, content must be non-empty and must be the exact insertion text.\n- For replace_all, content must be the complete final note.\n- Never use replace_all unless the user explicitly requested full rewrite or whole-note reformatting.\n- If intent is ambiguous (rewrite vs append vs section edit, or target section unclear), use ask_question first.\n- If clarification is needed, do not ask a plain-text question; emit ask_question JSON.\n- Also include the same insertion body in <atheletia_content>...</atheletia_content> tags for write actions.\n- Do not duplicate sections or reintroduce older content that is not in the current note context.\n- Keep explanation short and concrete.\n\nJSON schema:\n<atheletia_action_json>\n{\n  "action": "find_and_replace",\n  "target_text": "exact text",\n  "content": "replacement",\n  "explanation": "why"\n}\n</atheletia_action_json>\n\nClarification schema (when uncertain):\n<atheletia_action_json>\n{\n  "action": "ask_question",\n  "question": "What should I do in this note?",\n  "options": [\n    { "label": "Add a new section", "value": "add_section" },\n    { "label": "Edit existing section only", "value": "edit_section" },\n    { "label": "Rewrite whole note", "value": "rewrite_note" }\n  ],\n  "allow_free_text": true,\n  "free_text_placeholder": "Type custom instructions",\n  "explanation": "Need clarification before editing"\n}\n</atheletia_action_json>\n\nOptional content mirror:\n<atheletia_content>\nreplacement\n</atheletia_content>\n\nSelection constraints:\n${isSelectionActive
            ? (wasEditing
              ? 'User selected text in editor. Prefer replace_selection.'
              : 'User selected text in rendered view. Prefer find_and_replace with exact raw markdown target_text.')
            : 'No explicit selection. Use insert_at_cursor for additions; use replace_all only for full rewrites.'}`
          : `You are Atheletia AI, a teaching assistant with an orchestration layer.\n\nMODE:\nLECTURE MODE: teach only.\n\nYou are given cleaned note context built from the current note only. Use the ACTIVE SELECTION first when it exists and do not drift to older unrelated chat or note content.\n\nOutput rules:\n- Explain and teach in plain markdown.\n- Do NOT output any JSON object.\n- Do NOT output <atheletia_action_json> or <atheletia_content> tags.\n- Do NOT propose file edits, replacements, or apply/discard style actions.\n- Keep the response instructional, concrete, and structured.`;
      }

      const buildMessages = () => {
        const convoContext = buildModelConversation(currentMessages, brainScope === 'note' ? aiMode : 'lecture');
        return [
          { role: 'system', content: systemPrompt },
          ...convoContext,
          { role: 'user', content: `${userMessage}\n\nCONTEXT:\n${contextPayload}` }
        ];
      };

      let aiResponse = '';
      let msgIdx = -1;

      setCurrentMessages((prev: any[]) => {
        const newMsg = { sender: 'ai' as const, text: '' };
        const next = [...prev, newMsg];
        msgIdx = next.length - 1;
        return next;
      });
      setStreamingMsgIndex(msgIdx);

      const isLocal = aiProvider === 'local' || aiProvider === 'lmstudio';
      const msgs = buildMessages();

      const { listen } = await import('@tauri-apps/api/event');
      const unlistenToken = await listen<string>('brain://token', (event) => {
        aiResponse += event.payload;
        setCurrentMessages((prev: any[]) => {
          const next = [...prev];
          const msg = next[msgIdx];
          if (msg && msg.sender === 'ai') {
            next[msgIdx] = { ...msg, text: msg.text + event.payload };
          }
          return next;
        });
      });

      try {
        await window.atheletiaAPI!.settings!.brainChatStream!(
          effectiveModel,
          msgs,
          isLocal,
          65536,
          aiMode === 'edit' ? 0.15 : 0.45,
          undefined,
          nvidiaApiKey,
        );
      } catch (err: any) {
        setCurrentMessages((prev: any[]) => prev.filter((_, i) => i !== msgIdx));
        setStreamingMsgIndex(null);
        throw err;
      } finally {
        unlistenToken();
      }

      if (!aiResponse.trim()) {
        aiResponse = 'Sorry, I could not generate a response.';
      }
      const visibleAiResponse = sanitizeVisibleBrainResponse(aiResponse);
      const finalMessageText = aiResponse.trim() ? aiResponse : visibleAiResponse;
      const fallbackVisibleResponse = brainScope === 'vault'
        ? 'I can help with your vault. What would you like to do?'
        : 'I can help with this note. What would you like to do?';
      setCurrentMessages((prev: any[]) => {
        const next = [...prev];
        if (next[msgIdx]) next[msgIdx] = { ...next[msgIdx], text: finalMessageText || fallbackVisibleResponse };
        return next;
      });
      setStreamingMsgIndex(null);

      if (brainScope === 'note' && aiMode !== 'edit') {
        setProposedAction(null);
        return;
      }

      const actionData = parseActionPayload(aiResponse);
      const validActions = brainScope === 'vault'
        ? ['create_note', 'edit_note', 'create_folder', 'move_note', 'open_note', 'rename_note', 'delete_item', 'ask_question']
        : ['insert_content', 'create_note', 'replace_selection', 'insert_at_cursor', 'find_and_replace', 'replace_all', 'ask_question'];

      if (actionData?.action && validActions.includes(actionData.action)) {
        const pushClarificationQuestionOnLastMessage = (
          questionPrompt: string,
          questionOptions: any[],
          placeholder = 'Type your answer'
        ) => {
          const questionId = `question_${Date.now()}`;
          const scopedOptions = questionOptions.map((option, index) => ({
            ...option,
            id: `${questionId}:option:${index}`,
            action: 'answer_question' as const,
            questionId,
          }));

          setCurrentMessages((prev: any[]) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.sender === 'ai') {
              last.isAction = false;
              last.text = questionPrompt;
              last.options = scopedOptions;
              last.questionPrompt = questionPrompt;
              last.questionId = questionId;
              last.allowFreeTextReply = true;
              last.freeTextReplyPlaceholder = placeholder;
            }
            return next;
          });
        };

        const setLastAiActionMessage = (text: string, options?: any[]) => {
          setCurrentMessages((prev: any[]) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.sender === 'ai') {
              last.isAction = !options?.length;
              last.text = text;
              last.options = options;
              last.questionPrompt = undefined;
              last.questionId = undefined;
              last.allowFreeTextReply = undefined;
              last.freeTextReplyPlaceholder = undefined;
            }
            return next;
          });
        };

        if (actionData.action === 'ask_question') {
          const questionId = (actionData.question_id || `question_${Date.now()}`).trim();
          const questionPrompt = (actionData.question || actionData.explanation || visibleAiResponse || '').trim()
            || 'I need a quick clarification before I proceed.';
          const questionOptions = normalizeClarificationOptions(actionData.options, questionId);
          const allowFreeTextReply = actionData.allow_free_text !== false;
          const freeTextReplyPlaceholder = actionData.free_text_placeholder?.trim() || 'Type your answer';

          setCurrentMessages((prev: any[]) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.sender === 'ai') {
              last.isAction = false;
              last.text = questionPrompt;
              last.options = questionOptions.length ? questionOptions : undefined;
              last.questionPrompt = questionPrompt;
              last.questionId = questionId;
              last.allowFreeTextReply = allowFreeTextReply;
              last.freeTextReplyPlaceholder = freeTextReplyPlaceholder;
            }
            return next;
          });

          setProposedAction(null);
          return;
        }

        if (actionData.action === 'replace_all' && !isExplicitWholeRewriteIntent(userMessage)) {
          pushClarificationQuestionOnLastMessage(
            'Before I edit this note, should I rewrite the whole note or only update a section?',
            [
              { id: 'clarify:section_edit', action: 'answer_question', label: 'Update a section only', value: 'update_section_only' },
              { id: 'clarify:add_section', action: 'answer_question', label: 'Add a new section', value: 'add_new_section' },
              { id: 'clarify:rewrite_whole', action: 'answer_question', label: 'Rewrite the whole note', value: 'rewrite_whole_note' },
            ],
            'Tell me exactly which part to edit (or say rewrite whole note)'
          );
          setProposedAction(null);
          return;
        }

        if (actionData.action === 'edit_note' && !actionData.target_text?.trim() && !isExplicitWholeRewriteIntent(userMessage)) {
          pushClarificationQuestionOnLastMessage(
            'For this file edit, do you want to append content, edit an existing section, or rewrite the whole note?',
            [
              { id: 'clarify:append', action: 'answer_question', label: 'Append new content', value: 'append_content' },
              { id: 'clarify:edit_existing', action: 'answer_question', label: 'Edit existing section', value: 'edit_existing_section' },
              { id: 'clarify:rewrite', action: 'answer_question', label: 'Rewrite whole note', value: 'rewrite_whole_note' },
            ],
            'If editing existing text, mention heading/snippet to target'
          );
          setProposedAction(null);
          return;
        }

        if (brainScope === 'vault') {
          const normalizedTitle = actionData.action === 'create_note' && actionData.title
            ? normalizeMarkdownFileName(actionData.title)
            : (actionData.new_name?.trim() || actionData.title?.trim());
          const resolvedVaultContent = (actionData.action === 'create_note' || actionData.action === 'edit_note')
            ? (sanitizeProposedMarkdown(actionData.content) || inferActionContentFromResponse(actionData.action, aiResponse))
            : undefined;
          const promoteFolderCreateToNote = actionData.action === 'create_folder' && requestsCreateAndWriteInVault(userMessage);
          const effectiveVaultAction = promoteFolderCreateToNote ? 'create_note' : actionData.action;
          const effectiveVaultTitle = effectiveVaultAction === 'create_note'
            ? (extractRequestedNoteTitle(userMessage)
              || (normalizedTitle ? normalizeMarkdownFileName(normalizedTitle) : normalizeMarkdownFileName('Untitled note')))
            : normalizedTitle;
          const effectiveVaultContent = effectiveVaultAction === 'create_note'
            ? (resolvedVaultContent || inferActionContentFromResponse('create_note', aiResponse))
            : resolvedVaultContent;

          let resolvedSourcePath = actionData.source_path?.trim();
          let resolvedTargetPath = actionData.target_path?.trim();
          const destinationResolution = resolveVaultDestinationWithConfidence(actionData.destination_path, 6);
          let resolvedDestinationPath = destinationResolution.resolvedPath || vaultActionRoot;
          const destinationWasExplicitlyProvided = Boolean(actionData.destination_path?.trim());
          const usesDefaultDestination = effectiveVaultAction === 'create_note' || effectiveVaultAction === 'create_folder';

          if (actionData.action === 'open_note' && isBulkVaultOpenIntent(userMessage)) {
            const preferredDirectory =
              (resolvedDestinationPath && resolveVaultDestinationDirectory(resolvedDestinationPath))
              || selectedDirectoryPath
              || (selectedFile ? getDirectoryForNodePath(selectedFile, fileTree, vaultPath) : null)
              || vaultActionRoot;

            const files = preferredDirectory ? collectMarkdownFilesForDirectory(preferredDirectory, 120) : [];
            if (files.length) {
              const previewLimit = 12;
              const previewLines = files
                .slice(0, previewLimit)
                .map((path: string, index: number) => `${index + 1}. ${toVaultRelativePath(path)}`)
                .join('\n');
              const moreCount = files.length - previewLimit;
              setLastAiActionMessage(
                `I can't open every file at once in Note mode. Choose exactly which file you want from ${toVaultRelativePath(preferredDirectory)}.\n\n${previewLines}${moreCount > 0 ? `\n...and ${moreCount} more.` : ''}`,
                buildVaultOpenOptions(files, 8)
              );
            } else {
              pushClarificationQuestionOnLastMessage(
                'I can open one note at a time. Which file do you want me to open?',
                buildVaultAnswerOptionsFromPaths(collectMarkdownPaths(fileTree, 6), 'Use target_path', 6),
                'Type the exact note path to open'
              );
            }
            setProposedAction(null);
            return;
          }

          const shouldClarifyDestination = destinationWasExplicitlyProvided
            && (
              !destinationResolution.resolvedPath
              || (
                !usesDefaultDestination
                && destinationResolution.confidence !== 'high'
                && destinationResolution.candidates.length > 1
              )
            );
          if (shouldClarifyDestination) {
            const destinationOptions = buildVaultAnswerOptionsFromPaths(
              destinationResolution.candidates.length
                ? destinationResolution.candidates
                : getVaultDirectoryCandidates(8),
              'Use destination_path',
              6,
            );
            pushClarificationQuestionOnLastMessage(
              destinationResolution.candidates.length
                ? `I found multiple destination folders for "${actionData.destination_path}". Which folder should I use?`
                : `I could not match "${actionData.destination_path}" to a vault folder. Which folder should I use instead?`,
              destinationOptions,
              'Type the exact destination folder path'
            );
            setProposedAction(null);
            return;
          }

          if (actionData.action === 'move_note') {
            if (!resolvedSourcePath) {
              pushClarificationQuestionOnLastMessage(
                'Which note should I move?',
                buildVaultAnswerOptionsFromPaths(collectMarkdownPaths(fileTree, 6), 'Use source_path', 6),
                'Type the source note path to move'
              );
              setProposedAction(null);
              return;
            }

            const sourceResolution = await resolveVaultFilePathWithConfidence(resolvedSourcePath, actionData.destination_path, 6);
            const shouldClarifySource = !sourceResolution.resolvedPath
              || (sourceResolution.confidence !== 'high' && sourceResolution.candidates.length > 1);
            if (shouldClarifySource) {
              const sourceOptions = buildVaultAnswerOptionsFromPaths(
                sourceResolution.candidates.length
                  ? sourceResolution.candidates
                  : collectMarkdownPaths(fileTree, 8),
                'Use source_path',
                6,
              );
              pushClarificationQuestionOnLastMessage(
                `I found multiple source notes for "${sourceResolution.requestedPath}". Which note should I move?`,
                sourceOptions,
                'Type the exact source note path to move'
              );
              setProposedAction(null);
              return;
            }

            resolvedSourcePath = sourceResolution.resolvedPath || resolvedSourcePath;
            resolvedDestinationPath = destinationResolution.resolvedPath || resolvedDestinationPath;
          }

          if ((actionData.action === 'open_note' || actionData.action === 'edit_note') && resolvedTargetPath) {
            const targetResolution = await resolveVaultFilePathWithConfidence(resolvedTargetPath, actionData.destination_path, 6);
            const shouldClarifyTarget = !targetResolution.resolvedPath
              || (targetResolution.confidence !== 'high' && targetResolution.candidates.length > 1);
            if (shouldClarifyTarget) {
              const targetOptions = buildVaultAnswerOptionsFromPaths(
                targetResolution.candidates.length
                  ? targetResolution.candidates
                  : collectMarkdownPaths(fileTree, 8),
                'Use target_path',
                6,
              );
              pushClarificationQuestionOnLastMessage(
                `I found multiple notes for "${targetResolution.requestedPath}". Which note should I ${actionData.action === 'open_note' ? 'open' : 'edit'}?`,
                targetOptions,
                'Type the exact note path to use'
              );
              setProposedAction(null);
              return;
            }

            resolvedTargetPath = targetResolution.resolvedPath || resolvedTargetPath;
          }

          if ((actionData.action === 'rename_note' || actionData.action === 'delete_item') && resolvedTargetPath) {
            const nodeResolution = resolveVaultNodePathWithConfidence(resolvedTargetPath, actionData.destination_path, 6);
            const shouldClarifyNode = !nodeResolution.resolvedPath
              || (nodeResolution.confidence !== 'high' && nodeResolution.candidates.length > 1);
            if (shouldClarifyNode) {
              const nodeOptions = buildVaultAnswerOptionsFromPaths(
                nodeResolution.candidates.length
                  ? nodeResolution.candidates
                  : [
                    ...collectMarkdownPaths(fileTree, 5),
                    ...getVaultDirectoryCandidates(5),
                  ],
                'Use target_path',
                6,
              );
              pushClarificationQuestionOnLastMessage(
                `I found multiple matches for "${nodeResolution.requestedPath}". Which file or folder should I ${actionData.action === 'rename_note' ? 'rename' : 'delete'}?`,
                nodeOptions,
                'Type the exact file or folder path to use'
              );
              setProposedAction(null);
              return;
            }

            resolvedTargetPath = nodeResolution.resolvedPath || resolvedTargetPath;
          }

          if ((actionData.action === 'open_note' || actionData.action === 'edit_note' || actionData.action === 'rename_note' || actionData.action === 'delete_item') && !resolvedTargetPath) {
            pushClarificationQuestionOnLastMessage(
              `I need the exact target path before I can ${actionData.action.replace('_', ' ')}. Which file or folder should I use?`,
              buildVaultAnswerOptionsFromPaths(
                [...collectMarkdownPaths(fileTree, 6), ...getVaultDirectoryCandidates(4)],
                'Use target_path',
                6,
              ),
              'Type the exact target path'
            );
            setProposedAction(null);
            return;
          }

          if ((effectiveVaultAction === 'create_note' || effectiveVaultAction === 'edit_note') && (!effectiveVaultContent || !effectiveVaultContent.trim())) {
            setCurrentMessages((prev: any[]) => [...prev, {
              sender: 'ai',
              text: 'Could not extract markdown content for this vault write action. Please retry with explicit content.'
            }]);
            return;
          }

          const previewActionData = promoteFolderCreateToNote
            ? {
              ...actionData,
              action: 'create_note' as const,
              title: effectiveVaultTitle,
              content: effectiveVaultContent,
              explanation: actionData.explanation || 'Ready to create the requested note and write its content.'
            }
            : actionData;
          setLastAiActionMessage(buildBrainActionPreview(previewActionData));

          setProposedAction({
            scope: 'vault',
            type: effectiveVaultAction === 'create_note'
              ? 'create'
              : effectiveVaultAction === 'edit_note'
                ? 'edit_note'
                : effectiveVaultAction === 'create_folder'
                  ? 'create_folder'
                  : effectiveVaultAction === 'move_note'
                    ? 'move_note'
                    : effectiveVaultAction === 'rename_note'
                      ? 'rename_note'
                      : effectiveVaultAction === 'delete_item'
                        ? 'delete_item'
                        : 'open_note',
            content: effectiveVaultContent,
            target_text: actionData.target_text,
            title: effectiveVaultTitle,
            message: promoteFolderCreateToNote
              ? (actionData.explanation || 'Detected create+write intent. Prepared note creation with content.')
              : (actionData.explanation || 'Confirm this vault action?'),
            sourceFile: selectedFile,
            sourcePath: resolvedSourcePath,
            destinationPath: resolvedDestinationPath,
            targetPath: effectiveVaultAction === 'create_note' ? undefined : (resolvedTargetPath || resolvedSourcePath),
          });
          return;
        }

        const sanitizedActionContent = sanitizeProposedMarkdown(actionData.content, { aggressive: actionData.action !== 'replace_all' });
        const resolvedContent = sanitizedActionContent || inferActionContentFromResponse(actionData.action, aiResponse);
        const contentRequiredActions = ['replace_all', 'replace_selection', 'find_and_replace', 'insert_content', 'insert_at_cursor'];

        if (contentRequiredActions.includes(actionData.action) && (!resolvedContent || !resolvedContent.trim())) {
          setCurrentMessages((prev: any[]) => [...prev, {
            sender: 'ai',
            text: 'Could not extract insertion content from the response. Retrying with strict JSON/tagged output should fix this.'
          }]);
          return;
        }

        setLastAiActionMessage(buildBrainActionPreview(actionData));

        const replaceAllTarget = (actionData.target_text || currentEditorContent || fileContent || editContent || '').toString();
        setProposedAction({
          scope: 'note',
          type: actionData.action === 'insert_content' ? 'insert' : (actionData.action === 'create_note' ? 'create' : actionData.action),
          content: resolvedContent,
          target_text: actionData.action === 'replace_all' ? replaceAllTarget : (actionData.target_text || usedContext),
          originalSelection: usedContext || undefined,
          title: actionData.title,
          message: actionData.explanation,
          sourceFile: selectedFile,
          range: (usedRange || usedTiptapRange) || undefined
        });
      }

      if (!actionData?.action && (brainScope === 'vault' || aiMode === 'edit') && isAmbiguousOperationRequest(userMessage)) {
        const questionId = `question_${Date.now()}`;
        const fallbackQuestion = looksLikeClarificationQuestion(visibleAiResponse)
          ? visibleAiResponse
          : (brainScope === 'vault'
            ? 'I need one clarification before changing notes. What exactly should I do?'
            : 'I need one clarification before editing this note. What exactly should I do?');

        const fallbackOptions = brainScope === 'vault'
          ? [
            {
              id: `${questionId}:option:0`,
              action: 'answer_question',
              label: selectedFile ? `Edit current note (${selectedFile.split(/[/\\]/).pop() || 'current'})` : 'Edit an existing note',
              value: selectedFile ? 'edit_current_note' : 'edit_existing_note',
              questionId,
            },
            {
              id: `${questionId}:option:1`,
              action: 'answer_question',
              label: 'Add a new section',
              value: 'add_new_section',
              questionId,
            },
            {
              id: `${questionId}:option:2`,
              action: 'answer_question',
              label: 'Create a new note',
              value: 'create_new_note',
              questionId,
            },
            {
              id: `${questionId}:option:3`,
              action: 'answer_question',
              label: 'Move / Rename / Delete a note',
              value: 'organize_notes',
              questionId,
            },
          ]
          : [
            {
              id: `${questionId}:option:0`,
              action: 'answer_question',
              label: 'Edit selected section only',
              value: 'edit_selected_section',
              questionId,
            },
            {
              id: `${questionId}:option:1`,
              action: 'answer_question',
              label: 'Add a new section',
              value: 'add_new_section',
              questionId,
            },
            {
              id: `${questionId}:option:2`,
              action: 'answer_question',
              label: 'Rewrite the whole note',
              value: 'rewrite_whole_note',
              questionId,
            },
            {
              id: `${questionId}:option:3`,
              action: 'answer_question',
              label: 'Create a new note instead',
              value: 'create_new_note',
              questionId,
            },
          ];

        setCurrentMessages((prev: any[]) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.sender === 'ai') {
            last.isAction = false;
            last.text = fallbackQuestion;
            last.options = fallbackOptions;
            last.questionPrompt = fallbackQuestion;
            last.questionId = questionId;
            last.allowFreeTextReply = true;
            last.freeTextReplyPlaceholder = 'Tell me exactly what to edit, which file, and what to add/change';
          }
          return next;
        });

        setProposedAction(null);
        return;
      }

    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      console.error('AI API error:', error);
      if (brainScope === 'vault') {
        setVaultStatusMessage(`Vault search/chat failed. ${getErrorMessage(error)}`);
      }
      setCurrentMessages((prev: any[]) => [...prev, {
        sender: 'ai',
        text: `AI request failed. ${getErrorMessage(error)}`
      }]);
    } finally {
      if (brainScope === 'vault') {
        setIsVaultSearchLoading(false);
      }
      setIsAiLoading(false);
    }
  };

export const createHandleApplyAction =
  (deps: HandlerDeps) =>
  async () => {
    const {
      proposedAction,
      normalizeMarkdownFileName,
      resolveVaultDestinationDirectory,
      setVaultMessages,
      toVaultRelativePath,
      invalidateFileTreeCache,
      vaultPath,
      syncVaultSubtreeInBackground,
      loadFileTree,
      setBrainScope,
      openFile,
      resolveVaultTargetPath,
      resolveVaultOpenChoicePaths,
      pushVaultOpenChoiceMessage,
      suggestVaultNotePaths,
      sanitizeProposedMarkdown,
      escapeRegExp,
      pushVaultClarificationQuestion,
      extractMarkdownHeadingTitles,
      cacheFileContent,
      selectedFile,
      areEquivalentPaths,
      setFileContent,
      setEditContent,
      joinFileSystemPath,
      handleFileDrop,
      vaultActionRoot,
      resolveVaultExistingNodePath,
      suggestVaultDirectoryPaths,
      getParentDirectory,
      pathIsWithin,
      setSelectedFile,
      setSelectedTreePath,
      setCreateTargetPath,
      setIsEditing,
      selectedDirectoryPath,
      setAiMessages,
      isEditing,
      editContent,
      fileContent,
      editorRef,
      isUiTranscriptNoise,
      setPreviousContent,
      stripWindowsExtendedPathPrefix,
      setProposedAction,
      getErrorMessage,
    } = deps;

    if (!proposedAction || !window.atheletiaAPI?.notes) return;
    if (proposedAction.scope === 'vault') {
      const pathInsideVault = (candidatePath?: string | null) => {
        if (!candidatePath || !vaultActionRoot) return false;
        return areEquivalentPaths(candidatePath, vaultActionRoot) || pathIsWithin(candidatePath, vaultActionRoot);
      };
      const rejectOutsideVault = (candidatePath?: string | null, action = 'action') => {
        if (pathInsideVault(candidatePath)) return false;
        setVaultMessages((prev: any[]) => [...prev, {
          sender: 'ai',
          text: `Blocked ${action}: the resolved path is outside the selected vault root.`
        }]);
        return true;
      };

      try {
        if (proposedAction.type === 'create') {
          const title = normalizeMarkdownFileName(proposedAction.title || 'Untitled note.md');
          const destination = resolveVaultDestinationDirectory(proposedAction.destinationPath);
          if (rejectOutsideVault(destination, 'create note')) return;
          const ensureDestination = await window.atheletiaAPI.notes.ensureDir(destination);
          if (!ensureDestination.success) {
            setVaultMessages((prev: any[]) => [...prev, {
              sender: 'ai',
              text: `Could not access destination folder ${destination}: ${ensureDestination.error || 'unknown error'}`
            }]);
            return;
          }

          const result = await window.atheletiaAPI.notes.createFile(destination, title);
          if (!result.success || !result.path) {
            setVaultMessages((prev: any[]) => [...prev, {
              sender: 'ai',
              text: `Create note failed: ${result.error || 'unknown error'}`
            }]);
            return;
          }
          const createdPath = result.path;

          const wrote = await window.atheletiaAPI.notes.writeFile(createdPath, proposedAction.content || '');
          if (!wrote) {
            setVaultMessages((prev: any[]) => [...prev, {
              sender: 'ai',
              text: `Created ${title}, but writing markdown content failed for ${toVaultRelativePath(createdPath)}.`
            }]);
            return;
          }

          invalidateFileTreeCache(vaultPath);
          syncVaultSubtreeInBackground(createdPath);
          void loadFileTree(true);
          setBrainScope('note');
          await openFile(createdPath, true);
          setVaultMessages((prev: any[]) => [...prev, {
            sender: 'ai',
            text: `Created ${toVaultRelativePath(createdPath)}.`
          }]);
        } else if (proposedAction.type === 'edit_note') {
          if (!proposedAction.targetPath) {
            setVaultMessages((prev: any[]) => [...prev, { sender: 'ai', text: 'Missing target_path for edit action.' }]);
            return;
          }

          const resolvedTargetPath = await resolveVaultTargetPath(proposedAction.targetPath, proposedAction.destinationPath);
          if (resolvedTargetPath && rejectOutsideVault(resolvedTargetPath, 'edit note')) return;
          if (!resolvedTargetPath) {
            const openChoices = resolveVaultOpenChoicePaths(proposedAction.targetPath, proposedAction.destinationPath, 24);
            if (openChoices.length) {
              pushVaultOpenChoiceMessage(
                openChoices,
                `Could not locate an exact match for "${proposedAction.targetPath}". Here are likely files:`
              );
            } else {
              const suggestions = suggestVaultNotePaths(proposedAction.targetPath, 4);
              const suggestionText = suggestions.length ? ` Try one of: ${suggestions.join(', ')}` : '';
              setVaultMessages((prev: any[]) => [...prev, {
                sender: 'ai',
                text: `Could not locate ${proposedAction.targetPath} inside the current vault root.${suggestionText}`
              }]);
            }
            return;
          }

          const existingContent = await window.atheletiaAPI.notes.readFile(resolvedTargetPath);
          if (existingContent === null) {
            setVaultMessages((prev: any[]) => [...prev, {
              sender: 'ai',
              text: `Found ${toVaultRelativePath(resolvedTargetPath)} but failed to read it.`
            }]);
            return;
          }

          const replacement = sanitizeProposedMarkdown(proposedAction.content, { aggressive: false }) || proposedAction.content || '';
          if (!replacement.trim()) {
            setVaultMessages((prev: any[]) => [...prev, {
              sender: 'ai',
              text: 'Edit action has no markdown content to write.'
            }]);
            return;
          }

          let updatedContent = existingContent;
          let editOutcome = 'Updated note.';

          if (proposedAction.target_text?.trim()) {
            const targetText = proposedAction.target_text;
            if (updatedContent.includes(targetText)) {
              updatedContent = updatedContent.replace(targetText, replacement);
              editOutcome = 'Replaced the requested section.';
            } else {
              const flexiblePattern = escapeRegExp(targetText.trim()).replace(/\s+/g, '\\s+');
              const flexibleRegex = new RegExp(flexiblePattern, 'm');
              if (flexibleRegex.test(updatedContent)) {
                updatedContent = updatedContent.replace(flexibleRegex, replacement);
                editOutcome = 'Replaced a whitespace-normalized section.';
              } else {
                pushVaultClarificationQuestion(
                  `I could not find the exact target text in ${toVaultRelativePath(resolvedTargetPath)}. How should I continue this edit?`,
                  [
                    { id: 'clarify:append_end', action: 'answer_question', label: 'Append at end', value: 'append_at_end' },
                    { id: 'clarify:pick_section', action: 'answer_question', label: 'Pick target section first', value: 'pick_target_section' },
                    { id: 'clarify:rewrite', action: 'answer_question', label: 'Rewrite whole note', value: 'rewrite_whole_note' },
                  ],
                  'Provide the exact heading or text snippet to replace'
                );
                return;
              }
            }
          } else {
            const trimmedReplacement = replacement.trim();
            const existingHeadings = extractMarkdownHeadingTitles(updatedContent);
            const replacementHeadings = extractMarkdownHeadingTitles(trimmedReplacement);
            const duplicateHeadings = replacementHeadings.filter((heading: string) => existingHeadings.includes(heading));

            if (duplicateHeadings.length) {
              pushVaultClarificationQuestion(
                `This edit may duplicate existing section headings (${duplicateHeadings.slice(0, 3).join(', ')}). Where should I apply it?`,
                [
                  { id: 'clarify:edit_existing_section', action: 'answer_question', label: 'Edit existing section', value: 'edit_existing_section' },
                  { id: 'clarify:append_anyway', action: 'answer_question', label: 'Append anyway', value: 'append_anyway' },
                  { id: 'clarify:rewrite_after_review', action: 'answer_question', label: 'Rewrite whole note', value: 'rewrite_whole_note' },
                ],
                'Tell me which heading to target to avoid duplicates'
              );
              return;
            }

            if (trimmedReplacement && !updatedContent.includes(trimmedReplacement)) {
              updatedContent = `${updatedContent.replace(/\s*$/, '')}\n\n${trimmedReplacement}\n`;
              editOutcome = 'No target_text provided, so content was appended at the end.';
            } else {
              editOutcome = 'No changes applied because the proposed content already exists in the note.';
            }
          }

          if (updatedContent === existingContent) {
            setVaultMessages((prev: any[]) => [...prev, {
              sender: 'ai',
              text: `No file changes were needed for ${toVaultRelativePath(resolvedTargetPath)}. ${editOutcome}`
            }]);
            return;
          }

          const wrote = await window.atheletiaAPI.notes.writeFile(resolvedTargetPath, updatedContent);
          if (!wrote) {
            setVaultMessages((prev: any[]) => [...prev, {
              sender: 'ai',
              text: `Failed to write updates to ${toVaultRelativePath(resolvedTargetPath)}.`
            }]);
            return;
          }

          cacheFileContent(resolvedTargetPath, updatedContent);
          if (selectedFile && areEquivalentPaths(selectedFile, resolvedTargetPath)) {
            setFileContent(updatedContent);
            setEditContent(updatedContent);
          }

          syncVaultSubtreeInBackground(resolvedTargetPath);
          setVaultMessages((prev: any[]) => [...prev, {
            sender: 'ai',
            text: `${editOutcome} Saved to ${toVaultRelativePath(resolvedTargetPath)}.`
          }]);
        } else if (proposedAction.type === 'create_folder') {
          const destination = resolveVaultDestinationDirectory(proposedAction.destinationPath);
          if (rejectOutsideVault(destination, 'create folder')) return;
          const folderName = (proposedAction.title || '').trim();
          if (!folderName) {
            setVaultMessages((prev: any[]) => [...prev, { sender: 'ai', text: 'Missing folder name. No changes were applied.' }]);
          } else {
            const ensureDestination = await window.atheletiaAPI.notes.ensureDir(destination);
            if (!ensureDestination.success) {
              setVaultMessages((prev: any[]) => [...prev, {
                sender: 'ai',
                text: `Could not access parent folder ${destination}: ${ensureDestination.error || 'unknown error'}`
              }]);
              return;
            }
            const result = await window.atheletiaAPI.notes.createFolder(destination, folderName);
            if (result.success) {
              const createdFolderPath = result.path || joinFileSystemPath(destination, folderName);
              invalidateFileTreeCache(vaultPath);
              void loadFileTree(true);
              syncVaultSubtreeInBackground(createdFolderPath);
              setVaultMessages((prev: any[]) => [...prev, { sender: 'ai', text: `Created folder ${folderName} in ${toVaultRelativePath(destination)}.` }]);
            } else {
              setVaultMessages((prev: any[]) => [...prev, { sender: 'ai', text: `Create folder failed: ${result.error || 'unknown error'}` }]);
            }
          }
        } else if (proposedAction.type === 'move_note') {
          if (!proposedAction.sourcePath) {
            setVaultMessages((prev: any[]) => [...prev, { sender: 'ai', text: 'Missing source_path for move action.' }]);
          } else {
            const destination = proposedAction.destinationPath || vaultActionRoot;
            const resolvedDestination = resolveVaultDestinationDirectory(destination);
            if (rejectOutsideVault(resolvedDestination, 'move note')) return;
            const moveResult = await handleFileDrop(proposedAction.sourcePath, destination);
            if (!moveResult.success) {
              const suggestions = suggestVaultNotePaths(proposedAction.sourcePath, 4);
              const suggestionText = suggestions.length ? ` Closest notes: ${suggestions.join(', ')}` : '';
              setVaultMessages((prev: any[]) => [...prev, {
                sender: 'ai',
                text: `Move failed: ${moveResult.error || 'unknown error'}.${suggestionText}`
              }]);
              return;
            }

            const movedPath = moveResult.newPath ? toVaultRelativePath(moveResult.newPath) : null;
            setVaultMessages((prev: any[]) => [...prev, {
              sender: 'ai',
              text: movedPath
                ? `Moved note to ${movedPath}.`
                : `Moved note into ${toVaultRelativePath(resolveVaultDestinationDirectory(destination))}.`
            }]);
          }
        } else if (proposedAction.type === 'rename_note') {
          if (!proposedAction.targetPath) {
            setVaultMessages((prev: any[]) => [...prev, { sender: 'ai', text: 'Missing target_path for rename action.' }]);
          } else {
            const resolvedTargetPath = resolveVaultExistingNodePath(proposedAction.targetPath, proposedAction.destinationPath);
            if (resolvedTargetPath && rejectOutsideVault(resolvedTargetPath, 'rename item')) return;
            if (!resolvedTargetPath) {
              const noteSuggestions = suggestVaultNotePaths(proposedAction.targetPath, 4);
              const dirSuggestions = suggestVaultDirectoryPaths(proposedAction.targetPath, 4)
                .map((path: string) => toVaultRelativePath(path));
              const combinedSuggestions = [...noteSuggestions, ...dirSuggestions].slice(0, 5);
              const suggestionText = combinedSuggestions.length ? ` Try one of: ${combinedSuggestions.join(', ')}` : '';
              setVaultMessages((prev: any[]) => [...prev, {
                sender: 'ai',
                text: `Could not locate ${proposedAction.targetPath} for rename.${suggestionText}`
              }]);
              return;
            }

            const nextNameRaw = (proposedAction.title || '').trim();
            if (!nextNameRaw) {
              setVaultMessages((prev: any[]) => [...prev, { sender: 'ai', text: 'Missing new_name/title for rename action.' }]);
              return;
            }

            const safeName = resolvedTargetPath.toLowerCase().endsWith('.md')
              ? normalizeMarkdownFileName(nextNameRaw)
              : nextNameRaw;

            const renameResult = await window.atheletiaAPI.notes.rename(resolvedTargetPath, safeName);
            if (!renameResult.success) {
              setVaultMessages((prev: any[]) => [...prev, {
                sender: 'ai',
                text: `Rename failed: ${renameResult.error || 'unknown error'}`
              }]);
              return;
            }

            const oldParent = getParentDirectory(resolvedTargetPath) || vaultPath;
            const newPath = renameResult.newPath || resolvedTargetPath;
            invalidateFileTreeCache(vaultPath);
            void loadFileTree(true);
            syncVaultSubtreeInBackground(oldParent);
            syncVaultSubtreeInBackground(getParentDirectory(newPath) || newPath);

            if (selectedFile && areEquivalentPaths(selectedFile, resolvedTargetPath) && renameResult.newPath) {
              await openFile(renameResult.newPath, true);
            } else if (selectedFile && renameResult.newPath && pathIsWithin(selectedFile, resolvedTargetPath)) {
              const oldPrefix = stripWindowsExtendedPathPrefix(resolvedTargetPath).replace(/[\\/]+$/, '');
              const newPrefix = stripWindowsExtendedPathPrefix(renameResult.newPath).replace(/[\\/]+$/, '');
              const normalizedSelected = stripWindowsExtendedPathPrefix(selectedFile);
              const suffix = normalizedSelected.slice(oldPrefix.length);
              const remappedSelected = `${newPrefix}${suffix}`;
              void openFile(remappedSelected, true);
            }

            setVaultMessages((prev: any[]) => [...prev, {
              sender: 'ai',
              text: `Renamed ${toVaultRelativePath(resolvedTargetPath)} to ${toVaultRelativePath(newPath)}.`
            }]);
          }
        } else if (proposedAction.type === 'delete_item') {
          if (!proposedAction.targetPath) {
            setVaultMessages((prev: any[]) => [...prev, { sender: 'ai', text: 'Missing target_path for delete action.' }]);
          } else {
            const resolvedTargetPath = resolveVaultExistingNodePath(proposedAction.targetPath, proposedAction.destinationPath);
            if (resolvedTargetPath && rejectOutsideVault(resolvedTargetPath, 'delete item')) return;
            if (!resolvedTargetPath) {
              const noteSuggestions = suggestVaultNotePaths(proposedAction.targetPath, 4);
              const dirSuggestions = suggestVaultDirectoryPaths(proposedAction.targetPath, 4)
                .map((path: string) => toVaultRelativePath(path));
              const combinedSuggestions = [...noteSuggestions, ...dirSuggestions].slice(0, 5);
              const suggestionText = combinedSuggestions.length ? ` Try one of: ${combinedSuggestions.join(', ')}` : '';
              setVaultMessages((prev: any[]) => [...prev, {
                sender: 'ai',
                text: `Could not locate ${proposedAction.targetPath} for delete.${suggestionText}`
              }]);
              return;
            }

            const deleteResult = await window.atheletiaAPI.notes.delete(resolvedTargetPath);
            if (!deleteResult.success) {
              setVaultMessages((prev: any[]) => [...prev, {
                sender: 'ai',
                text: `Delete failed: ${deleteResult.error || 'unknown error'}`
              }]);
              return;
            }

            const parentPath = getParentDirectory(resolvedTargetPath) || vaultPath;
            invalidateFileTreeCache(vaultPath);
            void loadFileTree(true);
            syncVaultSubtreeInBackground(parentPath);

            if (selectedFile && pathIsWithin(selectedFile, resolvedTargetPath)) {
              setSelectedFile(null);
              setSelectedTreePath(parentPath);
              setCreateTargetPath(parentPath);
              setFileContent('');
              setEditContent('');
              setIsEditing(false);
              localStorage.removeItem('brain_selectedFile');
            }

            setVaultMessages((prev: any[]) => [...prev, {
              sender: 'ai',
              text: `Deleted ${toVaultRelativePath(resolvedTargetPath)}.`
            }]);
          }
        } else if (proposedAction.type === 'open_note') {
          if (!proposedAction.targetPath) {
            setVaultMessages((prev: any[]) => [...prev, { sender: 'ai', text: 'Missing target path for open action.' }]);
          } else {
            const resolvedTargetPath = await resolveVaultTargetPath(proposedAction.targetPath, proposedAction.destinationPath);
            if (resolvedTargetPath && rejectOutsideVault(resolvedTargetPath, 'open note')) return;
            if (!resolvedTargetPath) {
              const openChoices = resolveVaultOpenChoicePaths(proposedAction.targetPath, proposedAction.destinationPath, 24);
              if (openChoices.length) {
                pushVaultOpenChoiceMessage(
                  openChoices,
                  `Could not locate an exact file for "${proposedAction.targetPath}". Pick one below:`
                );
              } else {
                const suggestions = suggestVaultNotePaths(proposedAction.targetPath, 4);
                const suggestionText = suggestions.length ? ` Try one of: ${suggestions.join(', ')}` : '';
                setVaultMessages((prev: any[]) => [...prev, {
                  sender: 'ai',
                  text: `Could not locate ${proposedAction.targetPath} inside the current vault root.${suggestionText}`
                }]);
              }
            } else {
              setBrainScope('note');
              const opened = await openFile(resolvedTargetPath, true);
              if (opened) {
                setVaultMessages((prev: any[]) => [...prev, {
                  sender: 'ai',
                  text: `Opened ${toVaultRelativePath(resolvedTargetPath)} in Note mode.`
                }]);
              } else {
                setVaultMessages((prev: any[]) => [...prev, {
                  sender: 'ai',
                  text: `Found ${toVaultRelativePath(resolvedTargetPath)} but failed to open it.`
                }]);
              }
            }
          }
        } else {
          setVaultMessages((prev: any[]) => [...prev, { sender: 'ai', text: `Unsupported vault action: ${proposedAction.type}` }]);
        }
      } catch (err) {
        console.error('Error applying vault AI action:', err);
        setVaultMessages((prev: any[]) => [...prev, {
          sender: 'ai',
          text: `Vault action failed: ${getErrorMessage(err)}`
        }]);
      } finally {
        setProposedAction(null);
      }
      return;
    }
    if (proposedAction.sourceFile && selectedFile !== proposedAction.sourceFile) {
      setAiMessages((prev: any[]) => [...prev, {
        sender: 'ai',
        text: 'Warning: This proposal was created for a different note and was not applied.'
      }]);
      setProposedAction(null);
      return;
    }

    try {
      if (proposedAction.type === 'create') {
        if (proposedAction.title) {
          const result = await window.atheletiaAPI.notes.createFile(selectedDirectoryPath, normalizeMarkdownFileName(proposedAction.title));
          if (result.success && result.path) {
            await window.atheletiaAPI.notes.writeFile(result.path, proposedAction.content || '');
            invalidateFileTreeCache(vaultPath);
            syncVaultSubtreeInBackground(result.path);
            void loadFileTree(true);
            void openFile(result.path, true);
            setAiMessages((prev: any[]) => [...prev, { sender: 'ai', text: `Created new note: ${proposedAction.title}` }]);
          }
        }
      } else {
        let newContent = isEditing ? editContent : fileContent;
        const originalContent = newContent;

        let successMessage = 'Action applied.';


        if (proposedAction.type === 'replace_all') {
          const candidate = sanitizeProposedMarkdown(proposedAction.content || '', { aggressive: false }) || '';
          if (isUiTranscriptNoise(candidate)) {
            newContent = originalContent;
            successMessage = 'Blocked full rewrite: detected UI/chat transcript noise in proposed content.';
          } else {
            newContent = candidate;
            if (isEditing && editorRef.current) {
              (editorRef.current.commands as any).setContent(newContent, true);
            }
            successMessage = 'Entire note reformatted.';
          }
        }
        else if (proposedAction.type === 'replace_selection' && isEditing && editorRef.current && proposedAction.range && 'from' in proposedAction.range) {
          const range = proposedAction.range as { from: number, to: number };
          editorRef.current.commands.insertContentAt({ from: range.from, to: range.to }, proposedAction.content || '');
          newContent = editorRef.current.storage.markdown.getMarkdown();
          successMessage = 'Selection successfully replaced.';
        }
        else if (proposedAction.type === 'insert_at_cursor' && isEditing && editorRef.current && proposedAction.range && 'from' in proposedAction.range) {
          const range = proposedAction.range as { from: number, to: number };
          editorRef.current.commands.insertContentAt({ from: range.to, to: range.to }, proposedAction.content || '');
          newContent = editorRef.current.storage.markdown.getMarkdown();
          successMessage = 'Content inserted at cursor.';
        }
        else if ((proposedAction.type === 'replace_selection' || proposedAction.type === 'find_and_replace') && proposedAction.target_text) {
          let targetFound = false;

          const normalize = (str: string) => str.replace(/\s+/g, ' ').trim();
          const targetNorm = normalize(proposedAction.target_text);

          if (newContent.includes(proposedAction.target_text)) {
            newContent = newContent.replace(proposedAction.target_text, proposedAction.content || '');
            targetFound = true;
          }
          else {
            const contentNorm = normalize(newContent);
            if (contentNorm.includes(targetNorm)) {
              const regexStr = proposedAction.target_text
                .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                .replace(/\s+/g, '\\s+');

              const fuzzyRegex = new RegExp(regexStr);
              if (fuzzyRegex.test(newContent)) {
                newContent = newContent.replace(fuzzyRegex, proposedAction.content || '');
                targetFound = true;
              }
            }
          }

          const origSel = proposedAction.originalSelection;
          if (!targetFound && origSel && origSel !== proposedAction.target_text) {
            const fallbackRegexStr = origSel
              .split(/\s+/)
              .filter(Boolean)
              .map((word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
              .join('[\\s\\S]*?');

            const desperateRegex = new RegExp(fallbackRegexStr);
            if (desperateRegex.test(newContent)) {
              newContent = newContent.replace(desperateRegex, proposedAction.content || '');
              targetFound = true;
            }
          }

          if (targetFound) {
            successMessage = 'Text updated successfully.';
          } else {
            const targetLen = (proposedAction.target_text || '').trim().length;
            const contentLen = newContent.trim().length;
            const looksLikeLargeBlockReplace = contentLen > 0 && targetLen / contentLen >= 0.5;

            if (looksLikeLargeBlockReplace && proposedAction.content) {
              const fallbackCandidate = sanitizeProposedMarkdown(proposedAction.content, { aggressive: false }) || '';
              if (isUiTranscriptNoise(fallbackCandidate)) {
                newContent = originalContent;
                successMessage = 'Blocked fallback rewrite: detected UI/chat transcript noise in proposed content.';
              } else {
                newContent = fallbackCandidate;
                successMessage = 'Entire note reformatted (fallback due to massive selection).';
              }
            } else {
              successMessage = 'Warning: Could not find target text to replace. No changes were applied.';
            }
          }

          if (isEditing && editorRef.current) {
            (editorRef.current.commands as any).setContent(newContent, true);
          }
        }
        else if (proposedAction.type === 'insert_at_cursor') {
          if (isEditing && editorRef.current) {
            editorRef.current.commands.insertContent(proposedAction.content);
            newContent = editorRef.current.storage.markdown.getMarkdown();
          } else {
            newContent = newContent.trim() + '\n\n' + (proposedAction.content || '').trim();
          }
          successMessage = 'Content inserted.';
        }
        else if (proposedAction.type === 'insert') {
          newContent = newContent.trim() + '\n\n' + (proposedAction.content || '').trim();
          if (isEditing && editorRef.current) {
            (editorRef.current.commands as any).setContent(newContent, true);
          }
          successMessage = 'Content appended.';
        }
        else if ((proposedAction.type === 'find_and_replace' || proposedAction.type === 'replace_selection') && proposedAction.content && !proposedAction.target_text) {
          successMessage = 'Warning: Missing target text for replacement. No changes were applied.';
        }
        else {
          successMessage = 'Warning: Could not apply action - missing information.';
        }

        if (selectedFile) {
          const success = await window.atheletiaAPI.notes.writeFile(selectedFile, newContent);

          if (success) {
            syncVaultSubtreeInBackground(selectedFile);
            setFileContent(newContent);
            setEditContent(newContent);
            setPreviousContent(newContent !== originalContent ? originalContent : null);
            setAiMessages((prev: any[]) => [...prev, { sender: 'ai', text: successMessage }]);
          } else {
            setAiMessages((prev: any[]) => [...prev, { sender: 'ai', text: 'Failed to save changes to file.' }]);
          }
        } else {
          console.error('[Atheletia Brain] No selectedFile while applying action.');
        }
      }
    } catch (err) {
      console.error('Error applying AI action:', err);
    } finally {
      setProposedAction(null);
    }
  };

export const createResolveVaultFilePathWithConfidence =
  (deps: HandlerDeps) =>
  async (
    rawTargetPath: string,
    destinationPath?: string | null,
    maxCandidates = 6,
  ) => {
    const {
      stripWindowsExtendedPathPrefix,
      resolveVaultTargetPath,
      resolveVaultOpenChoicePaths,
      suggestVaultNotePaths,
      isAbsoluteFilePath,
      joinFileSystemPath,
      vaultActionRoot,
      dedupeEquivalentPaths,
      toVaultRelativePath,
      areEquivalentPaths,
    } = deps;

    const requestedPath = stripWindowsExtendedPathPrefix(rawTargetPath || '').trim();
    if (!requestedPath) {
      return {
        requestedPath,
        resolvedPath: null,
        candidates: [],
        confidence: 'low',
        reason: 'Missing target path.',
      };
    }

    const primary = await resolveVaultTargetPath(requestedPath, destinationPath);
    const choiceCandidates = resolveVaultOpenChoicePaths(requestedPath, destinationPath, Math.max(maxCandidates, 12));
    const fallbackCandidates = suggestVaultNotePaths(requestedPath, maxCandidates)
      .map((path: string) => (isAbsoluteFilePath(path) ? path : joinFileSystemPath(vaultActionRoot, path)));

    const candidates = dedupeEquivalentPaths([
      ...(primary ? [primary] : []),
      ...choiceCandidates,
      ...fallbackCandidates,
    ]).slice(0, maxCandidates);

    if (!candidates.length) {
      return {
        requestedPath,
        resolvedPath: null,
        candidates: [],
        confidence: 'low',
        reason: 'No matching note candidates were found.',
      };
    }

    const requestedNormalized = requestedPath
      .replace(/^[.][\\/]+/, '')
      .replace(/[\\/]+/g, '/')
      .replace(/\.md$/i, '')
      .toLowerCase();
    const topRelative = toVaultRelativePath(candidates[0])
      .replace(/[\\/]+/g, '/')
      .replace(/\.md$/i, '')
      .toLowerCase();
    const hasPrimary = !!primary && candidates.some((path: string) => areEquivalentPaths(path, primary));

    let confidence = 'low';
    if (candidates.length === 1 && hasPrimary) {
      confidence = 'high';
    } else if (candidates.length === 1) {
      confidence = topRelative === requestedNormalized ? 'high' : 'medium';
    } else if (hasPrimary) {
      confidence = 'medium';
    }

    return {
      requestedPath,
      resolvedPath: confidence === 'low' ? null : (primary || candidates[0]),
      candidates,
      confidence,
      reason: confidence === 'high'
        ? 'Resolved to a single high-confidence note path.'
        : confidence === 'medium'
          ? 'Resolved, but multiple note candidates are possible.'
          : 'Multiple note candidates are ambiguous.',
    };
  };

export const createResolveVaultNodePathWithConfidence =
  (deps: HandlerDeps) =>
  (
    rawTargetPath: string,
    destinationPath?: string | null,
    maxCandidates = 6,
  ) => {
    const {
      stripWindowsExtendedPathPrefix,
      resolveVaultExistingNodePath,
      suggestVaultNotePaths,
      isAbsoluteFilePath,
      joinFileSystemPath,
      vaultActionRoot,
      suggestVaultDirectoryPaths,
      dedupeEquivalentPaths,
      areEquivalentPaths,
    } = deps;

    const requestedPath = stripWindowsExtendedPathPrefix(rawTargetPath || '').trim();
    if (!requestedPath) {
      return {
        requestedPath,
        resolvedPath: null,
        candidates: [],
        confidence: 'low',
        reason: 'Missing target path.',
      };
    }

    const primary = resolveVaultExistingNodePath(requestedPath, destinationPath);
    const noteCandidates = suggestVaultNotePaths(requestedPath, maxCandidates)
      .map((path: string) => (isAbsoluteFilePath(path) ? path : joinFileSystemPath(vaultActionRoot, path)));
    const directoryCandidates = suggestVaultDirectoryPaths(requestedPath, maxCandidates);

    const candidates = dedupeEquivalentPaths([
      ...(primary ? [primary] : []),
      ...noteCandidates,
      ...directoryCandidates,
    ]).slice(0, maxCandidates);

    if (!candidates.length) {
      return {
        requestedPath,
        resolvedPath: null,
        candidates: [],
        confidence: 'low',
        reason: 'No matching file or folder candidates were found.',
      };
    }

    const hasPrimary = !!primary && candidates.some((path: string) => areEquivalentPaths(path, primary));
    let confidence = 'low';
    if (hasPrimary && candidates.length === 1) {
      confidence = 'high';
    } else if (hasPrimary || candidates.length === 1) {
      confidence = 'medium';
    }

    return {
      requestedPath,
      resolvedPath: confidence === 'low' ? null : (primary || candidates[0]),
      candidates,
      confidence,
      reason: confidence === 'high'
        ? 'Resolved to a single high-confidence file/folder path.'
        : confidence === 'medium'
          ? 'Resolved, but multiple file/folder candidates are possible.'
          : 'Multiple file/folder candidates are ambiguous.',
    };
  };

export const createResolveVaultDestinationWithConfidence =
  (deps: HandlerDeps) =>
  (
    rawDestinationPath?: string | null,
    maxCandidates = 6,
  ) => {
    const {
      stripWindowsExtendedPathPrefix,
      resolveVaultDestinationDirectory,
      findNodeByPath,
      fileTree,
      suggestVaultDirectoryPaths,
      dedupeEquivalentPaths,
    } = deps;

    const requestedPath = stripWindowsExtendedPathPrefix(rawDestinationPath || '').trim();
    const resolvedDestination = resolveVaultDestinationDirectory(rawDestinationPath);

    if (!requestedPath) {
      return {
        requestedPath,
        resolvedPath: resolvedDestination,
        candidates: [resolvedDestination],
        confidence: 'low',
        reason: 'No destination path provided; defaulting to the selected folder, current note folder, or vault root.',
      };
    }

    const directNode = findNodeByPath(fileTree, resolvedDestination);
    const directoryCandidates = suggestVaultDirectoryPaths(requestedPath, maxCandidates);
    const candidates = dedupeEquivalentPaths([
      ...(directNode?.isDirectory ? [resolvedDestination] : []),
      ...directoryCandidates,
    ]).slice(0, maxCandidates);

    if (!candidates.length) {
      return {
        requestedPath,
        resolvedPath: null,
        candidates: [],
        confidence: 'low',
        reason: 'No matching destination folders were found.',
      };
    }

    let confidence = 'low';
    if (directNode?.isDirectory && candidates.length === 1) {
      confidence = 'high';
    } else if (directNode?.isDirectory || candidates.length === 1) {
      confidence = 'medium';
    }

    return {
      requestedPath,
      resolvedPath: confidence === 'low' ? null : (directNode?.isDirectory ? resolvedDestination : candidates[0]),
      candidates,
      confidence,
      reason: confidence === 'high'
        ? 'Resolved to a single high-confidence destination folder.'
        : confidence === 'medium'
          ? 'Resolved destination, but alternative folders are possible.'
          : 'Destination folder candidates are ambiguous.',
    };
  };

export const createPushVaultClarificationQuestion =
  (deps: HandlerDeps) =>
  (
    questionPrompt: string,
    questionOptions: any[],
    placeholder = 'Type your answer',
  ) => {
    const { setVaultMessages } = deps;

    const questionId = `question_${Date.now()}`;
    const scopedOptions = questionOptions.slice(0, 8).map((option, index) => ({
      ...option,
      id: `${questionId}:option:${index}`,
      action: 'answer_question' as const,
      questionId,
    }));

    setVaultMessages((prev: any[]) => [...prev, {
      sender: 'ai',
      text: questionPrompt,
      options: scopedOptions.length ? scopedOptions : undefined,
      questionPrompt,
      questionId,
      allowFreeTextReply: true,
      freeTextReplyPlaceholder: placeholder,
    }]);
  };

export const createHandleVaultMessageOptionSelect =
  (deps: HandlerDeps) =>
  async (option: any, messageIndex: number) => {
    const {
      setVaultMessages,
      collectMarkdownFilesForDirectory,
      toVaultRelativePath,
      pushVaultOpenChoiceMessage,
      resolveVaultTargetPath,
      setBrainScope,
      openFile,
    } = deps;

    setVaultMessages((prev: any[]) => prev.map((message, index) => (
      index === messageIndex ? { ...message, options: undefined } : message
    )));

    if (option.action === 'list_folder') {
      const files = collectMarkdownFilesForDirectory(option.value, 120);
      if (!files.length) {
        setVaultMessages((prev: any[]) => [...prev, {
          sender: 'ai',
          text: `No markdown files found under ${toVaultRelativePath(option.value)}.`
        }]);
        return;
      }

      pushVaultOpenChoiceMessage(
        files,
        `I found ${files.length} markdown ${files.length === 1 ? 'file' : 'files'} under ${toVaultRelativePath(option.value)}.`
      );
      return;
    }

    if (option.action === 'open_note') {
      const resolvedTargetPath = await resolveVaultTargetPath(option.value);
      if (!resolvedTargetPath) {
        setVaultMessages((prev: any[]) => [...prev, {
          sender: 'ai',
          text: `Could not locate ${option.description || option.label} anymore. Refresh the vault tree and try again.`
        }]);
        return;
      }

      setBrainScope('note');
      const opened = await openFile(resolvedTargetPath, true);
      setVaultMessages((prev: any[]) => [...prev, {
        sender: 'ai',
        text: opened
          ? `Opened ${toVaultRelativePath(resolvedTargetPath)} in Note mode.`
          : `Found ${toVaultRelativePath(resolvedTargetPath)} but failed to open it.`
      }]);
    }
  };

export const createHandleFileDrop =
  (deps: HandlerDeps) =>
  async (sourcePath: string, targetPath: string): Promise<{ success: boolean; error?: string; newPath?: string }> => {
    const {
      findNodeByPath,
      fileTree,
      resolveVaultTargetPath,
      isMarkdownPath,
      resolveVaultDestinationDirectory,
      getParentDirectory,
      areEquivalentPaths,
      invalidateFileTreeCache,
      vaultPath,
      syncVaultSubtreeInBackground,
      loadFileTree,
      selectedFile,
      openFile,
    } = deps;

    if (!window.atheletiaAPI?.notes) {
      return { success: false, error: 'Notes API not available.' };
    }

    let resolvedSourcePath = sourcePath;
    const sourceNode = findNodeByPath(fileTree, sourcePath);

    if (!sourceNode || !sourceNode.isDirectory) {
      const resolved = await resolveVaultTargetPath(sourcePath, targetPath);
      if (!resolved) {
        return { success: false, error: `Could not locate source note: ${sourcePath}` };
      }
      resolvedSourcePath = resolved;

      if (!isMarkdownPath(resolvedSourcePath)) {
        console.warn('Blocked move for non-markdown file in Brain:', resolvedSourcePath);
        return { success: false, error: 'Only folders or markdown notes can be moved in Brain.' };
      }
    }

    const destinationDir = resolveVaultDestinationDirectory(targetPath);
    const sourceParent = getParentDirectory(resolvedSourcePath);
    if (sourceParent && areEquivalentPaths(sourceParent, destinationDir)) {
      return { success: false, error: 'Source is already in that destination folder.' };
    }


    const result = await window.atheletiaAPI.notes.moveFile(resolvedSourcePath, destinationDir);
    if (result.success) {
      invalidateFileTreeCache(vaultPath);
      syncVaultSubtreeInBackground(sourceParent || resolvedSourcePath);
      syncVaultSubtreeInBackground(destinationDir);
      await loadFileTree(true);

      if (selectedFile && areEquivalentPaths(selectedFile, resolvedSourcePath) && result.newPath) {
        await openFile(result.newPath, true);
      }

      return { success: true, newPath: result.newPath };
    }

    console.error('Move failed:', result.error);
    return { success: false, error: result.error || 'Unknown move failure.' };
  };

export const createBuildBrainVaultContext =
  (deps: HandlerDeps) =>
  (params: { userMessage: string; vaultSearch?: any }) => {
    const {
      selectedFile,
      selectedTreePath,
      toVaultRelativePath,
      isVaultPathActionIntent,
      suggestVaultDirectoryPaths,
      suggestVaultNotePaths,
      vaultPath,
      vaultActionRoot,
    } = deps;

    const currentOpenNote = selectedFile ? toVaultRelativePath(selectedFile) : '(none)';
    const currentSelectedPath = selectedTreePath ? toVaultRelativePath(selectedTreePath) : '(none)';
    const includeCandidates = isVaultPathActionIntent(params.userMessage);
    const candidateFolders = includeCandidates
      ? suggestVaultDirectoryPaths(params.userMessage, 4).map((path: string) => toVaultRelativePath(path))
      : [];
    const candidateNotes = includeCandidates
      ? suggestVaultNotePaths(params.userMessage, 4)
      : [];

    const candidateBlock = includeCandidates
      ? `\nTop folder candidates:\n${candidateFolders.length ? `- ${candidateFolders.join('\n- ')}` : '- none'}\n\nTop note candidates:\n${candidateNotes.length ? `- ${candidateNotes.join('\n- ')}` : '- none'}\n`
      : '';

    return `Vault path: ${vaultPath || '(not selected)'}
Index root: ${vaultActionRoot || '(not selected)'}
Current open note: ${currentOpenNote}
Current selected path: ${currentSelectedPath}${candidateBlock}

Vault evidence status:
- Route: ${params.vaultSearch?.route || 'none'}
- Indexed files: ${params.vaultSearch?.indexedFiles ?? 0}
- Indexed chunks: ${params.vaultSearch?.indexedChunks ?? 0}
- Search hits: ${params.vaultSearch?.hits?.length ?? 0}
- Grounding: ${(params.vaultSearch?.hits?.length ?? 0) > 0 ? 'Use only the hits below for factual claims.' : 'No factual vault evidence was found; do not invent note contents.'}

${params.vaultSearch?.promptContext || 'No vault search context available.'}`;
  };

export const createSubmitClarificationAnswer =
  (deps: HandlerDeps) =>
  (params: {
    answer: string;
    messageIndex: number;
    questionPrompt?: string;
    questionId?: string;
  }) => {
    const {
      isAiLoading,
      brainScope,
      setVaultMessages,
      setAiMessages,
      handleAiSend,
    } = deps;

    const answer = params.answer.trim();
    if (!answer || isAiLoading) return;

    const clearControls = (messages: any[]) => messages.map((message, index) => (
      index === params.messageIndex
        ? {
          ...message,
          options: undefined,
          allowFreeTextReply: false,
          freeTextReplyPlaceholder: undefined,
        }
        : message
    ));

    if (brainScope === 'vault') {
      setVaultMessages((prev: any[]) => clearControls(prev));
    } else {
      setAiMessages((prev: any[]) => clearControls(prev));
    }

    const questionPrompt = (params.questionPrompt || 'Clarification needed').trim();
    const questionId = (params.questionId || `question_${Date.now()}`).trim();
    const followUp = `CLARIFICATION_RESPONSE
question_id: ${questionId}
question: ${questionPrompt}
answer: ${answer}

Use this clarification to complete the previous user request with one precise action. If anything is still ambiguous, ask one narrower ask_question follow-up.`;

    void handleAiSend(followUp, {
      displayUserText: answer,
      skipVaultFileListIntent: true,
      skipVaultMultiFileChainIntent: true,
    });
  };

export const createHandleChatOptionSelect =
  (deps: HandlerDeps) =>
  (
    option: any,
    messageIndex: number,
    questionPrompt?: string,
    questionId?: string,
  ) => {
    const {
      submitClarificationAnswer,
      brainScope,
      handleVaultMessageOptionSelect,
    } = deps;

    if (option.action === 'answer_question') {
      submitClarificationAnswer({
        answer: option.value || option.label,
        messageIndex,
        questionPrompt,
        questionId: option.questionId || questionId,
      });
      return;
    }

    if (brainScope === 'vault') {
      void handleVaultMessageOptionSelect(option, messageIndex);
    }
  };

export const createHandleChatFreeTextReply =
  (deps: HandlerDeps) =>
  (
    reply: string,
    messageIndex: number,
    questionPrompt?: string,
    questionId?: string,
  ) => {
    const { submitClarificationAnswer } = deps;

    submitClarificationAnswer({
      answer: reply,
      messageIndex,
      questionPrompt,
      questionId,
    });
  };

export const createHandleRevertAction =
  (deps: HandlerDeps) =>
  async () => {
    const {
      previousContent,
      selectedFile,
      syncVaultSubtreeInBackground,
      setFileContent,
      setEditContent,
      isEditing,
      editorRef,
      setAiMessages,
      setPreviousContent,
    } = deps;

    if (!previousContent || !selectedFile || !window.atheletiaAPI?.notes) return;

    try {
      const success = await window.atheletiaAPI.notes.writeFile(selectedFile, previousContent);
      if (success) {
        syncVaultSubtreeInBackground(selectedFile);
        setFileContent(previousContent);
        setEditContent(previousContent);
        if (isEditing && editorRef.current) {
          (editorRef.current.commands as any).setContent(previousContent, true);
        }
        setAiMessages((prev: any[]) => [...prev, { sender: 'ai', text: 'Action reverted.' }]);
        setPreviousContent(null);
      }
    } catch (err) {
      console.error('Failed to revert:', err);
    }
  };
