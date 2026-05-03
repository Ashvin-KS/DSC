# Line Cap Audit (2026-04-06)

## Policy
- Target cap: 1300 lines per file.
- Allowed exception cap: 2000 lines only when strictly required.

## Results Snapshot

### Violating 2000-line Hard Cap
| File | Lines | Status |
| --- | ---: | --- |
| (none) | - | compliant |

### In Exception Band (1301-2000)
| File | Lines | Status |
| --- | ---: | --- |
| views/brain/BrainViewHandlers.ts | 1984 | compliant (exception band) |
| views/BrainView.tsx | 1923 | compliant (exception band) |
| src-tauri/src/intent/retrieval.rs | 1968 | compliant (exception band) |
| src-tauri/src/lib.rs | 1929 | compliant (exception band) |
| src-tauri/src/services/query_engine.rs | 1566 | compliant (exception band) |

### Near Limit (1200-1300)
| File | Lines | Status |
| --- | ---: | --- |
| views/CodeView.tsx | 1295 | monitor |

## Refactors Completed In This Pass
- Split src-tauri/src/services/query_engine.rs into helper units:
  - src-tauri/src/services/query_engine_execution_helpers.incl.rs
  - src-tauri/src/services/query_engine_post_helpers.incl.rs
- Split src-tauri/src/intent/retrieval.rs helper block into:
  - src-tauri/src/intent/retrieval_vault_index_helpers.incl.rs
- Split BrainView support renderers into:
  - views/brain/BrainViewSupportComponents.tsx
- Split BrainView shared utilities/types/editor into:
  - views/brain/BrainViewShared.tsx
- Split BrainView orchestration callbacks into:
  - views/brain/BrainViewHandlers.ts

## Remaining Work
1. Optional: reduce `views/BrainView.tsx` and `views/brain/BrainViewHandlers.ts` toward the 1300 target if additional decomposition is desired.
2. Optional: decompose `src-tauri/src/intent/retrieval.rs` and `src-tauri/src/lib.rs` further to leave the exception band.

## Verification
- TypeScript check: passed (`npx tsc --noEmit`).
- Rust check: passed (`cargo check`).
