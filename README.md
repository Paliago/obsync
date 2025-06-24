# Obsidian MD Sync Engine

A personal, self-hosted Obsidian.md sync engine that runs on AWS. This project provides real-time synchronization of your Obsidian vault across multiple devices using WebSockets, with intelligent conflict resolution and offline support.

## 🚀 Features

- **Real-time Sync**: WebSocket-based synchronization with instant file updates
- **Intelligent Conflict Resolution**: User-controlled conflict resolution with content preview
- **Offline Support**: Queue-based sync when reconnecting
- **Bulk Operations**: Smart sync, upload all, download all operations
- **File Type Support**: Markdown, images, PDFs, and all other file types
- **Visual Status**: Status bar indicators showing sync state
- **Auto-sync**: Configurable automatic synchronization
- **Debounced Saves**: Efficient handling of rapid file changes

## 🏗️ Architecture

- **Backend**: AWS Lambda + API Gateway WebSocket + S3 + DynamoDB (deployed with SST)
- **Plugin**: TypeScript Obsidian plugin with real-time WebSocket connection
- **Infrastructure**: Serverless, pay-per-use AWS services

## 📋 Prerequisites

- Node.js 18+ or Bun
- AWS CLI configured with appropriate permissions
- Obsidian desktop app

## 🚀 Quick Start

### 1. Deploy Backend Infrastructure

```bash
# Clone the repository
git clone <your-repo-url>
cd obsync

# Install dependencies
bun install

# Deploy to AWS (requires AWS CLI configured)
bun sst deploy

# Note the WebSocket URL from the deployment output
```

### 2. Install Plugin

#### Method 1: Manual Installation (Recommended)
```bash
# Build the plugin
bun run deploy-plugin

# Copy the built files to your Obsidian vault
cp packages/plugin/main.js /path/to/your/vault/.obsidian/plugins/obsync/
cp packages/plugin/manifest.json /path/to/your/vault/.obsidian/plugins/obsync/
```

#### Method 2: Development Installation
```bash
# Symlink for development
ln -s $(pwd)/packages/plugin /path/to/your/vault/.obsidian/plugins/obsync
```

### 3. Configure Plugin

1. Open Obsidian
2. Go to Settings → Community Plugins
3. Enable "Obsidian Sync Engine"
4. In plugin settings, enter your WebSocket URL from step 1
5. Click the sync status indicator in the status bar to connect

## 🔧 Configuration

### Plugin Settings

- **WebSocket URL**: Your deployed AWS WebSocket endpoint
- **Username/Password**: For future authentication (currently unused)
- **Enable Auto-Sync**: Automatic sync every 30 seconds
- **Sync All File Types**: Include images, PDFs, etc. (not just markdown)

### Status Indicators

- 🟢 **Connected**: Real-time sync active
- 🔴 **Disconnected**: Click to connect
- 🔵 **Syncing**: Processing operations
- 🟡 **Error**: Connection issues

## 🎯 Usage

### Real-time Sync
Once connected, files are automatically synchronized as you type and save. The system uses intelligent debouncing to avoid excessive network requests.

### Commands (Ctrl/Cmd + P)

**Recommended Commands:**
- `Sync: Smart sync` - ⭐ Bidirectional sync with conflict resolution
- `Sync: Toggle auto-sync` - Enable/disable automatic sync

**Bulk Operations:**
- `Sync: Upload all files to cloud` - One-way upload
- `Sync: Download entire vault from cloud` - One-way download
- `Sync: Check which files are out of sync` - Status check

**Individual File Commands:**
- `Sync: Upload active file` - Manual upload current file
- `Sync: Download active file` - Manual download current file

### Conflict Resolution

When conflicts are detected (both local and cloud versions have changed), a modal dialog will appear:

1. **File Information**: Shows modification timestamps
2. **Content Preview**: Displays local and cloud content (for text files)
3. **User Choice**: 
   - "Keep Local Version" - Upload your local changes
   - "Use Cloud Version" - Download the cloud version

## 🛠️ Development

### Project Structure
```
obsync/
├── packages/
│   ├── backend/          # AWS Lambda functions
│   │   └── src/
│   │       ├── websocket/  # WebSocket handlers
│   │       ├── connect.ts
│   │       ├── disconnect.ts
│   │       └── message.ts
│   └── plugin/           # Obsidian plugin
│       └── src/
│           └── main.ts   # Plugin implementation
├── sst.config.ts         # Infrastructure config
└── README.md
```

### Local Development

```bash
# Start SST development environment
bun sst dev

# Build plugin for testing
bun run deploy-plugin

# Watch plugin changes
cd packages/plugin
bun run dev
```

### Plugin Development

The plugin uses modern Obsidian APIs:
- WebSocket for real-time communication
- Vault API for file operations
- Modal API for conflict resolution
- Settings API for configuration

## 🔒 Security

- Lambda functions have minimal IAM permissions
- S3 bucket access restricted to specific paths
- DynamoDB access limited to required operations
- WebSocket connections use secure WSS protocol

## 📊 Monitoring

- CloudWatch logs for Lambda functions
- WebSocket connection tracking in DynamoDB
- Plugin debug logs in Obsidian Developer Console

## 🐛 Troubleshooting

### Connection Issues
1. Verify WebSocket URL is correct
2. Check AWS CloudWatch logs
3. Ensure AWS credentials have proper permissions

### Sync Problems
1. Use "Check sync status" command to diagnose
2. Try "Smart sync" to resolve discrepancies
3. Check Obsidian Developer Console for errors

### File Conflicts
1. Conflict resolution modal should appear automatically
2. Use content preview to make informed decisions
3. Both choices are safe - no data loss occurs

## 📈 Performance

- Efficient chunking for large files (>28KB)
- Debounced file watching to reduce API calls
- Batched operations for bulk sync
- Auto-reconnection with exponential backoff

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
