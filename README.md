# Obsidian MD Sync Engine

A personal, self-hosted Obsidian.md sync engine that runs on AWS. This project provides real-time synchronization of your Obsidian vault across multiple devices using WebSockets, with intelligent conflict resolution, offline support, and soft delete functionality.

## 🚀 Features

### Core Sync Features
- **Real-time Sync**: WebSocket-based synchronization with instant file updates
- **Intelligent Conflict Resolution**: User-controlled conflict resolution with content preview
- **Offline Support**: Queue-based sync when reconnecting with automatic status detection
- **Bulk Operations**: Smart sync, upload all, download all operations
- **File Type Support**: Markdown, images, PDFs, and all other file types
- **Visual Status**: Status bar indicators showing sync state (Connected/Syncing/Offline/Conflict)

### Advanced Features
- **Soft Delete System**: 30-day retention for deleted files with restore capability
- **Deleted Files Management**: View and restore deleted files before permanent deletion
- **Auto-sync**: Configurable automatic synchronization with customizable intervals
- **Debounced Saves**: Efficient handling of rapid file changes with configurable delays
- **Chunked File Transfer**: Handles large files (>28KB) with automatic chunking
- **Performance Monitoring**: Real-time progress tracking and performance metrics
- **Flexible File Filtering**: Whitelist/blacklist support with folder exclusions

## 🏗️ Architecture

- **Backend**: AWS Lambda + API Gateway WebSocket + S3 + DynamoDB with TTL + DynamoDB Streams (deployed with SST v3)
- **Plugin**: TypeScript Obsidian plugin with real-time WebSocket connection and modal UI
- **Infrastructure**: Serverless, pay-per-use AWS services with automatic cleanup
- **Authentication**: API key-based authentication for secure access

## 📋 Prerequisites

- **Runtime**: Bun (recommended) or Node.js 18+
- **AWS**: AWS CLI configured with appropriate permissions
- **Obsidian**: Desktop app (tested with latest versions)
- **Permissions**: S3, DynamoDB, Lambda, API Gateway, CloudWatch access

## 🚀 Quick Start

### 1. Deploy Backend Infrastructure

```bash
# Clone the repository
git clone https://github.com/your-username/obsync.git
cd obsync

# Install dependencies
bun install

# Set up your API key secret (required for authentication)
bunx sst secret set ApiKey "your-secure-api-key-here"

# Deploy to AWS (requires AWS CLI configured)
bunx sst deploy --stage stage-name

# Note the WebSocket URL from the deployment output
```

### 2. Install Plugin

#### Method 1: Automated Installation (Recommended)
```bash
# Build and deploy plugin to Obsidian
bun run deploy-plugin

# This automatically copies files to your Obsidian plugins directory
```

#### Method 2: Manual Installation
```bash
# Build the plugin
bun run build-plugin

# Create plugin directory in your vault
mkdir -p "/path/to/your/vault/.obsidian/plugins/obsync"

# Copy the built files
cp packages/plugin/main.js "/path/to/your/vault/.obsidian/plugins/obsync/"
cp packages/plugin/manifest.json "/path/to/your/vault/.obsidian/plugins/obsync/"
```

### 3. Configure Plugin

1. **Enable Plugin**:
   - Open Obsidian
   - Go to Settings → Community Plugins
   - Enable "Obsidian Sync Engine"

2. **Configure Settings**:
   - Go to Settings → Obsidian Sync Engine
   - Enter your **API Key** (same as set in step 1)
   - Enter your **WebSocket URL** from deployment output
   - Configure sync preferences (auto-sync, file types, etc.)

3. **Connect**:
   - Click the sync status indicator in the status bar
   - Status should change from "Disconnected" to "Connected"

## 🔧 Configuration

### Plugin Settings

#### Connection Settings
- **API Key**: Your secure authentication key
- **WebSocket URL**: Your deployed AWS WebSocket endpoint

#### Sync Behavior
- **Enable Auto-Sync**: Automatic sync with configurable intervals (default: 30s)
- **Instant Sync Mode**: Real-time sync on every change (vs debounced)
- **Debounce Delay**: Wait time before syncing changes (default: 2s)
- **Sync All File Types**: Include images, PDFs, etc. (not just markdown)

#### File Filtering
- **Use Whitelist**: Only sync specified file extensions
- **Extension Whitelist/Blacklist**: Control which file types to sync
- **Excluded Folders**: Skip specific folders from sync

#### Performance Settings
- **Chunk Size**: Size for splitting large files (default: 28KB)
- **Batch Size**: Number of files to process simultaneously
- **Max File Size**: Skip files larger than specified size
- **Operation Timeout**: Maximum time for sync operations

#### Debug Options
- **Enable Debug Logging**: Detailed console output
- **Show Performance Metrics**: Display sync timing information

### Status Indicators

- 🟢 **Connected**: Real-time sync active
- 🔴 **Disconnected**: Click to connect
- 🔵 **Syncing**: Processing operations
- 🟡 **Conflict**: Files need conflict resolution
- 🟠 **Error**: Connection or sync issues

## 🎯 Usage

### Real-time Sync
Once connected, files are automatically synchronized as you type and save. The system uses intelligent debouncing to avoid excessive network requests and supports both instant and debounced sync modes.

### Commands (Ctrl/Cmd + P)

#### Essential Commands
- `Sync: Smart sync` - ⭐ **Recommended**: Bidirectional sync with conflict resolution
- `Sync: Toggle real-time sync` - Enable/disable WebSocket connection
- `Sync: Toggle auto-sync` - Enable/disable automatic sync intervals

#### Bulk Operations
- `Sync: Sync all files` - Upload all local files to cloud
- `Sync: Download entire vault` - Download all cloud files to local
- `Sync: Check sync status` - Analyze which files are out of sync

#### Individual File Operations
- `Sync: Upload active file` - Manual upload current file
- `Sync: Download active file` - Manual download current file
- `Sync: List cloud files` - View all files in cloud storage

#### Deleted Files Management
- `Sync: View deleted files` - ⭐ **New**: See soft-deleted files with restore options

### Soft Delete System

When you delete a file locally, it's **soft deleted** in the cloud:

1. **30-Day Retention**: Files are kept for 30 days before permanent deletion
2. **View Deleted Files**: Use the "View deleted files" command to see all deleted files
3. **Restore Files**: Click "Restore" in the deleted files modal to recover files
4. **Automatic Cleanup**: After 30 days, files are permanently deleted from cloud storage

### Conflict Resolution

When conflicts are detected (both local and cloud versions have changed), a modal dialog will appear:

1. **File Information**: Shows modification timestamps and file paths
2. **Content Preview**: Displays local and cloud content side-by-side (for text files)
3. **User Choice**: 
   - "Keep Local Version" - Upload your local changes, overwriting cloud
   - "Use Cloud Version" - Download the cloud version, overwriting local
4. **Safe Operation**: Both choices preserve data - the "losing" version is backed up

## 🛠️ Development

### Project Structure
```
obsync/
├── packages/
│   ├── backend/              # AWS Lambda functions
│   │   └── src/
│   │       ├── websocket/    # WebSocket handlers
│   │       │   ├── connect.ts    # Connection management
│   │       │   ├── disconnect.ts # Cleanup on disconnect
│   │       │   └── message.ts    # File operations & real-time sync
│   │       └── subscriber.ts # DynamoDB stream handler for TTL cleanup
│   └── plugin/               # Obsidian plugin
│       ├── src/
│       │   └── main.ts       # Plugin implementation with UI modals
│       ├── manifest.json     # Plugin metadata
│       └── esbuild.config.mjs # Build configuration
├── sst.config.ts             # Infrastructure as code (SST v3)
├── AGENTS.md                 # Development guidelines
├── IDEA.md                   # Project milestones and progress
└── README.md
```

### Local Development

```bash
# Start SST development environment
bunx sst dev

# Build plugin for testing
bun run build-plugin

# Deploy plugin to Obsidian (builds and copies)
bun run deploy-plugin

# Test backend functions
cd packages/backend && bun test

# Test plugin
cd packages/plugin && bun test

# Lint and format code
bunx @biomejs/biome check --write .
```

### Plugin Development

The plugin uses modern Obsidian APIs and patterns:
- **WebSocket API**: Real-time bidirectional communication
- **Vault API**: File operations (create, read, update, delete)
- **Modal API**: Conflict resolution and deleted files management
- **Settings API**: Comprehensive configuration options
- **Status Bar API**: Visual sync status indicators
- **Command API**: Palette commands for all operations
- **Event System**: File watching and change detection

## 🔒 Security

- **Authentication**: API key-based authentication for all operations
- **IAM Permissions**: Lambda functions have minimal required permissions
- **S3 Security**: Bucket access restricted to specific file paths
- **DynamoDB Security**: Access limited to required table operations only
- **Transport Security**: WebSocket connections use secure WSS protocol
- **Data Isolation**: Each user's data is isolated by API key

## 📊 Monitoring & Observability

- **CloudWatch Logs**: Detailed Lambda function execution logs
- **Connection Tracking**: WebSocket connections stored in DynamoDB
- **Plugin Debugging**: Comprehensive logging in Obsidian Developer Console
- **Performance Metrics**: Optional timing and performance data
- **Sync Status**: Real-time status indicators and progress tracking
- **Error Reporting**: Detailed error messages and recovery suggestions

## 🐛 Troubleshooting

### Connection Issues
1. **Verify Configuration**:
   - Check API Key matches the one set with `bunx sst secret set ApiKey`
   - Verify WebSocket URL is correct (from `bunx sst deploy` output)
   - Ensure AWS credentials have proper permissions

2. **Check Logs**:
   - AWS CloudWatch logs for backend errors
   - Obsidian Developer Console (Ctrl+Shift+I) for plugin errors

### Sync Problems
1. **Diagnostic Commands**:
   - Use "Check sync status" to identify out-of-sync files
   - Try "Smart sync" to resolve discrepancies automatically
   - Use "List cloud files" to verify cloud state

2. **Common Solutions**:
   - Restart Obsidian if WebSocket connection is stuck
   - Check file permissions and disk space
   - Verify file isn't locked by another application

### File Conflicts
1. **Automatic Resolution**: Conflict modal appears when both local and cloud versions changed
2. **Safe Choices**: Both "Keep Local" and "Use Cloud" preserve data
3. **Preview Content**: Use side-by-side preview to make informed decisions
4. **Backup**: The "losing" version is automatically backed up

### Deleted Files
1. **Recovery**: Use "View deleted files" command to restore accidentally deleted files
2. **Time Limit**: Files are permanently deleted after 30 days
3. **Manual Cleanup**: Restored files appear immediately in your vault

### Performance Issues
1. **Large Files**: Files >28KB are automatically chunked
2. **Batch Size**: Reduce batch size in settings for slower connections
3. **Debounce Delay**: Increase delay to reduce API calls during rapid editing
4. **File Filtering**: Use whitelist/blacklist to sync only necessary files

## 📈 Performance Features

- **Chunked Transfer**: Automatic chunking for large files (>28KB) prevents timeouts
- **Debounced Operations**: Configurable delays reduce unnecessary API calls
- **Batched Processing**: Bulk operations process multiple files efficiently
- **Auto-reconnection**: Exponential backoff prevents connection spam
- **Progress Tracking**: Real-time progress indicators for long operations
- **Memory Management**: Efficient handling of large vaults and files
- **Selective Sync**: File filtering reduces bandwidth and processing
- **Connection Pooling**: Reuses WebSocket connections for multiple operations

## 🤝 Contributing

This is a personal project, but contributions are welcome:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details

## 🔗 Related Projects

- [Obsidian](https://obsidian.md/) - The knowledge management app
- [SST](https://sst.dev/) - Modern AWS infrastructure framework
