# Bugfix Requirements Document

## Introduction

This document captures all bugs, inconsistencies, and production readiness issues identified in the Tauri/React desktop application (NEXUS OS). The application is a productivity dashboard with features including activity tracking, AI-powered chat, notes management, music player, LeetCode progress tracking, and calendar integration.

The issues span multiple categories: error handling, type safety, state management, performance, security, and component integration. Each issue is documented with its current defective behavior and expected correct behavior.

---

## Bug Analysis

### Current Behavior (Defect)

#### 1. Error Handling Issues

1.1 WHEN the Tauri API (`window.nexusAPI`) is undefined or unavailable THEN the system crashes or throws uncaught runtime errors instead of gracefully degrading

1.2 WHEN an API call fails in `chatService.ts` THEN the system returns `undefined` or empty arrays without proper error propagation, causing silent failures

1.3 WHEN `sendChatMessage` encounters an error THEN the system catches the error but displays raw error messages to users without user-friendly formatting

1.4 WHEN the Brain view streams AI responses THEN the system lacks proper error recovery for interrupted streams, leaving the UI in a loading state

1.5 WHEN `fetchCloudModels` or `fetchLMStudioModels` fails THEN the system sets error state but doesn't provide retry mechanisms

1.6 WHEN `preloadBrainVaultCache` fails THEN the system silently catches the error with `console.debug` without notifying the user

1.7 WHEN file operations in `NotesApp` fail THEN the system shows generic alerts without actionable error messages

#### 2. Type Safety Issues

2.1 WHEN accessing `window.nexusAPI` THEN the system uses `any` type casting without proper TypeScript definitions, bypassing type checking

2.2 WHEN `chatService.ts` returns API responses THEN the system uses optional chaining with nullish coalescing that can mask type errors (`?? []`, `?? {}`)

2.3 WHEN `ChatMessage` component processes tool calls THEN the system uses type assertions (`as object`) that can fail at runtime

2.4 WHEN `useIntentStore` defines settings THEN the system has inconsistent optional properties between frontend and backend `AppSettings` interfaces

2.5 WHEN `brainAiService.ts` parses JSON responses THEN the system uses `any` types for parsed objects, losing type safety

2.6 WHEN `ChatPage` handles model selection THEN the system uses type assertions for model IDs without validation

#### 3. State Management Issues

3.1 WHEN `ChatPage` handles streaming tokens THEN the system uses a ref (`streamingContentRef`) that can become stale during rapid updates

3.2 WHEN `useFavoriteModels` refreshes models THEN the system sets up a 5-second polling interval that can cause race conditions with user interactions

3.3 WHEN `useMusicStore` updates playlists THEN the system saves to both localStorage and Tauri backend without transaction safety

3.4 WHEN `useNavStore` checks for unsaved changes THEN the system uses `window.confirm` which blocks the main thread and provides poor UX

3.5 WHEN `App.tsx` loads settings on startup THEN the system doesn't handle the case where settings load after child components mount

3.6 WHEN `ChatPage` creates a new session THEN the system updates state in multiple steps that can cause UI flicker

3.7 WHEN `LeetCodeCard` checks and rotates month data THEN the system uses a 60-second interval that can cause unnecessary re-renders

#### 4. Performance Issues

4.1 WHEN `ChatMessage` renders markdown THEN the system creates new function references on every render for component props

4.2 WHEN `LeetCodeCard` displays the heatmap THEN the system recalculates `problemTitles` map on every render without memoization

4.3 WHEN `NotesApp` renders markdown content THEN the system parses and renders the entire document on every render without caching

4.4 WHEN `ChatPage` filters cloud models THEN the system creates new arrays on every keystroke without debouncing

4.5 WHEN `App.tsx` publishes tray state THEN the system runs a 5-second interval that serializes and sends data even when unchanged

4.6 WHEN `usePlaylistLoader` loads data THEN the system doesn't check if the component is still mounted before updating state

4.7 WHEN `brainAiService.ts` builds RAG context THEN the system processes large documents synchronously, potentially blocking the main thread

#### 5. Security Issues

5.1 WHEN `brainVaultBootstrap.ts` defines the default vault path THEN the system hardcodes an absolute Windows path (`c:\\myself\\...`) that exposes user directory structure

5.2 WHEN `settings.rs` logs API key validation errors THEN the system may include API key fragments in error messages

5.3 WHEN `chatService.ts` passes API keys to backend THEN the system includes them in function parameters that could appear in logs

5.4 WHEN `ChatPage` stores selected model in localStorage THEN the system doesn't sanitize the value before storage

5.5 WHEN `NotesApp` displays file content THEN the system renders user content without sanitization for XSS vectors (though React provides some protection)

5.6 WHEN `brainAiService.ts` repairs JSON THEN the system removes control characters but doesn't validate the resulting content

#### 6. Component Integration Issues

6.1 WHEN `AISummaryCard` is clicked THEN the system stores the prompt in `sessionStorage` without checking if `ChatView` will actually receive it

6.2 WHEN `ChatSidebar` renders sessions THEN the system uses `getRelativeTime` which doesn't handle future timestamps gracefully

6.3 WHEN `DetailModal` handles escape key THEN the system adds a global event listener that isn't properly cleaned up if the component unmounts during the effect

6.4 WHEN `FitnessCard` displays progress THEN the system uses hardcoded values (75%, "Goal") instead of real data

6.5 WHEN `GoalsCard` displays deadlines THEN the system doesn't handle the case where `due_date` is missing or malformed

6.6 WHEN `NewsManager` manages keywords THEN the system doesn't persist changes to any backend, losing data on refresh

6.7 WHEN `ProjectsCard` displays projects THEN the system uses pseudo-random colors based on index instead of meaningful project metadata

#### 7. Backend (Rust) Issues

7.1 WHEN `lib.rs` creates the tray panel window THEN the system uses both `get_webview_window` and `get_window` (deprecated) for the same purpose

7.2 WHEN `settings.rs` stores API keys THEN the system attempts keyring storage but falls back to SQLite without encrypting the fallback

7.3 WHEN `chat.rs` fetches API keys THEN the system makes multiple database queries instead of batching

7.4 WHEN `lib.rs` handles incognito mode THEN the system spawns an async task that runs indefinitely without proper cancellation

7.5 WHEN `settings.rs` validates API keys THEN the system makes network requests without timeout handling for slow connections

7.6 WHEN `chat.rs` stores chat messages THEN the system indexes content for retrieval but doesn't handle indexing failures

#### 8. Missing Features for Production

8.1 WHEN the application encounters an unexpected error THEN the system lacks a global error boundary to catch and display errors gracefully

8.2 WHEN the application starts THEN the system doesn't verify that required Tauri APIs are available before using them

8.3 WHEN the application runs in development mode THEN the system doesn't clearly indicate non-production status

8.4 WHEN users navigate between views THEN the system doesn't implement proper loading states for lazy-loaded components

8.5 WHEN the application window is closed THEN the system doesn't prompt users about active operations (e.g., ongoing AI generation)

8.6 WHEN the tray panel is open THEN the system doesn't handle clicks outside the panel to close it (only backdrop blur is shown)

---

### Expected Behavior (Correct)

#### 1. Error Handling Fixes

2.1 WHEN the Tauri API is undefined or unavailable THEN the system SHALL display a user-friendly error message and disable dependent features gracefully

2.2 WHEN an API call fails in `chatService.ts` THEN the system SHALL throw typed errors with actionable messages that calling code can handle

2.3 WHEN `sendChatMessage` encounters an error THEN the system SHALL display user-friendly error messages with suggested actions (e.g., "Check your API key", "Try again")

2.4 WHEN the Brain view streams AI responses THEN the system SHALL implement proper cancellation and error recovery, resetting UI state on failure

2.5 WHEN `fetchCloudModels` or `fetchLMStudioModels` fails THEN the system SHALL provide a retry button and cache the last successful result

2.6 WHEN `preloadBrainVaultCache` fails THEN the system SHALL log the error appropriately and notify users that Brain features may be limited

2.7 WHEN file operations in `NotesApp` fail THEN the system SHALL display specific error messages with recovery suggestions

#### 2. Type Safety Fixes

2.1 WHEN accessing `window.nexusAPI` THEN the system SHALL use proper TypeScript interface definitions with null checks

2.2 WHEN `chatService.ts` returns API responses THEN the system SHALL use explicit type guards and return `Result<T, Error>` patterns

2.3 WHEN `ChatMessage` component processes tool calls THEN the system SHALL use proper type narrowing with runtime validation

2.4 WHEN `useIntentStore` defines settings THEN the system SHALL have consistent type definitions shared between frontend and backend

2.5 WHEN `brainAiService.ts` parses JSON responses THEN the system SHALL use typed interfaces with runtime validation

2.6 WHEN `ChatPage` handles model selection THEN the system SHALL validate model IDs against known models before using

#### 3. State Management Fixes

3.1 WHEN `ChatPage` handles streaming tokens THEN the system SHALL use a ref that is properly synchronized with state updates

3.2 WHEN `useFavoriteModels` refreshes models THEN the system SHALL implement proper cancellation and avoid race conditions

3.3 WHEN `useMusicStore` updates playlists THEN the system SHALL implement atomic updates with rollback on failure

3.4 WHEN `useNavStore` checks for unsaved changes THEN the system SHALL use a custom modal component instead of `window.confirm`

3.5 WHEN `App.tsx` loads settings on startup THEN the system SHALL use React Suspense or proper loading states for child components

3.6 WHEN `ChatPage` creates a new session THEN the system SHALL batch state updates to prevent UI flicker

3.7 WHEN `LeetCodeCard` checks and rotates month data THEN the system SHALL use efficient comparison to avoid unnecessary re-renders

#### 4. Performance Fixes

4.1 WHEN `ChatMessage` renders markdown THEN the system SHALL use `useMemo` and `useCallback` for stable references

4.2 WHEN `LeetCodeCard` displays the heatmap THEN the system SHALL memoize the `problemTitles` map with proper dependencies

4.3 WHEN `NotesApp` renders markdown content THEN the system SHALL cache parsed content and only re-parse on content change

4.4 WHEN `ChatPage` filters cloud models THEN the system SHALL debounce the search input to reduce re-renders

4.5 WHEN `App.tsx` publishes tray state THEN the system SHALL only send updates when state has actually changed

4.6 WHEN `usePlaylistLoader` loads data THEN the system SHALL use an abort signal or cleanup flag to prevent state updates after unmount

4.7 WHEN `brainAiService.ts` builds RAG context THEN the system SHALL process large documents in chunks or use Web Workers

#### 5. Security Fixes

5.1 WHEN `brainVaultBootstrap.ts` defines the default vault path THEN the system SHALL use a relative path or prompt the user to configure

5.2 WHEN `settings.rs` logs API key validation errors THEN the system SHALL redact sensitive information from all log output

5.3 WHEN `chatService.ts` passes API keys to backend THEN the system SHALL use secure channels and avoid logging

5.4 WHEN `ChatPage` stores selected model in localStorage THEN the system SHALL validate and sanitize the value

5.5 WHEN `NotesApp` displays file content THEN the system SHALL sanitize user content for XSS vectors using DOMPurify

5.6 WHEN `brainAiService.ts` repairs JSON THEN the system SHALL validate the resulting content against expected schemas

#### 6. Component Integration Fixes

6.1 WHEN `AISummaryCard` is clicked THEN the system SHALL use a more reliable state management approach (e.g., URL params, global state)

6.2 WHEN `ChatSidebar` renders sessions THEN the system SHALL handle edge cases like future timestamps and invalid dates

6.3 WHEN `DetailModal` handles escape key THEN the system SHALL properly clean up event listeners on unmount

6.4 WHEN `FitnessCard` displays progress THEN the system SHALL connect to real fitness data sources or indicate placeholder status

6.5 WHEN `GoalsCard` displays deadlines THEN the system SHALL validate and handle missing or malformed date fields

6.6 WHEN `NewsManager` manages keywords THEN the system SHALL persist changes to Tauri backend or localStorage

6.7 WHEN `ProjectsCard` displays projects THEN the system SHALL use meaningful project metadata for styling

#### 7. Backend (Rust) Fixes

7.1 WHEN `lib.rs` creates the tray panel window THEN the system SHALL use only the current API (`get_webview_window`)

7.2 WHEN `settings.rs` stores API keys THEN the system SHALL encrypt the SQLite fallback or require keyring availability

7.3 WHEN `chat.rs` fetches API keys THEN the system SHALL batch queries for efficiency

7.4 WHEN `lib.rs` handles incognito mode THEN the system SHALL implement proper task cancellation with tokio::task::AbortHandle

7.5 WHEN `settings.rs` validates API keys THEN the system SHALL implement configurable timeouts with retry logic

7.6 WHEN `chat.rs` stores chat messages THEN the system SHALL handle indexing failures gracefully without blocking message storage

#### 8. Production Readiness Features

8.1 WHEN the application encounters an unexpected error THEN the system SHALL display a global error boundary with error details and recovery options

8.2 WHEN the application starts THEN the system SHALL verify Tauri API availability and show appropriate warnings

8.3 WHEN the application runs in development mode THEN the system SHALL display a clear visual indicator

8.4 WHEN users navigate between views THEN the system SHALL show loading skeletons or spinners for lazy-loaded components

8.5 WHEN the application window is closed with active operations THEN the system SHALL prompt users to confirm or wait

8.6 WHEN the tray panel is open THEN the system SHALL close it when clicking outside the panel area

---

### Unchanged Behavior (Regression Prevention)

3.1 WHEN the application loads successfully THEN the system SHALL CONTINUE TO display the dashboard with all cards visible

3.2 WHEN users interact with the chat interface THEN the system SHALL CONTINUE TO send messages and receive AI responses

3.3 WHEN users navigate between tabs THEN the system SHALL CONTINUE TO switch views without losing state

3.4 WHEN the music player is active THEN the system SHALL CONTINUE TO play, pause, and skip tracks

3.5 WHEN users create or edit notes THEN the system SHALL CONTINUE TO save changes to the vault

3.6 WHEN the LeetCode tracker records progress THEN the system SHALL CONTINUE TO update the heatmap and streak counter

3.7 WHEN users configure settings THEN the system SHALL CONTINUE TO persist and apply preferences

3.8 WHEN the tray icon is clicked THEN the system SHALL CONTINUE TO show the context menu and control center

3.9 WHEN incognito mode is enabled THEN the system SHALL CONTINUE TO pause activity tracking

3.10 WHEN Google Calendar is connected THEN the system SHALL CONTINUE TO sync events and tasks
