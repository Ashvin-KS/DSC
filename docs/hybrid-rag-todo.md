# Hybrid Retrieval TODO

Goal: improve self-chat recall and reduce hallucinations by moving from raw SQLite lookups to hybrid retrieval.

Chosen free embedder:
- Primary: `BAAI/bge-base-en-v1.5`
- Runtime strategy: local embeddings via Rust background job
- Fallback option for lower-resource machines: `BAAI/bge-small-en-v1.5`

Why this choice:
- Free and local-friendly
- Strong semantic recall for English notes, chats, summaries, and OCR-derived text
- Good quality/latency balance for personal knowledge retrieval

Working context target:
- Default evidence budget: `64k`
- Use larger context windows only for explicit deep-history mode

## Step 1: Schema Foundations
- Add normalized `activity_evidence` table for OCR, URLs, media metadata, and future extracted evidence
- Add `retrieval_chunks` table for searchable/summarisable units across chats, diary, activity summaries, and files
- Add `retrieval_embeddings` table for persisted vectors
- Add `embedding_jobs` queue table for async background embedding generation
- Add `daily_summaries` and `weekly_summaries` tables for long-history retrieval
- Add FTS5 tables for normalized evidence and retrieval chunks

Status: in progress

## Step 2: Ingestion / Normalization
- Mirror raw activity metadata into `activity_evidence`
- Create retrieval chunks from:
  - chat messages or grouped chat windows
  - diary entries
  - OCR / URL / media evidence
  - file-change summaries
- Add invalidation and dedupe rules

Status: pending

## Step 3: Embedding Pipeline
- Add a background embedder worker
- Create embeddings only for chunked text, not raw full rows
- Store vectors with model name and dimensions
- Mark failed jobs and retry with backoff

Status: pending

## Step 4: Query Router
- Structured route: SQL only
- Keyword route: FTS first
- Semantic route: vector + recency weighting
- Mixed route: SQL filters + FTS + vector shortlist

Status: pending

## Step 5: Evidence Pack Builder
- Deduplicate hits
- Merge adjacent chunks
- Group by source and time
- Build compact evidence packs sized for `64k` context
- Include source attribution and uncertainty notes

Status: pending

## Step 6: Long-History Mode
- Use daily/weekly summaries first
- Drill into representative windows only when needed
- Avoid loading raw large history into context

Status: pending

## Step 7: Privacy Controls
- Source-specific retention
- Toggles for OCR, URLs, file previews, and rich titles
- Redaction hooks before chunking/embedding

Status: pending
