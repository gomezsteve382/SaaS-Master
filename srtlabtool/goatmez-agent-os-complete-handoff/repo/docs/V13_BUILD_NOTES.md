# Goatmez Agent OS v13 - Knowledge Base + Local RAG Layer

## Build objective

Turn Goatmez Agent OS into a retrieval-capable command center that can store SOPs, notes, code documentation, client playbooks, policy references, swipe files, and operating knowledge in a local searchable knowledge base.

## What changed

v13 adds a local-first knowledge base that works without a cloud vector database.

New modules:

- `src/core/knowledgeBaseStore.ts`
- `src/tools/knowledgeTools.ts`

New tools:

- `kb.list`
- `kb.read`
- `kb.search`
- `kb.ingestFile`
- `kb.ingestText`

New API routes:

- `GET /api/knowledge`
- `GET /api/knowledge/:id`
- `DELETE /api/knowledge/:id`
- `POST /api/knowledge/search`
- `POST /api/knowledge/text`
- `POST /api/knowledge/file`

New dashboard panels:

- Knowledge Base document list
- Knowledge search
- File ingestion
- Pasted text ingestion
- Ranked chunk results

## Storage

Knowledge records are stored in:

```txt
.goatmez/knowledge.json
```

The knowledge store keeps:

- documents
- chunks
- tags
- source path/type
- checksum
- timestamps
- keyword indexes

## Retrieval behavior

The v13 search engine uses a deterministic local scoring strategy:

- exact phrase match boost
- token overlap score
- chunk keyword score
- optional tag filtering
- ranked chunk return

This keeps the platform useful even before adding embeddings, Pinecone, Qdrant, Chroma, Postgres pgvector, or OpenAI embeddings.

## Safety model

File ingestion stays inside the approved workspace root and rejects paths outside the workspace.

Large files over 1.5 MB are blocked in v13 to keep local runs fast and predictable.

## Agent access

Built-in agents now have access to `kb.*` tools based on their permission modes.

The fallback planner can automatically:

- list knowledge documents
- search the knowledge base
- ingest a named workspace file into knowledge

## Validation commands

```bash
npm install --ignore-scripts
npm run typecheck -- --pretty false
npm run dev -- "ingest README.md into knowledge base"
npm run dev -- "search knowledge for \"dashboard\""
GOATMEZ_DASHBOARD_PORT=8796 npm run dashboard
```

## Next layer

v14 should add semantic embeddings and a provider-agnostic vector adapter:

- local keyword driver
- OpenAI embeddings driver
- pgvector driver
- Qdrant/Chroma driver
- retrieval context injection into the agent prompt
