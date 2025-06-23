import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';

interface SyncSettings {
	username: string;
	password: string;
	apiUrl: string;
	websocketUrl: string;
}

const DEFAULT_SETTINGS: SyncSettings = {
	username: '',
	password: '',
	apiUrl: '',
	websocketUrl: ''
}

interface WebSocketMessage {
	action: string;
	filePath?: string;
	content?: string;
	version?: string;
	type?: string;
	files?: Record<string, string>;
	message?: string;
}

export default class ObsidianSyncPlugin extends Plugin {
	settings!: SyncSettings;
	statusBarItem!: HTMLElement;
	ws: WebSocket | null = null;
	isConnecting: boolean = false;
	reconnectAttempts: number = 0;
	maxReconnectAttempts: number = 5;
	reconnectTimeout: NodeJS.Timeout | null = null;
	fileWatchingEnabled: boolean = true;
	lastModifiedTimes: Map<string, number> = new Map();
	
	// Bulk sync management
	uploadQueue: string[] = [];
	downloadQueue: string[] = [];
	isProcessingQueue: boolean = false;
	cloudFileVersions: Map<string, string> = new Map();
	localFileVersions: Map<string, number> = new Map();
	isBulkSyncing: boolean = false;
	syncProgress: { current: number; total: number } = { current: 0, total: 0 };

	async onload() {
		await this.loadSettings();

		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.addClass('mod-clickable');
		this.statusBarItem.setAttribute('aria-label', 'Click to toggle sync');
		this.statusBarItem.addEventListener('click', () => this.toggleSync());
		this.updateStatusBar('Disconnected', 'disconnected');

		// Auto-connect if WebSocket URL is configured
		if (this.settings.websocketUrl) {
			this.connectWebSocket();
		}

		// File watching for real-time sync
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (this.fileWatchingEnabled && file instanceof TFile && file.extension === 'md') {
					this.debounceFileSync(file);
				}
			})
		);

		// File deletion watching
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					this.handleFileDeleted(file.path);
				}
			})
		);

		// Commands
		this.addCommand({
			id: 'sync-upload-active-file',
			name: 'Sync: Upload active file to cloud',
			checkCallback: (checking: boolean) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && activeFile.extension === 'md') {
					if (!checking) {
						this.uploadActiveFile();
					}
					return true;
				}
				return false;
			}
		});

		this.addCommand({
			id: 'sync-download-active-file',
			name: 'Sync: Download active file from cloud',
			checkCallback: (checking: boolean) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && activeFile.extension === 'md') {
					if (!checking) {
						this.downloadActiveFile();
					}
					return true;
				}
				return false;
			}
		});

		this.addCommand({
			id: 'sync-list-cloud-files',
			name: 'Sync: List files in cloud',
			callback: () => {
				this.listCloudFiles();
			}
		});

		this.addCommand({
			id: 'sync-connect-websocket',
			name: 'Sync: Connect to real-time sync',
			callback: () => {
				this.connectWebSocket();
			}
		});

		this.addCommand({
			id: 'sync-disconnect-websocket',
			name: 'Sync: Disconnect from real-time sync',
			callback: () => {
				this.disconnectWebSocket();
			}
		});

		this.addCommand({
			id: 'sync-toggle-file-watching',
			name: 'Sync: Toggle automatic file watching',
			callback: () => {
				this.toggleFileWatching();
			}
		});

		this.addCommand({
			id: 'sync-all-files',
			name: 'Sync: Upload all files to cloud',
			callback: () => {
				this.syncAllFiles();
			}
		});

		this.addCommand({
			id: 'download-vault',
			name: 'Sync: Download entire vault from cloud',
			callback: () => {
				this.downloadEntireVault();
			}
		});

		this.addCommand({
			id: 'check-sync-status',
			name: 'Sync: Check which files are out of sync',
			callback: () => {
				this.checkSyncStatus();
			}
		});

		this.addCommand({
			id: 'smart-sync',
			name: 'Sync: Smart sync (upload newer, download missing)',
			callback: () => {
				this.smartSync();
			}
		});

		this.addSettingTab(new SyncSettingTab(this.app, this));
	}

	onunload() {
		this.disconnectWebSocket();
		if (this.statusBarItem) {
			this.statusBarItem.detach();
		}
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	updateStatusBar(status: string, state: 'connected' | 'disconnected' | 'syncing' | 'error' = 'disconnected') {
		const colors = {
			connected: '#22c55e',
			disconnected: '#ef4444', 
			syncing: '#3b82f6',
			error: '#f59e0b'
		};
		
		const icons = {
			connected: '🟢',
			disconnected: '🔴',
			syncing: '🔵',
			error: '🟡'
		};
		
		let statusText = `${icons[state]} Sync: ${status}`;
		
		// Add progress indicator during bulk sync
		if (this.isBulkSyncing && this.syncProgress.total > 0) {
			statusText += ` (${this.syncProgress.current}/${this.syncProgress.total})`;
		}
		
		// Add out-of-sync indicator
		if (state === 'connected' && this.hasOutOfSyncFiles()) {
			statusText += ' ⚠️';
		}
		
		this.statusBarItem.setText(statusText);
		this.statusBarItem.style.setProperty('color', colors[state]);
		this.statusBarItem.style.setProperty('cursor', 'pointer');
	}

	toggleSync() {
		if (!this.validateWebSocketSettings()) {
			// If no WebSocket URL is configured, show notice and open settings
			new Notice('Please configure WebSocket URL in settings first');
			// Open plugin settings tab
			(this.app as any).setting.open();
			(this.app as any).setting.openTabById(this.manifest.id);
			return;
		}

		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			// Currently connected, so disconnect
			this.disconnectWebSocket();
		} else if (this.isConnecting) {
			// Currently connecting, so cancel
			this.disconnectWebSocket();
		} else {
			// Not connected, so connect
			this.connectWebSocket();
		}
	}

	private validateWebSocketSettings(): boolean {
		if (!this.settings.websocketUrl) {
			new Notice('Please configure WebSocket URL in settings');
			return false;
		}
		return true;
	}

	// WebSocket Connection Management
	connectWebSocket() {
		if (!this.validateWebSocketSettings()) return;
		
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			new Notice('Already connected to real-time sync');
			return;
		}

		if (this.isConnecting) {
			new Notice('Already attempting to connect...');
			return;
		}

		this.isConnecting = true;
		this.updateStatusBar('Connecting...', 'syncing');

		try {
			this.ws = new WebSocket(this.settings.websocketUrl);

			this.ws.onopen = () => {
				console.log('WebSocket connected');
				this.isConnecting = false;
				this.reconnectAttempts = 0;
				this.updateStatusBar('Connected', 'connected');
				new Notice('Connected to real-time sync');
				
				// Send ping to test connection
				this.sendWebSocketMessage({ action: 'ping' });
				
				// Check sync status after connecting
				setTimeout(() => {
					if (this.ws && this.ws.readyState === WebSocket.OPEN) {
						this.sendWebSocketMessage({ action: 'list' });
					}
				}, 1000);
			};

			this.ws.onmessage = (event) => {
				try {
					const data: WebSocketMessage = JSON.parse(event.data);
					this.handleWebSocketMessage(data);
				} catch (error) {
					console.error('Failed to parse WebSocket message:', error);
				}
			};

			this.ws.onclose = (event) => {
				console.log('WebSocket closed:', event.code, event.reason);
				this.isConnecting = false;
				this.ws = null;
				this.updateStatusBar('Disconnected', 'disconnected');
				
				// Attempt to reconnect if not manually closed
				if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
					this.scheduleReconnect();
				}
			};

			this.ws.onerror = (error) => {
				console.error('WebSocket error:', error);
				this.isConnecting = false;
				this.updateStatusBar('Connection Error', 'error');
			};

		} catch (error) {
			console.error('Failed to create WebSocket:', error);
			this.isConnecting = false;
			this.updateStatusBar('Connection Failed', 'error');
			new Notice('Failed to connect to real-time sync');
		}
	}

	disconnectWebSocket() {
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}

		if (this.ws) {
			this.ws.close(1000, 'Manual disconnect');
			this.ws = null;
		}
		
		this.updateStatusBar('Disconnected', 'disconnected');
		new Notice('Disconnected from real-time sync');
	}

	private scheduleReconnect() {
		this.reconnectAttempts++;
		const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000); // Exponential backoff, max 30s
		
		console.log(`Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);
		this.updateStatusBar(`Reconnecting in ${Math.ceil(delay/1000)}s...`, 'syncing');

		this.reconnectTimeout = setTimeout(() => {
			this.connectWebSocket();
		}, delay);
	}

	private sendWebSocketMessage(message: WebSocketMessage) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			new Notice('Not connected to real-time sync');
			return false;
		}

		try {
			this.ws.send(JSON.stringify(message));
			return true;
		} catch (error: unknown) {
			console.error('Failed to send WebSocket message:', error);
			new Notice('Failed to send message');
			return false;
		}
	}

	private handleWebSocketMessage(data: WebSocketMessage) {
		console.log('Received WebSocket message:', data);

		switch (data.type) {
			case 'pong':
				console.log('Pong received');
				break;
				
			case 'upload_success':
				new Notice(`File uploaded: ${data.filePath}`);
				break;
				
			case 'download_success':
				if (data.filePath && data.content !== undefined) {
					this.applyFileContent(data.filePath, data.content);
				}
				break;
				
			case 'file_list':
				if (data.files) {
					this.handleFileListResponse(data.files);
				}
				break;
				
			case 'file_changed':
				if (data.filePath && data.action === 'upload') {
					new Notice(`File updated by another client: ${data.filePath}`);
					// Optionally auto-download the updated file
					// this.downloadFile(data.filePath);
				}
				break;
				
			case 'delete_success':
				if (data.filePath) {
					new Notice(`File deleted from cloud: ${data.filePath}`);
					console.log(`File deleted successfully: ${data.filePath}`);
				}
				break;
				
			case 'error':
				new Notice(`Sync error: ${data.message}`);
				console.error('WebSocket error:', data.message);
				break;
				
			default:
				console.log('Unknown message type:', data.type);
		}
	}

	// File Operations via WebSocket
	async uploadActiveFile() {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice('No active file');
			return;
		}

		await this.uploadFile(activeFile);
	}

	async uploadFile(file: TFile) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			new Notice('Not connected to real-time sync');
			return;
		}

		try {
			this.updateStatusBar('Uploading...', 'syncing');
			
			const content = await this.app.vault.read(file);
			
			// Update last modified time to prevent sync loop
			this.lastModifiedTimes.set(file.path, file.stat.mtime);
			
			const success = this.sendWebSocketMessage({
				action: 'upload',
				filePath: file.path,
				content: content
			});

			if (success) {
				console.log(`Uploading file: ${file.path}`);
			}
		} catch (error: any) {
			console.error('Upload error:', error);
			new Notice('Upload failed: ' + error.message);
			this.updateStatusBar('Upload failed', 'error');
		}

		setTimeout(() => {
			if (this.ws && this.ws.readyState === WebSocket.OPEN) {
				this.updateStatusBar('Connected', 'connected');
			}
		}, 2000);
	}

	async downloadActiveFile() {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice('No active file');
			return;
		}

		this.downloadFile(activeFile.path);
	}

	downloadFile(filePath: string) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			new Notice('Not connected to real-time sync');
			return;
		}

		this.updateStatusBar('Downloading...', 'syncing');
		
		const success = this.sendWebSocketMessage({
			action: 'download',
			filePath: filePath
		});

		if (success) {
			console.log(`Downloading file: ${filePath}`);
		}

		setTimeout(() => {
			if (this.ws && this.ws.readyState === WebSocket.OPEN) {
				this.updateStatusBar('Connected', 'connected');
			}
		}, 2000);
	}

	private async applyFileContent(filePath: string, content: string) {
		try {
			// Temporarily disable file watching to prevent sync loop
			this.fileWatchingEnabled = false;
			
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) {
				await this.app.vault.modify(file, content);
				// Update last modified time to prevent sync loop
				this.lastModifiedTimes.set(filePath, file.stat.mtime);
			} else {
				// Create new file if it doesn't exist
				await this.app.vault.create(filePath, content);
			}
			
			new Notice(`Downloaded: ${filePath}`);
		} catch (error) {
			console.error('Failed to apply file content:', error);
			new Notice('Failed to save downloaded file');
		} finally {
			// Re-enable file watching after a short delay
			setTimeout(() => {
				this.fileWatchingEnabled = true;
			}, 1000);
		}
	}

	listCloudFiles() {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			new Notice('Not connected to real-time sync');
			return;
		}

		this.updateStatusBar('Fetching file list...', 'syncing');
		
		const success = this.sendWebSocketMessage({
			action: 'list'
		});

		if (success) {
			console.log('Requesting file list');
		}

		setTimeout(() => {
			if (this.ws && this.ws.readyState === WebSocket.OPEN) {
				this.updateStatusBar('Connected', 'connected');
			}
		}, 2000);
	}

	private handleFileListResponse(files: Record<string, string>) {
		// Store cloud file versions for comparison
		this.cloudFileVersions.clear();
		Object.entries(files).forEach(([path, version]) => {
			this.cloudFileVersions.set(path, version);
		});

		// Determine what operation triggered this file list request
		const statusText = this.statusBarItem.getText();
		
		if (statusText.includes('Smart syncing')) {
			// This is for smart sync operation
			this.processSmartSync(files);
		} else if (this.isBulkSyncing) {
			// This is for bulk download operation
			this.downloadQueue = Object.keys(files);
			this.syncProgress = { current: 0, total: this.downloadQueue.length };
			
			if (this.downloadQueue.length === 0) {
				new Notice('No files found in cloud');
				this.isBulkSyncing = false;
				this.updateStatusBar('Connected', 'connected');
			} else {
				new Notice(`Downloading ${this.downloadQueue.length} files...`);
				this.processDownloadQueue();
			}
		} else {
			// This is for regular file list display or sync status check
			this.displayFileList(files);
			this.checkAndReportSyncStatus(files);
		}

		// Update status bar to show out-of-sync status
		if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.isBulkSyncing) {
			this.updateStatusBar('Connected', 'connected');
		}
	}

	private displayFileList(files: Record<string, string>) {
		const fileList = Object.keys(files);
		
		if (fileList.length === 0) {
			new Notice('No files found in cloud');
		} else {
			const fileListText = fileList.map(path => `${path} (v${files[path]})`).join('\n');
			new Notice(`Cloud files:\n${fileListText}`);
		}
	}

	private checkAndReportSyncStatus(cloudFiles: Record<string, string>) {
		const localFiles = this.app.vault.getMarkdownFiles();
		const outOfSyncFiles: string[] = [];
		const cloudOnlyFiles: string[] = [];
		const localOnlyFiles: string[] = [];

		console.log('=== SYNC STATUS DEBUG ===');
		console.log(`Local files count: ${localFiles.length}`);
		console.log(`Cloud files count: ${Object.keys(cloudFiles).length}`);

		// Check files that exist locally
		localFiles.forEach(file => {
			const cloudVersion = cloudFiles[file.path];
			if (!cloudVersion) {
				localOnlyFiles.push(file.path);
				console.log(`📤 LOCAL ONLY: ${file.path} (modified: ${new Date(file.stat.mtime)})`);
			} else {
				// Check if file has been modified since last sync
				const lastKnownTime = this.lastModifiedTimes.get(file.path);
				if (!lastKnownTime || file.stat.mtime > lastKnownTime) {
					outOfSyncFiles.push(file.path);
					console.log(`📝 OUT OF SYNC: ${file.path}`);
					console.log(`  - File modified: ${new Date(file.stat.mtime)}`);
					console.log(`  - Last known sync: ${lastKnownTime ? new Date(lastKnownTime) : 'Never'}`);
					console.log(`  - Cloud version: ${cloudVersion}`);
				} else {
					console.log(`✅ IN SYNC: ${file.path}`);
				}
			}
		});

		// Check files that exist only in cloud
		Object.keys(cloudFiles).forEach(cloudPath => {
			const localFile = localFiles.find(f => f.path === cloudPath);
			if (!localFile) {
				cloudOnlyFiles.push(cloudPath);
				console.log(`📥 CLOUD ONLY: ${cloudPath} (version: ${cloudFiles[cloudPath]})`);
			}
		});

		console.log('=== SYNC STATUS SUMMARY ===');
		console.log(`Out of sync: ${outOfSyncFiles.length}`);
		console.log(`Local only: ${localOnlyFiles.length}`);
		console.log(`Cloud only: ${cloudOnlyFiles.length}`);

		// Report sync status
		if (outOfSyncFiles.length === 0 && cloudOnlyFiles.length === 0 && localOnlyFiles.length === 0) {
			new Notice('✅ All files are in sync');
		} else {
			let report = '📊 SYNC STATUS REPORT\n';
			
			if (outOfSyncFiles.length > 0) {
				report += `\n📝 MODIFIED LOCALLY (${outOfSyncFiles.length}):\n`;
				outOfSyncFiles.slice(0, 10).forEach(file => {
					report += `   • ${file}\n`;
				});
				if (outOfSyncFiles.length > 10) report += `   ... and ${outOfSyncFiles.length - 10} more\n`;
			}
			
			if (localOnlyFiles.length > 0) {
				report += `\n📤 LOCAL ONLY (${localOnlyFiles.length}):\n`;
				localOnlyFiles.slice(0, 10).forEach(file => {
					report += `   • ${file}\n`;
				});
				if (localOnlyFiles.length > 10) report += `   ... and ${localOnlyFiles.length - 10} more\n`;
			}
			
			if (cloudOnlyFiles.length > 0) {
				report += `\n📥 CLOUD ONLY (${cloudOnlyFiles.length}):\n`;
				cloudOnlyFiles.slice(0, 10).forEach(file => {
					report += `   • ${file}\n`;
				});
				if (cloudOnlyFiles.length > 10) report += `   ... and ${cloudOnlyFiles.length - 10} more\n`;
			}

			report += '\n💡 Use "Smart sync" to sync both directions automatically!';

			new Notice(report);
		}
	}

	// File Watching and Debouncing
	private debounceTimeouts: Map<string, NodeJS.Timeout> = new Map();
	
	private debounceFileSync(file: TFile) {
		// Skip if file was just downloaded (prevent sync loop)
		const lastModified = this.lastModifiedTimes.get(file.path);
		if (lastModified && Math.abs(file.stat.mtime - lastModified) < 1000) {
			return;
		}

		// Clear existing timeout for this file
		const existingTimeout = this.debounceTimeouts.get(file.path);
		if (existingTimeout) {
			clearTimeout(existingTimeout);
		}

		// Set new timeout
		const timeout = setTimeout(() => {
			this.uploadFile(file);
			this.debounceTimeouts.delete(file.path);
		}, 2000); // 2 second debounce

		this.debounceTimeouts.set(file.path, timeout);
	}

	private toggleFileWatching() {
		this.fileWatchingEnabled = !this.fileWatchingEnabled;
		const status = this.fileWatchingEnabled ? 'enabled' : 'disabled';
		new Notice(`Automatic file watching ${status}`);
		console.log(`File watching ${status}`);
	}

	// Bulk Sync Operations
	async syncAllFiles() {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			new Notice('Not connected to real-time sync');
			return;
		}

		if (this.isBulkSyncing) {
			new Notice('Bulk sync already in progress');
			return;
		}

		try {
			this.isBulkSyncing = true;
			const markdownFiles = this.app.vault.getMarkdownFiles();
			
			// Filter out files that don't need syncing
			const filesToSync = markdownFiles.filter(file => {
				// Always sync if we don't have version info, or if file is newer
				const lastKnownTime = this.lastModifiedTimes.get(file.path);
				return !lastKnownTime || file.stat.mtime > lastKnownTime;
			});

			if (filesToSync.length === 0) {
				new Notice('All files are already in sync');
				this.isBulkSyncing = false;
				return;
			}

			this.syncProgress = { current: 0, total: filesToSync.length };
			this.updateStatusBar('Syncing all files', 'syncing');

			new Notice(`Syncing ${filesToSync.length} files...`);

			// Process files in batches to avoid overwhelming the server
			const batchSize = 3;
			for (let i = 0; i < filesToSync.length; i += batchSize) {
				const batch = filesToSync.slice(i, i + batchSize);
				
				// Process batch in parallel
				await Promise.all(batch.map(async (file) => {
					try {
						await this.uploadFile(file);
						this.syncProgress.current++;
						this.updateStatusBar('Syncing all files', 'syncing');
					} catch (error) {
						console.error(`Failed to sync file ${file.path}:`, error);
					}
				}));

				// Small delay between batches
				if (i + batchSize < filesToSync.length) {
					await new Promise(resolve => setTimeout(resolve, 500));
				}
			}

			new Notice(`Successfully synced ${this.syncProgress.current} files`);
			
		} catch (error) {
			console.error('Bulk sync failed:', error);
			new Notice('Bulk sync failed: ' + (error as any).message);
		} finally {
			this.isBulkSyncing = false;
			this.syncProgress = { current: 0, total: 0 };
			if (this.ws && this.ws.readyState === WebSocket.OPEN) {
				this.updateStatusBar('Connected', 'connected');
			}
		}
	}

	async downloadEntireVault() {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			new Notice('Not connected to real-time sync');
			return;
		}

		if (this.isBulkSyncing) {
			new Notice('Bulk operation already in progress');
			return;
		}

		try {
			this.isBulkSyncing = true;
			this.updateStatusBar('Fetching file list', 'syncing');

			// First get the list of all files in the cloud
			const success = this.sendWebSocketMessage({ action: 'list' });
			if (!success) {
				throw new Error('Failed to request file list');
			}

			new Notice('Downloading entire vault from cloud...');
			
			// The file list response will be handled in handleWebSocketMessage
			// and will trigger the actual download process
			
		} catch (error) {
			console.error('Download vault failed:', error);
			new Notice('Download vault failed: ' + (error as any).message);
			this.isBulkSyncing = false;
			this.syncProgress = { current: 0, total: 0 };
			if (this.ws && this.ws.readyState === WebSocket.OPEN) {
				this.updateStatusBar('Connected', 'connected');
			}
		}
	}

	async checkSyncStatus() {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			new Notice('Not connected to real-time sync');
			return;
		}

		try {
			this.updateStatusBar('Checking sync status', 'syncing');
			
			// Request file list to compare with local files
			const success = this.sendWebSocketMessage({ action: 'list' });
			if (!success) {
				throw new Error('Failed to request file list');
			}

			// The comparison will be done in handleWebSocketMessage when we receive the file list
			
		} catch (error) {
			console.error('Check sync status failed:', error);
			new Notice('Check sync status failed: ' + (error as any).message);
			if (this.ws && this.ws.readyState === WebSocket.OPEN) {
				this.updateStatusBar('Connected', 'connected');
			}
		}
	}

	private hasOutOfSyncFiles(): boolean {
		// Check if any local files have been modified since last sync
		const markdownFiles = this.app.vault.getMarkdownFiles();
		return markdownFiles.some(file => {
			const lastKnownTime = this.lastModifiedTimes.get(file.path);
			return !lastKnownTime || file.stat.mtime > lastKnownTime;
		});
	}

	private async processDownloadQueue() {
		if (this.downloadQueue.length === 0) {
			this.isBulkSyncing = false;
			this.syncProgress = { current: 0, total: 0 };
			new Notice('Vault download completed');
			if (this.ws && this.ws.readyState === WebSocket.OPEN) {
				this.updateStatusBar('Connected', 'connected');
			}
			return;
		}

		const batchSize = 3;
		const batch = this.downloadQueue.splice(0, batchSize);
		
		// Process batch in parallel
		await Promise.all(batch.map(async (filePath) => {
			try {
				this.downloadFile(filePath);
				await new Promise(resolve => setTimeout(resolve, 100)); // Small delay
			} catch (error) {
				console.error(`Failed to download file ${filePath}:`, error);
			}
		}));

		// Continue with next batch
		setTimeout(() => this.processDownloadQueue(), 500);
	}

	async smartSync() {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			new Notice('Not connected to real-time sync');
			return;
		}

		if (this.isBulkSyncing) {
			new Notice('Bulk operation already in progress');
			return;
		}

		try {
			this.isBulkSyncing = true;
			this.updateStatusBar('Smart syncing', 'syncing');

			// First get the list of all files in the cloud
			const success = this.sendWebSocketMessage({ action: 'list' });
			if (!success) {
				throw new Error('Failed to request file list');
			}

			new Notice('Starting smart sync (both directions)...');
			
			// The file list response will be handled in handleWebSocketMessage
			// and will trigger the smart sync process
			
		} catch (error) {
			console.error('Smart sync failed:', error);
			new Notice('Smart sync failed: ' + (error as any).message);
			this.isBulkSyncing = false;
			this.syncProgress = { current: 0, total: 0 };
			if (this.ws && this.ws.readyState === WebSocket.OPEN) {
				this.updateStatusBar('Connected', 'connected');
			}
		}
	}

	private async processSmartSync(cloudFiles: Record<string, string>) {
		const localFiles = this.app.vault.getMarkdownFiles();
		const filesToUpload: TFile[] = [];
		const filesToDownload: string[] = [];

		console.log('=== SMART SYNC ANALYSIS ===');

		// Check files that exist locally
		localFiles.forEach(file => {
			const cloudVersion = cloudFiles[file.path];
			if (!cloudVersion) {
				// File doesn't exist in cloud, upload it
				filesToUpload.push(file);
				console.log(`📤 WILL UPLOAD: ${file.path} (not in cloud)`);
			} else {
				// Check if file has been modified since last sync
				const lastKnownTime = this.lastModifiedTimes.get(file.path);
				if (!lastKnownTime || file.stat.mtime > lastKnownTime) {
					// File was modified locally, upload it
					filesToUpload.push(file);
					console.log(`📤 WILL UPLOAD: ${file.path} (modified locally)`);
				}
			}
		});

		// Check files that exist only in cloud - download them
		Object.keys(cloudFiles).forEach(cloudPath => {
			const localFile = localFiles.find(f => f.path === cloudPath);
			if (!localFile) {
				filesToDownload.push(cloudPath);
				console.log(`📥 WILL DOWNLOAD: ${cloudPath} (not local)`);
			}
		});

		const totalOperations = filesToUpload.length + filesToDownload.length;
		if (totalOperations === 0) {
			new Notice('✅ All files are already in sync');
			this.isBulkSyncing = false;
			this.updateStatusBar('Connected', 'connected');
			return;
		}

		this.syncProgress = { current: 0, total: totalOperations };
		console.log(`Smart sync: ${filesToUpload.length} uploads, ${filesToDownload.length} downloads`);

		// Process uploads first (in batches)
		const batchSize = 3;
		for (let i = 0; i < filesToUpload.length; i += batchSize) {
			const batch = filesToUpload.slice(i, i + batchSize);
			
			await Promise.all(batch.map(async (file) => {
				try {
					await this.uploadFile(file);
					this.syncProgress.current++;
					this.updateStatusBar('Smart syncing', 'syncing');
				} catch (error) {
					console.error(`Failed to upload file ${file.path}:`, error);
				}
			}));

			if (i + batchSize < filesToUpload.length) {
				await new Promise(resolve => setTimeout(resolve, 500));
			}
		}

		// Process downloads (in batches)
		for (let i = 0; i < filesToDownload.length; i += batchSize) {
			const batch = filesToDownload.slice(i, i + batchSize);
			
			batch.forEach(filePath => {
				this.downloadFile(filePath);
			});

			if (i + batchSize < filesToDownload.length) {
				await new Promise(resolve => setTimeout(resolve, 500));
			}
		}

		new Notice(`Smart sync completed: ${filesToUpload.length} uploaded, ${filesToDownload.length} downloaded`);
		this.isBulkSyncing = false;
		this.syncProgress = { current: 0, total: 0 };
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.updateStatusBar('Connected', 'connected');
		}
	}

	handleFileDeleted(filePath: string) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			console.log(`File deleted locally but not connected: ${filePath}`);
			return;
		}

		console.log(`File deleted locally, notifying cloud: ${filePath}`);
		
		const success = this.sendWebSocketMessage({
			action: 'delete',
			filePath: filePath
		});

		if (success) {
			console.log(`Deletion request sent for: ${filePath}`);
			// Remove from our tracking
			this.lastModifiedTimes.delete(filePath);
		} else {
			console.error(`Failed to send deletion request for: ${filePath}`);
		}
	}
}

class SyncSettingTab extends PluginSettingTab {
	plugin: ObsidianSyncPlugin;

	constructor(app: App, plugin: ObsidianSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('WebSocket URL')
			.setDesc('The URL of your WebSocket endpoint')
			.addText(text => text
				.setPlaceholder('wss://your-lambda-url.amazonaws.com/')
				.setValue(this.plugin.settings.websocketUrl)
				.onChange(async (value) => {
					this.plugin.settings.websocketUrl = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Username')
			.setDesc('Your username for sync (currently for future use)')
			.addText(text => text
				.setPlaceholder('Enter your username')
				.setValue(this.plugin.settings.username)
				.onChange(async (value) => {
					this.plugin.settings.username = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Password')
			.setDesc('Your password for sync (currently for future use)')
			.addText(text => {
				text.setPlaceholder('Enter your password')
					.setValue(this.plugin.settings.password)
					.onChange(async (value) => {
						this.plugin.settings.password = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
			});

		containerEl.createEl('h3', {text: 'Instructions'});
		
		const instructions = containerEl.createEl('div');
		instructions.innerHTML = `
			<p><strong>Quick Start:</strong></p>
			<ol>
				<li>Enter your WebSocket URL above (get this from your SST deployment output)</li>
				<li><strong>Click the sync status indicator</strong> in the status bar to toggle sync on/off</li>
			</ol>
			
			<p><strong>Status Indicators:</strong></p>
			<ul>
				<li>🟢 <strong>Connected</strong> - Real-time sync active, files sync automatically</li>
				<li>🔴 <strong>Disconnected</strong> - Sync off, click to connect</li>
				<li>🔵 <strong>Syncing</strong> - Processing file operations</li>
				<li>🟡 <strong>Error</strong> - Connection issues, click to retry</li>
			</ul>

			<p><strong>Bulk Operations (Ctrl/Cmd+P):</strong></p>
			<ul>
				<li><strong>Sync: Smart sync (upload newer, download missing)</strong> - ⭐ RECOMMENDED: Bidirectional sync</li>
				<li><strong>Sync: Upload all files to cloud</strong> - Upload only (one direction)</li>
				<li><strong>Sync: Download entire vault from cloud</strong> - Download only (one direction)</li>
				<li><strong>Sync: Check which files are out of sync</strong> - Compare local vs cloud files</li>
			</ul>

			<p><strong>Individual File Commands:</strong></p>
			<ul>
				<li><strong>Sync: Upload active file to cloud</strong> - Manual upload of current file</li>
				<li><strong>Sync: Download active file from cloud</strong> - Manual download of current file</li>
				<li><strong>Sync: List files in cloud</strong> - Show all files available in the cloud</li>
				<li><strong>Sync: Toggle automatic file watching</strong> - Enable/disable auto-sync on file changes</li>
			</ul>
		`;
	}
}
