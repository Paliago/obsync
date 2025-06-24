# Learnings

This document captures useful insights and learnings from building the Obsidian MD Sync Engine.

## Project Structure & SST

- **SST Configuration**: The project uses SST v3 with modern AWS patterns
  - Default Lambda runtime: Node.js 22.x with ARM64 architecture for better performance
  - Resources are linked to Lambda functions using the `link` property
  - Environment protection is set up for production stage
  - Using `sst.aws.Bucket` and `sst.aws.Dynamo` for managed AWS resources

- **DynamoDB Design**: The table uses a flexible single-table design pattern with:
  - Primary key: `pk` (partition key) and `sk` (sort key)
  - Two Global Secondary Indexes (GSI1 and GSI2) for different access patterns
  - TTL field `expireAt` for automatic cleanup of expired data
  - This design allows for efficient querying across different entities (users, files, connections)

- **Lambda Function URL**: Using Function URLs instead of API Gateway for simple HTTP endpoints
  - Simpler setup and lower latency for basic REST operations
  - Built-in CORS support
  - No additional API Gateway costs

## AWS SDK & Dependencies

- **Modern AWS SDK v3**: Using modular AWS SDK v3 clients
  - `@aws-sdk/client-s3` for S3 operations
  - `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` for DynamoDB
  - `@aws-sdk/lib-storage` for multipart uploads
  - `@aws-sdk/s3-request-presigner` for presigned URLs if needed

- **Package Management**: Using Bun with catalog dependencies for version management
  - SST and Zod are managed through the catalog system
  - Consistent dependency versions across the monorepo

## Development Patterns

- **TypeScript Configuration**: Each package has its own tsconfig.json
  - Modular TypeScript setup allows for different configurations per package
  - SST environment types are properly imported via sst-env.d.ts files

- **Lambda Function URL vs API Gateway**: Lambda Function URLs have a different event structure
  - Function URLs use `event.rawPath` instead of `event.path`
  - Function URLs use `event.requestContext.http.method` instead of `event.httpMethod`
  - The event structure is more similar to ALB events than API Gateway events

## Development Workflow

- **SST Development**: Use `bun sst dev` for live development with log streaming
  - Logs appear in real-time in the terminal
  - Much faster than checking CloudWatch logs
  - Shows function invocations as they happen

## Backend Implementation Insights

- **File Storage Pattern**: Using `userId/filePath` as S3 key structure
  - Enables natural file organization and access control
  - Easy to query and manage per-user files

- **DynamoDB Single Table Design**: 
  - `pk = USER#${userId}` and `sk = FILE#${filePath}` for file records
  - Enables efficient querying of all files for a user
  - GSI indexes allow for alternative access patterns

- **Testing Strategy**: Created a separate test helper Lambda function
  - Easier to set up test data programmatically
  - Can be called via HTTP to initialize test scenarios
  - Separated from main API logic for cleaner code

## Milestone 2 Completed Successfully

✅ **File Download Endpoint**: `GET /{filePath}` - retrieves file content from S3
✅ **File List Endpoint**: `GET /versions` - returns JSON map of `filePath: version`
✅ **Testing**: Successfully tested with curl commands
✅ **Infrastructure**: Lambda Function URLs working with S3 and DynamoDB integration

## Obsidian Plugin Development

- **Plugin Structure**: Obsidian plugins use TypeScript with specific APIs
  - Main plugin class extends `Plugin` from 'obsidian'
  - Settings stored using `loadData()` and `saveData()` methods
  - Commands added via `addCommand()` with callback functions
  - Status bar items for user feedback

- **Monorepo Organization**: Plugin moved to proper monorepo structure
  - **`packages/plugin/`** - Official plugin location (our working code)
  - **`obsidian-sample-plugin/`** - Initial development location (deprecated)
  - Better integration with the overall project structure

- **Plugin Build Process**: 
  - Uses esbuild for compilation (not webpack or vite)
  - TypeScript version conflicts with newer Bun types
  - Can skip TypeScript checking and build directly with esbuild
  - Generates `main.js` file that Obsidian loads

- **API Integration Patterns**:
  - Use `fetch()` for HTTP requests to backend
  - Handle async operations with proper error handling
  - Use `new Notice()` for user notifications
  - Status bar for real-time feedback

## Milestone 3 Completed Successfully

✅ **Plugin Settings Tab**: Created settings interface with API URL, username, password fields
✅ **Manual Upload Command**: `Sync: Upload active file to cloud` command in Command Palette
✅ **Manual Download Command**: `Sync: Download active file from cloud` command in Command Palette  
✅ **File List Command**: `Sync: List files in cloud` command in Command Palette
✅ **Status Bar Integration**: Real-time sync status display
✅ **Backend Upload Endpoint**: `PUT /` endpoint for file uploads with versioning
✅ **End-to-End Testing**: Successfully tested upload → list → download workflow

## Testing Results

```bash
# Upload file
curl -X PUT [API_URL] -d '{"filePath": "test.md", "content": "..."}'
# Returns: {"message":"File uploaded successfully","filePath":"test.md","version":1}

# List files  
curl [API_URL]/versions
# Returns: {"test.md":1}

# Download file
curl [API_URL]/test.md
# Returns: File content
``` 

## Milestone 5: Conflict Resolution Completed

✅ **Conflict Resolution UI**: Implemented using Obsidian's Modal API
- Created `ConflictResolutionModal` class with step-by-step conflict resolution
- Shows modification timestamps and content previews for text files
- User-friendly interface with "Keep Local" vs "Use Cloud" choices
- Handles multiple conflicts sequentially

✅ **Enhanced Smart Sync Logic**: Updated conflict detection to identify true conflicts
- Detects when both local and cloud versions have changed since last sync
- Distinguishes between conflicts and simple newer-version scenarios
- Integrates seamlessly with existing sync operations

## Milestone 6: Polishing Features Completed

✅ **Enhanced Error Handling**:
- Added comprehensive error messages for WebSocket failures
- Improved reconnection logic with attempt limits and user notifications
- Better timeout handling for large file operations
- Graceful degradation when services are unavailable

✅ **Advanced Settings UI**:
- **Instant Sync Mode**: Option to disable debouncing for immediate sync
- **Configurable Debounce Delay**: Slider control (500ms to 10s)
- **Configurable Auto-Sync Interval**: Slider control (10s to 5min)
- Real-time settings application with automatic restart of intervals

✅ **Comprehensive Documentation**: Updated README.md with:
- Complete setup and deployment instructions
- Feature overview and usage guide
- Troubleshooting section
- Development workflow documentation

## Plugin Architecture Insights

### Conflict Resolution Pattern
The conflict resolution system uses a multi-step approach:
1. **Detection**: Compare local vs cloud vs last-known timestamps
2. **Collection**: Gather all conflicts before showing UI
3. **Resolution**: Present modal dialog for each conflict
4. **Execution**: Apply user choices and continue sync operation

### Settings Management
- Settings are stored in Obsidian's data storage
- Real-time updates with automatic persistence
- Graceful handling of setting changes during active sync
- Backward compatibility with existing settings

### Error Recovery Strategies
- **Exponential Backoff**: For connection retries (max 5 attempts)
- **User Notifications**: Clear error messages with actionable advice
- **Graceful Degradation**: Operations continue working when possible
- **State Recovery**: Proper cleanup of partial operations

## Development Workflow Optimizations

### TypeScript Challenges
- Bun types conflict with Obsidian plugin TypeScript compilation
- Solution: Skip TypeScript checking and use esbuild directly
- Command: `node esbuild.config.mjs production` for builds

### Build Process
- Plugin builds to `main.js` (~35KB for full feature set)
- Use `bun run deploy-plugin` for streamlined deployment
- Development builds can skip type checking for faster iteration

## Plugin Performance Notes

### Debouncing Strategy
- Default 2-second debounce prevents excessive API calls
- Configurable delay allows power users to optimize for their workflow
- Instant mode available for users who prefer immediate sync
- Per-file debouncing prevents sync storms

### Large File Handling
- Automatic chunking for files >28KB
- Progress indicators for large file operations
- Increased timeouts for upload/download operations
- User notifications for large file processing

## Next Development Priorities

Based on current progress, the remaining high-value features are:
1. **Authentication System** (Milestone 7) - Currently single-user
2. **Soft Delete with Recovery** (Milestone 8) - 30-day TTL system
3. **UI Cleanup** (Milestone 9) - Remove unnecessary commands/settings

The core sync engine is now feature-complete with robust conflict resolution,
comprehensive error handling, and user-friendly configuration options.
