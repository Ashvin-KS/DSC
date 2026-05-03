# Implementation Plan

## Overview

This implementation plan addresses 50+ production readiness issues across 8 categories, organized into 6 phases. Each task references specific requirements from the design document and includes specification annotations.

---

## Phase 1: Foundation (Error Handling + Type Safety)

### 1.1 Error Handling Infrastructure

- [ ] 1.1.1 Create typed error classes with recovery hints
  - Create `ChatServiceError` class with `code`, `recoverable`, and `retryAction` properties
  - Define `ErrorCode` enum for all error types (API_UNAVAILABLE, NETWORK, AUTH, etc.)
  - Map error codes to user-friendly messages
  - _Bug_Condition: isErrorHandlingBug(input) where input.type = 'ERROR' AND NOT isUserFriendlyMessage(input.message)_
  - _Expected_Behavior: User sees actionable error message with suggested actions_
  - _Requirements: 2.1, 2.2, 2.3_

- [ ] 1.1.2 Add API availability guard utility
  - Create `isApiAvailable()` function in `services/chatService.ts`
  - Check `window.nexusAPI` existence with proper null handling
  - Return boolean for conditional feature enabling
  - _Bug_Condition: isErrorHandlingBug(input) where input.type = 'API_UNAVAILABLE' AND NOT gracefulDegradationShown()_
  - _Expected_Behavior: Features gracefully degrade when API unavailable_
  - _Requirements: 2.1_

- [ ] 1.1.3 Implement user-friendly error message mapping
  - Create `USER_FRIENDLY_MESSAGES` constant mapping error codes to messages
  - Include actionable suggestions (e.g., "Check your API key", "Try again")
  - Add recovery hints for each error type
  - _Bug_Condition: isErrorHandlingBug(input) where input.type = 'ERROR' AND NOT isUserFriendlyMessage(input.message)_
  - _Expected_Behavior: All errors display user-friendly messages_
  - _Requirements: 2.3_

### 1.2 chatService.ts Error Propagation

- [ ] 1.2.1 Fix silent failures in getChatSessions
  - Replace `result ?? []` with explicit null check and error throwing
  - Throw `ChatServiceError` with appropriate code when API fails
  - Ensure calling code can handle errors appropriately
  - _Bug_Condition: isErrorHandlingBug(input) where input.type = 'API_FAILURE' AND input.result IN [undefined, [], {}] AND NOT errorThrown()_
  - _Expected_Behavior: API failures propagate as typed errors_
  - _Requirements: 2.2_

- [ ] 1.2.2 Fix silent failures in all chatService methods
  - Audit all methods returning `?? []` or `?? {}`
  - Add explicit error handling with typed errors
  - Ensure error propagation to calling components
  - _Bug_Condition: isErrorHandlingBug(input) where input.type = 'API_FAILURE' AND NOT errorThrown()_
  - _Expected_Behavior: All API failures properly propagate_
  - _Requirements: 2.2_

- [ ] 1.2.3 Add retry mechanism for recoverable failures
  - Implement retry button in error UI for `fetchCloudModels` and `fetchLMStudioModels`
  - Cache last successful result for fallback
  - Add exponential backoff for automatic retries
  - _Bug_Condition: isErrorHandlingBug(input) where input.type = 'RECOVERABLE_FAILURE' AND NOT retryAvailable()_
  - _Expected_Behavior: Users can retry recoverable failures_
  - _Requirements: 2.5_

### 1.3 Brain Vault Error Handling

- [ ] 1.3.1 Replace console.debug with user notification for preload failure
  - In `lib/brainVaultBootstrap.ts`, dispatch custom event on preload failure
  - Show toast notification that Brain features may be limited
  - Include link to settings for vault path configuration
  - _Bug_Condition: isErrorHandlingBug(input) where preloadBrainVaultCache fails AND only console.debug logged_
  - _Expected_Behavior: Users notified when Brain features are limited_
  - _Requirements: 2.6_

### 1.4 ChatPage Stream Error Recovery

- [ ] 1.4.1 Implement stream error recovery in ChatPage
  - Add `handleStreamError` callback with cleanup logic
  - Reset `isStreaming` state on error
  - Set `streamError` state for UI display
  - Implement auto-retry with exponential backoff for network errors
  - _Bug_Condition: isErrorHandlingBug(input) where input.type = 'STREAM_INTERRUPTED' AND UILoadingState = true_
  - _Expected_Behavior: UI resets to non-loading state on stream error_
  - _Requirements: 2.4_

- [ ] 1.4.2 Add stream cancellation support
  - Use AbortController for stream cancellation
  - Clean up resources on component unmount
  - Reset UI state on cancellation
  - _Bug_Condition: Stream interrupted without proper cleanup_
  - _Expected_Behavior: Streams can be cancelled cleanly_
  - _Requirements: 2.4_

### 1.5 NotesApp Error Handling

- [ ] 1.5.1 Replace generic alerts with specific error messages
  - Identify all file operation error handlers in NotesApp
  - Replace generic "Operation failed" with specific messages
  - Add recovery suggestions (e.g., "Check file permissions", "Try again")
  - _Bug_Condition: isErrorHandlingBug(input) where file operation fails AND generic alert shown_
  - _Expected_Behavior: Specific error messages with recovery suggestions_
  - _Requirements: 2.7_

### 1.6 Type Safety Infrastructure

- [ ] 1.6.1 Create shared TypeScript interface definitions
  - Create `lib/types/nexusAPI.ts` with full API interface
  - Define `NexusAPI` interface with all sub-APIs (intent, settings, notes, etc.)
  - Add global Window interface augmentation
  - _Bug_Condition: isTypeSafetyBug(input) where input.contains('as any') OR input.contains(': any')_
  - _Expected_Behavior: All API access properly typed_
  - _Requirements: 2.1_

- [ ] 1.6.2 Create type guards for API responses
  - Add `isChatSessionArray()` type guard
  - Add type guards for all API response types
  - Use runtime validation for external data
  - _Bug_Condition: isTypeSafetyBug(input) where input.contains('as ') AND NOT input.hasRuntimeValidation()_
  - _Expected_Behavior: All type assertions validated at runtime_
  - _Requirements: 2.2, 2.3_

### 1.7 chatService.ts Type Safety

- [ ] 1.7.1 Replace `as any` with proper types
  - Audit all `as any` usages in chatService.ts
  - Replace with proper type annotations
  - Add runtime validation where needed
  - _Bug_Condition: isTypeSafetyBug(input) where input.contains('as any')_
  - _Expected_Behavior: No `any` types without explicit justification_
  - _Requirements: 2.2_

- [ ] 1.7.2 Fix optional chaining with nullish coalescing
  - Replace `result ?? []` with explicit null checks
  - Add proper error handling for null/undefined cases
  - Ensure type errors are not masked
  - _Bug_Condition: isTypeSafetyBug(input) where input.contains('?? []') OR input.contains('?? {}')_
  - _Expected_Behavior: Null cases handled explicitly_
  - _Requirements: 2.2_

### 1.8 ChatMessage Type Safety

- [ ] 1.8.1 Fix type assertions for tool calls
  - Replace `toolCalls as object` with proper type narrowing
  - Add runtime validation for tool call structure
  - Handle edge cases gracefully
  - _Bug_Condition: isTypeSafetyBug(input) where toolCalls cast without validation_
  - _Expected_Behavior: Tool calls properly typed and validated_
  - _Requirements: 2.3_

### 1.9 AppSettings Type Consistency

- [ ] 1.9.1 Sync frontend and backend AppSettings types
  - Compare TypeScript interface with Rust struct
  - Ensure optional properties match on both sides
  - Add serialization tests in Rust
  - _Bug_Condition: isTypeSafetyBug(input) where input.frontendType != input.backendType_
  - _Expected_Behavior: Consistent types across frontend and backend_
  - _Requirements: 2.4_

### 1.10 brainAiService.ts Type Safety

- [ ] 1.10.1 Add typed interfaces for JSON parsing
  - Create interfaces for all parsed JSON structures
  - Replace `JSON.parse(response) as any` with typed parsing
  - Add runtime validation for parsed objects
  - _Bug_Condition: isTypeSafetyBug(input) where JSON.parse returns any_
  - _Expected_Behavior: All parsed JSON properly typed_
  - _Requirements: 2.5_

### 1.11 ChatPage Model Selection Type Safety

- [ ] 1.11.1 Validate model IDs before use
  - Create model ID validation function
  - Validate against known models list
  - Handle invalid model IDs gracefully
  - _Bug_Condition: isTypeSafetyBug(input) where model ID used without validation_
  - _Expected_Behavior: Model IDs validated before use_
  - _Requirements: 2.6_

---

## Phase 2: Core Fixes (State Management + Performance)

### 2.1 ChatPage State Management

- [ ] 2.1.1 Fix stale streamingContentRef
  - Use state-derived ref pattern
  - Keep ref in sync with state via useEffect
  - Ensure ref updates don't cause race conditions
  - _Bug_Condition: isStateManagementBug(input) where input.usesRef AND input.refValue != input.stateValue_
  - _Expected_Behavior: Ref stays synchronized with state_
  - _Requirements: 3.1_

- [ ] 2.1.2 Batch state updates for new session creation
  - Use React 18 automatic batching or flushSync
  - Combine sessionId, messages, and title updates
  - Prevent UI flicker during session creation
  - _Bug_Condition: isStateManagementBug(input) where input.hasMultipleSetStateCalls AND input.causesUIFlicker()_
  - _Expected_Behavior: No UI flicker during state updates_
  - _Requirements: 3.6_

### 2.2 useFavoriteModels Race Condition Fix

- [ ] 2.2.1 Add abort controller for polling
  - Create AbortController in useEffect
  - Pass signal to refreshModels function
  - Abort on unmount or user interaction
  - _Bug_Condition: isStateManagementBug(input) where input.hasPollingInterval AND input.concurrentUpdatesOccurring()_
  - _Expected_Behavior: No race conditions during model refresh_
  - _Requirements: 3.2_

- [ ] 2.2.2 Cancel pending refresh on user interaction
  - Abort polling when user selects a model
  - Restart polling after interaction completes
  - Prevent stale data overwriting user selection
  - _Bug_Condition: Polling races with user model selection_
  - _Expected_Behavior: User selection takes priority_
  - _Requirements: 3.2_

### 2.3 useMusicStore Transaction Safety

- [ ] 2.3.1 Implement atomic playlist updates
  - Create transaction wrapper for dual storage
  - Save to localStorage and Tauri backend atomically
  - Implement rollback on failure
  - _Bug_Condition: isStateManagementBug(input) where input.updatesMultipleSources AND NOT input.isTransactional()_
  - _Expected_Behavior: Playlist updates are atomic_
  - _Requirements: 3.3_

- [ ] 2.3.2 Add rollback mechanism for failed saves
  - Track save state for both storage targets
  - Revert to previous state on failure
  - Notify user of save failure
  - _Bug_Condition: One storage target fails leaving inconsistent state_
  - _Expected_Behavior: State remains consistent on failure_
  - _Requirements: 3.3_

### 2.4 useNavStore Modal Replacement

- [ ] 2.4.1 Replace window.confirm with custom modal
  - Create custom confirmation dialog component
  - Add pendingNavigation state
  - Show modal instead of blocking window.confirm
  - _Bug_Condition: isStateManagementBug(input) where input.usesWindowConfirm AND input.blocksMainThread()_
  - _Expected_Behavior: Non-blocking confirmation dialog_
  - _Requirements: 3.4_

- [ ] 2.4.2 Implement async confirmation flow
  - Create confirmNavigation async function
  - Handle confirm/cancel actions
  - Clean up modal state on navigation
  - _Bug_Condition: window.confirm blocks main thread_
  - _Expected_Behavior: Confirmation is non-blocking_
  - _Requirements: 3.4_

### 2.5 App.tsx Settings Loading

- [ ] 2.5.1 Add loading state for settings initialization
  - Create settingsLoaded state
  - Show loading indicator while settings load
  - Render child components after settings ready
  - _Bug_Condition: isStateManagementBug(input) where input.isSettingsLoad AND input.childrenMountedBeforeSettingsLoaded()_
  - _Expected_Behavior: Children wait for settings to load_
  - _Requirements: 3.5_

- [ ] 2.5.2 Use React Suspense for settings-dependent components
  - Wrap settings-dependent components in Suspense
  - Create settings loading fallback
  - Handle settings load errors
  - _Bug_Condition: Settings load after children mount_
  - _Expected_Behavior: Proper loading states for settings_
  - _Requirements: 3.5_

### 2.6 LeetCodeCard Interval Optimization

- [ ] 2.6.1 Optimize month data rotation check
  - Use efficient comparison to avoid unnecessary re-renders
  - Compare timestamps instead of full objects
  - Only update state when data actually changes
  - _Bug_Condition: isStateManagementBug(input) where 60-second interval causes unnecessary re-renders_
  - _Expected_Behavior: Re-renders only when data changes_
  - _Requirements: 3.7_

### 2.7 ChatMessage Performance

- [ ] 2.7.1 Memoize markdown components prop
  - Wrap components object in useMemo
  - Prevent new object creation on every render
  - Use empty dependency array for stable reference
  - _Bug_Condition: isPerformanceBug(input) where input.hasInlineFunction AND NOT input.isWrappedInUseCallback_
  - _Expected_Behavior: Stable component references_
  - _Requirements: 4.1_

### 2.8 LeetCodeCard Performance

- [ ] 2.8.1 Memoize problemTitles map
  - Wrap map creation in useMemo
  - Add problems as dependency
  - Prevent rebuild on every render
  - _Bug_Condition: isPerformanceBug(input) where input.hasExpensiveComputation AND NOT input.isWrappedInUseMemo_
  - _Expected_Behavior: problemTitles cached between renders_
  - _Requirements: 4.2_

### 2.9 NotesApp Performance

- [ ] 2.9.1 Cache parsed markdown content
  - Wrap parseMarkdown in useMemo
  - Add content as dependency
  - Only re-parse when content changes
  - _Bug_Condition: isPerformanceBug(input) where full markdown re-parses on every render_
  - _Expected_Behavior: Parsed content cached_
  - _Requirements: 4.3_

### 2.10 ChatPage Model Filter Performance

- [ ] 2.10.1 Debounce model filter input
  - Create debounced filter function with useMemo
  - Use 300ms debounce delay
  - Cancel pending filter on new input
  - _Bug_Condition: isPerformanceBug(input) where input.hasFrequentUpdates AND NOT input.hasDebounce_
  - _Expected_Behavior: Filter runs at most every 300ms_
  - _Requirements: 4.4_

### 2.11 App.tsx Tray State Performance

- [ ] 2.11.1 Only send tray state when changed
  - Store last tray state in ref
  - Compare new state with last state
  - Only publish if state differs
  - _Bug_Condition: isPerformanceBug(input) where input.hasInterval AND input.sendsUnchangedData()_
  - _Expected_Behavior: Tray state only sent when changed_
  - _Requirements: 4.5_

### 2.12 usePlaylistLoader Unmount Safety

- [ ] 2.12.1 Add unmount check for async operations
  - Create mounted ref in useEffect
  - Set to false in cleanup function
  - Check ref before state updates
  - _Bug_Condition: isPerformanceBug(input) where input.isAsyncOperation AND NOT input.hasUnmountCheck_
  - _Expected_Behavior: No state updates after unmount_
  - _Requirements: 4.6_

### 2.13 brainAiService RAG Performance

- [ ] 2.13.1 Create Web Worker for RAG context building
  - Create `lib/workers/ragContextWorker.ts`
  - Move buildBrainNoteContext logic to worker
  - Use postMessage for results
  - _Bug_Condition: isPerformanceBug(input) where input.isBlockingOperation AND NOT input.usesWebWorker_
  - _Expected_Behavior: RAG processing doesn't block main thread_
  - _Requirements: 4.7_

- [ ] 2.13.2 Implement chunked document processing
  - Process large documents in chunks
  - Yield control to main thread between chunks
  - Report progress for UI feedback
  - _Bug_Condition: Large documents block main thread_
  - _Expected_Behavior: Large documents processed without blocking_
  - _Requirements: 4.7_

---

## Phase 3: Security Hardening

### 3.1 API Key Redaction

- [ ] 3.1.1 Redact API keys in Rust logs
  - Create `redact_for_log()` function in settings.rs
  - Show only first 4 and last 4 characters
  - Apply to all log statements with API keys
  - _Bug_Condition: isSecurityBug(input) where input.isLogStatement AND input.containsSensitiveData()_
  - _Expected_Behavior: API keys redacted in all logs_
  - _Requirements: 5.2_

- [ ] 3.1.2 Avoid logging API keys in chatService.ts
  - Audit all console.log and error statements
  - Remove any API key parameters from logs
  - Use redacted identifiers instead
  - _Bug_Condition: isSecurityBug(input) where API keys appear in frontend logs_
  - _Expected_Behavior: No API keys in frontend logs_
  - _Requirements: 5.3_

### 3.2 Input Validation

- [ ] 3.2.1 Validate localStorage model ID before storage
  - Create validation function for model IDs
  - Sanitize value before localStorage.setItem
  - Handle invalid values gracefully
  - _Bug_Condition: isSecurityBug(input) where input.writesToLocalStorage AND NOT input.validatesInput_
  - _Expected_Behavior: localStorage values validated_
  - _Requirements: 5.4_

### 3.3 XSS Prevention

- [ ] 3.3.1 Add DOMPurify for markdown sanitization
  - Install dompurify package
  - Wrap parsed markdown in DOMPurify.sanitize()
  - Apply to all user content rendering
  - _Bug_Condition: isSecurityBug(input) where input.rendersUserContent AND NOT input.isSanitized_
  - _Expected_Behavior: User content sanitized for XSS_
  - _Requirements: 5.5_

- [ ] 3.3.2 Configure DOMPurify for markdown safety
  - Allow safe markdown tags only
  - Remove script and iframe tags
  - Test with XSS attack vectors
  - _Bug_Condition: Markdown could contain XSS vectors_
  - _Expected_Behavior: XSS vectors removed from markdown_
  - _Requirements: 5.5_

### 3.4 JSON Repair Validation

- [ ] 3.4.1 Validate repaired JSON in brainAiService
  - Add JSON.parse validation after repair
  - Return safe default for unparseable JSON
  - Log warning for debugging
  - _Bug_Condition: isSecurityBug(input) where input.repairsJSON AND NOT input.validatesResult_
  - _Expected_Behavior: Repaired JSON validated before use_
  - _Requirements: 5.6_

---

## Phase 4: Component Integration

### 4.1 AISummaryCard Cross-Component State

- [ ] 4.1.1 Replace sessionStorage with global state
  - Use zustand store or URL params for prompt passing
  - Create `setPendingPrompt` action in chat store
  - Navigate to chat after setting prompt
  - _Bug_Condition: isComponentIntegrationBug(input) where input.usesSessionStorage AND NOT input.receiverGuaranteedToExist_
  - _Expected_Behavior: Prompt reliably passed to ChatView_
  - _Requirements: 6.1_

### 4.2 ChatSidebar Date Handling

- [ ] 4.2.1 Handle edge cases in getRelativeTime
  - Add null/undefined check for timestamp
  - Handle future timestamps with "In the future" message
  - Handle invalid dates with "Unknown" message
  - _Bug_Condition: isComponentIntegrationBug(input) where input.displaysDate AND NOT input.handlesInvalidDate_
  - _Expected_Behavior: All date edge cases handled_
  - _Requirements: 6.2_

### 4.3 DetailModal Event Listener Cleanup

- [ ] 4.3.1 Fix escape key listener cleanup
  - Store event handler in variable
  - Remove listener in useEffect cleanup
  - Test rapid mount/unmount cycles
  - _Bug_Condition: isComponentIntegrationBug(input) where input.addsEventListener AND NOT input.removesOnUnmount_
  - _Expected_Behavior: Event listeners cleaned up on unmount_
  - _Requirements: 6.3_

### 4.4 FitnessCard Real Data

- [ ] 4.4.1 Connect to real fitness data or indicate placeholder
  - Add data source configuration
  - Show "Connect fitness tracker" if no data
  - Display placeholder indicator when using mock data
  - _Bug_Condition: isComponentIntegrationBug(input) where input.displaysData AND input.isPlaceholderData_
  - _Expected_Behavior: Real data or clear placeholder indication_
  - _Requirements: 6.4_

### 4.5 GoalsCard Date Validation

- [ ] 4.5.1 Handle missing/malformed due_date
  - Add null check for due_date
  - Return "No deadline" for null
  - Return "Invalid date" for malformed dates
  - _Bug_Condition: isComponentIntegrationBug(input) where due_date is null or malformed_
  - _Expected_Behavior: Missing dates handled gracefully_
  - _Requirements: 6.5_

### 4.6 NewsManager Keyword Persistence

- [ ] 4.6.1 Persist keywords to backend
  - Create `saveNewsKeywords` Tauri command
  - Save keywords on change
  - Load keywords on mount
  - _Bug_Condition: isComponentIntegrationBug(input) where input.allowsUserChanges AND NOT input.persistChanges_
  - _Expected_Behavior: Keywords persist across sessions_
  - _Requirements: 6.6_

### 4.7 ProjectsCard Styling

- [ ] 4.7.1 Use meaningful project metadata for colors
  - Define color based on project type or status
  - Remove pseudo-random color generation
  - Add project color configuration option
  - _Bug_Condition: isComponentIntegrationBug(input) where projects use random colors_
  - _Expected_Behavior: Colors reflect project metadata_
  - _Requirements: 6.7_

---

## Phase 5: Backend Improvements

### 5.1 API Migration

- [ ] 5.1.1 Remove deprecated get_window usage in lib.rs
  - Replace all `app.get_window()` with `app.get_webview_window()`
  - Update error handling for Option<WebviewWindow>
  - Test tray panel window creation
  - _Bug_Condition: isBackendBug(input) where input.calls('get_window')_
  - _Expected_Behavior: Only current API used_
  - _Requirements: 7.1_

### 5.2 API Key Encryption

- [ ] 5.2.1 Encrypt SQLite fallback for API keys
  - Create encryption function for sensitive values
  - Encrypt before storing in SQLite
  - Decrypt on retrieval
  - _Bug_Condition: isBackendBug(input) where input.storesSensitiveData AND NOT input.usesEncryption_
  - _Expected_Behavior: API keys encrypted in SQLite_
  - _Requirements: 7.2_

### 5.3 Query Batching

- [ ] 5.3.1 Batch API key queries in chat.rs
  - Create `db_get_api_keys_batch()` function
  - Use single query with IN clause
  - Return HashMap of results
  - _Bug_Condition: isBackendBug(input) where input.hasMultipleQueries AND NOT input.batchesQueries_
  - _Expected_Behavior: Single query for multiple API keys_
  - _Requirements: 7.3_

### 5.4 Task Cancellation

- [ ] 5.4.1 Add cancellation for incognito timer task
  - Store JoinHandle in static AtomicPtr
  - Abort existing task before starting new one
  - Clean up on app shutdown
  - _Bug_Condition: isBackendBug(input) where input.spawnsAsyncTask AND NOT input.hasCancellationHandle_
  - _Expected_Behavior: Incognito task can be cancelled_
  - _Requirements: 7.4_

### 5.5 Network Timeouts

- [ ] 5.5.1 Add timeout to API key validation
  - Configure reqwest client with 15s timeout
  - Handle timeout errors gracefully
  - Add retry logic for transient failures
  - _Bug_Condition: isBackendBug(input) where input.makesNetworkRequest AND NOT input.hasTimeout_
  - _Expected_Behavior: Network requests have timeouts_
  - _Requirements: 7.5_

### 5.6 Indexing Failure Handling

- [ ] 5.6.1 Handle chat message indexing failures gracefully
  - Wrap indexing call in let _ = ...
  - Log warning on failure
  - Continue with message storage
  - _Bug_Condition: isBackendBug(input) where input.performsIndexing AND NOT input.handlesIndexingFailure_
  - _Expected_Behavior: Indexing failures don't block storage_
  - _Requirements: 7.6_

---

## Phase 6: Production Polish

### 6.1 Global Error Boundary

- [ ] 6.1.1 Wrap App with ErrorBoundary component
  - Import ErrorBoundary from components
  - Wrap root App component
  - Test with thrown error
  - _Bug_Condition: isProductionFeatureBug(input) where input.hasUncaughtError AND NOT input.hasGlobalErrorBoundary_
  - _Expected_Behavior: Uncaught errors caught by boundary_
  - _Requirements: 8.1_

- [ ] 6.1.2 Create error boundary fallback UI
  - Design user-friendly error display
  - Include error details and recovery options
  - Add "Reload" and "Report Issue" buttons
  - _Bug_Condition: Error boundary shows raw error_
  - _Expected_Behavior: User-friendly error display_
  - _Requirements: 8.1_

### 6.2 API Availability Check

- [ ] 6.2.1 Check Tauri API availability on startup
  - Add useEffect in App.tsx to check window.nexusAPI
  - Show warning banner if unavailable
  - Disable Tauri-dependent features gracefully
  - _Bug_Condition: isProductionFeatureBug(input) where input.appStarts AND NOT input.verifiesAPIAvailability_
  - _Expected_Behavior: API availability verified on startup_
  - _Requirements: 8.2_

### 6.3 Dev Mode Indicator

- [ ] 6.3.1 Add visual dev mode indicator
  - Check import.meta.env.DEV
  - Show "DEV MODE" badge in corner
  - Style to be visible but not intrusive
  - _Bug_Condition: isProductionFeatureBug(input) where input.isDevelopment AND NOT input.showsDevIndicator_
  - _Expected_Behavior: Dev mode visually indicated_
  - _Requirements: 8.3_

### 6.4 Loading States

- [ ] 6.4.1 Add loading skeletons for lazy components
  - Create ChatLoadingSkeleton component
  - Create BrainLoadingSkeleton component
  - Wrap lazy components in Suspense with fallbacks
  - _Bug_Condition: isProductionFeatureBug(input) where input.hasLazyComponents AND NOT input.hasLoadingStates_
  - _Expected_Behavior: Loading states for all lazy components_
  - _Requirements: 8.4_

### 6.5 Close Confirmation

- [ ] 6.5.1 Add close confirmation for active operations
  - Track active operations state (AI generation, file saves)
  - Show confirmation dialog on window close
  - Allow user to cancel or proceed
  - _Bug_Condition: isProductionFeatureBug(input) where input.hasActiveOperations AND input.windowClosing AND NOT input.promptsUser_
  - _Expected_Behavior: Confirmation shown for active operations_
  - _Requirements: 8.5_

### 6.6 Tray Panel Click-Outside

- [ ] 6.6.1 Add click-outside handler for tray panel
  - Add mousedown listener to document
  - Check if click is outside panel
  - Close panel on outside click
  - _Bug_Condition: isProductionFeatureBug(input) where input.hasModalPanel AND NOT input.closesOnClickOutside_
  - _Expected_Behavior: Panel closes on outside click_
  - _Requirements: 8.6_

---

## Checkpoint

- [ ] 7.1 Run all tests and verify fixes
  - Run unit tests for all modified code
  - Run integration tests for user flows
  - Verify no regressions in existing functionality
  - _Requirements: All_

- [ ] 7.2 Performance validation
  - Profile render times for optimized components
  - Verify memoization reduces re-renders
  - Check main thread is not blocked
  - _Requirements: 4.1-4.7_

- [ ] 7.3 Security validation
  - Audit logs for sensitive data exposure
  - Test XSS vectors in markdown
  - Verify input validation works
  - _Requirements: 5.1-5.6_

- [ ] 7.4 Production readiness review
  - Test error boundary catches all errors
  - Verify API availability check works
  - Test all loading states
  - _Requirements: 8.1-8.6_
