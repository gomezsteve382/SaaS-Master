# Goatmez Agent OS — Extraction Index

## Purpose

This index organizes the clean-room extraction packs and the original starter repo for building Goatmez Agent OS.

## Extraction Packs

1. Part 01 — Repo + Core Architecture Map
2. Part 02 — Tool System
3. Part 03 — MCP Layer
4. Part 04 — Permission System Deep Dive
5. Part 05 — Query + Tool Execution Deep Dive
6. Part 06 — Agent + Subagent System Deep Dive
7. Part 07 — MCP Runtime Deep Dive
8. Part 08 — Clean-Room Master Build Spec
9. Part 09 — Command, Plugin, and Skill Systems Deep Dive
10. Part 10 — Memory and Task Systems Deep Dive
11. Part 11 — UI, Bridge, Server, and Observability Deep Dive
12. Part 12 — Context, Prompt, Message, and Token Runtime Deep Dive
13. Part 13 — File, Code, Shell, Search, and Sandbox Tooling Deep Dive
14. Part 14 — Settings, Config, Feature Flags, and Policy Layer Deep Dive
15. Part 15 — Hooks, Events, Logging, Telemetry, and Observability Deep Dive
16. Part 16 — Clean-Room Rebuild Protocol

## Starter Repo

`goatmez-agent-os-starter.zip` contains original TypeScript code implementing the first clean-room runtime skeleton:

- Agent runtime
- Context compiler
- Tool registry
- Permission gateway
- Event ledger
- Memory store
- Task engine
- MCP connector placeholder
- File tools
- Shell tool
- CLI demo

## Build Priority

### Sprint 1

- Run starter repo
- Add real LLM adapter
- Add approval queue
- Persist event ledger

### Sprint 2

- Add MCP SDK integration
- Add dashboard
- Add Postgres storage
- Add workspace configs

### Sprint 3

- Add business agents: Credit Plug, Empire Architect, SEO Hunter, GHL Builder
- Add browser automation
- Add GHL/Gmail/Calendar connectors
