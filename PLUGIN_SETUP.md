# Obsidian Plugin Setup Guide

This guide explains how to install and test the Obsidian Sync Engine plugin.

## Installation

1. **Locate Obsidian plugins directory**: `~/.config/obsidian/plugins/`

2. **Create plugin directory**:
   ```bash
   cd [obsidian-plugins-directory]
   mkdir obsidian-sync-engine
   ```

3. **Copy plugin files**:
   Copy these files from `packages/plugin/` to the plugin directory:
   - `main.js` (compiled plugin code)
   - `manifest.json` (plugin metadata)

## Configuration

1. **Enable the plugin**:
   - Open Obsidian
   - Go to Settings → Community plugins
   - Turn off "Safe mode" if it's enabled
   - Find "Obsidian Sync Engine" in the list
   - Enable it

2. **Configure settings**:
   - In plugin settings, set API URL to: `https://b3owvufifgx3xlzs7p7z2plxpi0ohtji.lambda-url.eu-north-1.on.aws/`
   - Username and password are optional for now

## Testing

1. **Create a test file**:
   - Create a new markdown file in Obsidian
   - Add some content

2. **Test upload**:
   - Open Command Palette (Ctrl/Cmd + P)
   - Run: `Sync: Upload active file to cloud`
   - Check status bar for "Upload complete"

3. **Test file listing**:
   - Run: `Sync: List files in cloud`
   - Should show your uploaded file

4. **Test download**:
   - Modify the file locally
   - Run: `Sync: Download active file from cloud`
   - File should revert to cloud version

## Status Indicators

The plugin shows sync status in the bottom status bar:
- `Sync: Disconnected` - No API URL configured
- `Sync: Uploading...` - File upload in progress
- `Sync: Download complete` - Download finished
- `Sync: Connected` - Ready for sync operations

## Current Limitations

- **Single user**: Currently hardcoded to "test-user"
- **No authentication**: Username/password not yet implemented
- **Manual sync only**: No automatic sync yet
- **No conflict resolution**: Will be added in later milestones

## Next Steps

After Milestone 3, we'll implement:
- Real-time WebSocket sync
- Automatic file watching
- Conflict resolution
- Proper user authentication 
