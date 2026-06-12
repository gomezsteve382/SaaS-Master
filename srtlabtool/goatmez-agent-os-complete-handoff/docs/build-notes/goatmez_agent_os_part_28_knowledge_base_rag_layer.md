# Goatmez Agent OS - Part 28: Knowledge Base + Local RAG Layer

## Objective

Give Goatmez Agent OS a local retrieval layer so agents can search operating knowledge instead of relying only on short-term memory or raw files.

## New capability

v13 adds a local knowledge base with ingestion, chunking, keyword indexing, ranked retrieval, and dashboard controls.

## New tools

- `kb.list` - list ingested documents
- `kb.read` - read one document and its chunks
- `kb.search` - ranked search across knowledge chunks
- `kb.ingestFile` - add a workspace file to the knowledge base
- `kb.ingestText` - add pasted text/SOP notes to the knowledge base

## New dashboard layer

The dashboard now includes:

- a Knowledge Base panel
- file ingestion form
- pasted text ingestion form
- search form
- ranked result cards
- document delete controls

## Why this matters

This is the foundation for business-specific agents:

- Credit Plug can search dispute SOPs and client notes.
- Empire Architect can search strategy notes and playbooks.
- Developer Agent can search build docs and architecture notes.
- Operator can search internal procedures before taking action.

## Storage

The system stores local knowledge in:

```txt
.goatmez/knowledge.json
```

The store contains documents and chunks with tags, checksum, source, timestamps, and keyword indexes.

## Retrieval model

v13 uses deterministic local retrieval first:

1. Normalize text
2. Chunk content
3. Extract keywords
4. Score query tokens against title, tags, keywords, and chunk text
5. Return ranked chunks

This is intentionally dependency-light. v14 can add embeddings and vector DB support.

## Build status

v13 is a working local RAG foundation.
