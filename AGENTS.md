# Agent Guidelines for obsync

## Build/Test Commands
- **Build plugin**: `bun run build-plugin` (builds packages/plugin with esbuild)
- **Deploy plugin**: `bun run deploy-plugin` (builds and copies to Obsidian)
- **Test backend**: `cd packages/backend && bun test` (uses vitest via sst shell)
- **Test plugin**: `cd packages/plugin && bun test` (uses vitest via sst shell)
- **Lint/Format**: `bunx @biomejs/biome check --write .` (uses Biome for linting/formatting)

## Code Style Guidelines
- **Runtime**: Use Bun instead of Node.js/npm/pnpm (see .cursor/rules)
- **Formatting**: 2-space indentation, double quotes (configured in biome.json)
- **Imports**: Auto-organize imports enabled in Biome config
- **Types**: Strict TypeScript with proper type annotations
- **Error handling**: Use try-catch blocks with proper error logging
- **Naming**: camelCase for variables/functions, PascalCase for classes/interfaces
- **File structure**: Monorepo with packages/backend and packages/plugin
- **WebSocket**: Use native WebSocket API, not external libraries
- **AWS SDK**: Use v3 SDK with proper client initialization
- **Obsidian**: Follow Obsidian plugin patterns with proper lifecycle management

## Architecture Notes
- SST v3 for infrastructure (sst.config.ts)
- WebSocket API for real-time sync between Obsidian plugin and AWS backend
- DynamoDB for connection tracking and file metadata
- S3 for file storage with presigned URLs
- Plugin uses chunking for large files (28KB chunks)
- Debounced file sync to prevent excessive uploads