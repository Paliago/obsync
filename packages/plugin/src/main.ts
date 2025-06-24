import { App, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';

interface SyncSettings {
	username: string;
	password: string;
	apiUrl: string;
	websocketUrl: string;
	autoSyncEnabled: boolean;
	syncAllFileTypes: boolean;
	lastModifiedTimes: Record<string, number>;
}

const DEFAULT_SETTINGS: SyncSettings = {
	username: '',
	password: '',
	apiUrl: '',
	websocketUrl: '',
	autoSyncEnabled: true,
	syncAllFileTypes: true,
	lastModifiedTimes: {}
}

interface WebSocketMessage {
	action: string;
	filePath?: string;
	content?: string;
	version?: string;
	type?: string;
	files?: Record<string, string>;
	message?: string;
	lastModified?: number;
	fileType?: string;
	chunkId?: string;
	chunkIndex?: number;
	totalChunks?: number;
	isChunked?: boolean;
}

interface CloudFile {
	version: string;
	lastModified: number;
	fileType: string;
}

interface ChunkBuffer {
	chunks: Map<number, string>;
	totalChunks: number;
	filePath: string;
	fileType: string;
	lastModified?: number;
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
	
	// Enhanced sync management
	uploadQueue: string[] = [];
	downloadQueue: string[] = [];
	isProcessingQueue: boolean = false;
	cloudFileVersions: Map<string, CloudFile> = new Map();
	localFileVersions: Map<string, number> = new Map();
	isBulkSyncing: boolean = false;
	syncProgress: { current: number; total: number } = { current: 0, total: 0 };
	
	// Auto-sync management
	autoSyncInterval: NodeJS.Timeout | null = null;
	isAutoSyncing: boolean = false;
	excludedExtensions: Set<string> = new Set(['.tmp', '.log', '.cache', '.DS_Store']);
	excludedFolders: Set<string> = new Set(['.obsidian', '.trash', '.git']);
	
	// Chunking support
	private chunkBuffers: Map<string, ChunkBuffer> = new Map();
	private readonly MAX_CHUNK_SIZE = 28000; // ~28KB, leaving some room for JSON overhead
	
	// Debounced settings save
	private saveSettingsTimeout: NodeJS.Timeout | null = null;

	async onload() {
		await this.loadSettings();
		
		// Restore lastModifiedTimes from settings
		this.restoreLastModifiedTimes();

		// Add ribbon icon
		const ribbonIconEl = this.addRibbonIcon('sync', 'Toggle Sync', (evt: MouseEvent) => {
			this.toggleSync();
		});
		ribbonIconEl.addClass('obsync-ribbon-class');

		// Add status bar item
		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar('Disconnected');

		// Add commands
		this.addCommand({
			id: 'toggle-sync',
			name: 'Toggle real-time sync',
			callback: () => {
				this.toggleSync();
			}
		});

		this.addCommand({
			id: 'upload-active-file',
			name: 'Upload active file',
			callback: () => {
				this.uploadActiveFile();
			}
		});

		this.addCommand({
			id: 'download-active-file',
			name: 'Download active file',
			callback: () => {
				this.downloadActiveFile();
			}
		});

		this.addCommand({
			id: 'list-cloud-files',
			name: 'List cloud files',
			callback: () => {
				this.listCloudFiles();
			}
		});

		this.addCommand({
			id: 'sync-all-files',
			name: 'Sync all files',
			callback: () => {
				this.syncAllFiles();
			}
		});

		this.addCommand({
			id: 'download-entire-vault',
			name: 'Download entire vault',
			callback: () => {
				this.downloadEntireVault();
			}
		});

		this.addCommand({
			id: 'check-sync-status',
			name: 'Check sync status',
			callback: () => {
				this.checkSyncStatus();
			}
		});

		this.addCommand({
			id: 'smart-sync',
			name: 'Smart sync',
			callback: () => {
				this.smartSync();
			}
		});

		this.addCommand({
			id: 'toggle-auto-sync',
			name: 'Toggle auto-sync',
			callback: () => {
				this.settings.autoSyncEnabled = !this.settings.autoSyncEnabled;
				this.saveSettings();
				if (this.settings.autoSyncEnabled && this.ws && this.ws.readyState === WebSocket.OPEN) {
					this.startAutoSync();
					new Notice('Auto-sync enabled');
				} else {
					this.stopAutoSync();
					new Notice('Auto-sync disabled');
				}
			}
		});

		// This creates an icon in the left ribbon.
		this.addSettingTab(new SyncSettingTab(this.app, this));

		// Auto-connect if WebSocket URL is configured but don't auto-sync all files
		if (this.settings.websocketUrl) {
			this.connectWebSocket();
		}

		// Register file events for real-time sync
		this.registerEvent(this.app.vault.on('create', (file) => {
			if (file instanceof TFile && this.shouldSyncFile(file) && this.fileWatchingEnabled) {
				console.log(`File created: ${file.path}`);
				this.debounceFileSync(file);
			}
		}));

		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (file instanceof TFile && this.shouldSyncFile(file) && this.fileWatchingEnabled) {
				console.log(`File modified: ${file.path}`);
				this.debounceFileSync(file);
			}
		}));

		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (file instanceof TFile && this.shouldSyncFile(file)) {
				console.log(`File deleted: ${file.path}`);
				this.handleFileDeleted(file.path);
			}
		}));

		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (file instanceof TFile && this.shouldSyncFile(file)) {
				console.log(`File renamed: ${oldPath} -> ${file.path}`);
				// Handle rename as delete old + create new
				this.handleFileDeleted(oldPath);
				this.debounceFileSync(file);
			}
		}));
	}

	onunload() {
		this.disconnectWebSocket();
		this.stopAutoSync();
		if (this.statusBarItem) {
			this.statusBarItem.detach();
		}
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
		}
		
		// Clear debounce timeouts
		this.debounceTimeouts.forEach(timeout => clearTimeout(timeout));
		this.debounceTimeouts.clear();
		
		// Save any pending settings changes
		if (this.saveSettingsTimeout) {
			clearTimeout(this.saveSettingsTimeout);
			this.saveSettings(); // Force save on unload
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		// Save lastModifiedTimes to settings before saving
		this.persistLastModifiedTimes();
		await this.saveData(this.settings);
	}

	private restoreLastModifiedTimes() {
		// Restore from settings
		if (this.settings.lastModifiedTimes) {
			this.lastModifiedTimes = new Map(Object.entries(this.settings.lastModifiedTimes));
			console.log(`Restored sync tracking for ${this.lastModifiedTimes.size} files`);
		}
	}

	private persistLastModifiedTimes() {
		// Convert Map to Object for JSON serialization
		this.settings.lastModifiedTimes = Object.fromEntries(this.lastModifiedTimes);
	}

	private debouncedSaveSettings() {
		// Clear existing timeout
		if (this.saveSettingsTimeout) {
			clearTimeout(this.saveSettingsTimeout);
		}
		
		// Set new timeout to save settings after 2 seconds of inactivity
		this.saveSettingsTimeout = setTimeout(() => {
			this.saveSettings();
			this.saveSettingsTimeout = null;
		}, 2000);
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
		
		let statusText = `${icons[state]} ${status}`;
		
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
				
				// Start auto-sync if enabled (but don't trigger immediate sync)
				if (this.settings.autoSyncEnabled) {
					this.startAutoSync();
				}
				
				// Check sync status after connecting (for display only)
				setTimeout(() => {
					if (this.ws && this.ws.readyState === WebSocket.OPEN) {
						// Use a flag to indicate this is for status check only, not auto-sync
						this.isAutoSyncing = false;
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
			
			// Handle specific error codes
			if (event.code === 1009) {
				new Notice('Large file detected - implementing chunking for better sync');
				console.log('WebSocket closed due to message size limit - chunking should handle this');
			}
			
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

		// Stop auto-sync
		this.stopAutoSync();

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
			const messageStr = JSON.stringify(message);
			const messageSizeKB = new Blob([messageStr]).size;
			
			// If message is larger than ~28KB, chunk it
			if (messageSizeKB > this.MAX_CHUNK_SIZE) {
				return this.sendChunkedMessage(message);
			}
			
			this.ws.send(messageStr);
			return true;
		} catch (error: unknown) {
			console.error('Failed to send WebSocket message:', error);
			new Notice('Failed to send message');
			return false;
		}
	}

	private sendChunkedMessage(message: WebSocketMessage): boolean {
		try {
			if (!message.filePath || !message.content) {
				console.error('Cannot chunk message without filePath and content');
				return false;
			}

			const chunkId = `${message.filePath}-${Date.now()}`;
			const content = message.content;
			const chunks: string[] = [];
			
			// Split content into chunks
			for (let i = 0; i < content.length; i += this.MAX_CHUNK_SIZE) {
				chunks.push(content.slice(i, i + this.MAX_CHUNK_SIZE));
			}

			console.log(`Chunking large file ${message.filePath} into ${chunks.length} chunks (${Math.round(new Blob([content]).size / 1024)}KB)`);

			// Send each chunk
			for (let i = 0; i < chunks.length; i++) {
				const chunkMessage: WebSocketMessage = {
					action: message.action,
					filePath: message.filePath,
					content: chunks[i],
					fileType: message.fileType,
					lastModified: message.lastModified,
					isChunked: true,
					chunkId: chunkId,
					chunkIndex: i,
					totalChunks: chunks.length
				};

				const chunkStr = JSON.stringify(chunkMessage);
				this.ws!.send(chunkStr);

				// Add small delay between chunks to avoid overwhelming the server
				if (i < chunks.length - 1) {
					setTimeout(() => {}, 50);
				}
			}

			console.log(`Successfully sent ${chunks.length} chunks for ${message.filePath}`);
			return true;
		} catch (error) {
			console.error('Failed to send chunked message:', error);
			return false;
		}
	}

	private handleWebSocketMessage(data: WebSocketMessage) {
		console.log('Received WebSocket message:', data);

		// Handle chunked messages
		if (data.isChunked && data.chunkId && data.chunkIndex !== undefined && data.totalChunks) {
			return this.handleChunkedMessage(data);
		}

		switch (data.type) {
			case 'pong':
				console.log('Pong received');
				break;
				
			case 'upload_success':
				console.log(`File uploaded: ${data.filePath}`);
				// Update local tracking to prevent re-upload
				if (data.filePath && data.lastModified) {
					this.lastModifiedTimes.set(data.filePath, data.lastModified);
					this.debouncedSaveSettings(); // Persist the tracking
				}
				break;
				
			case 'download_success':
				if (data.filePath && data.content !== undefined) {
					this.applyFileContent(data.filePath, data.content, data.fileType || 'text');
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

	private handleChunkedMessage(data: WebSocketMessage): void {
		if (!data.chunkId || data.chunkIndex === undefined || !data.totalChunks || !data.filePath) {
			console.error('Invalid chunked message:', data);
			return;
		}

		const bufferId = data.chunkId;
		
		// Initialize chunk buffer if needed
		if (!this.chunkBuffers.has(bufferId)) {
			this.chunkBuffers.set(bufferId, {
				chunks: new Map(),
				totalChunks: data.totalChunks,
				filePath: data.filePath,
				fileType: data.fileType || 'text',
				lastModified: data.lastModified
			});
		}

		const buffer = this.chunkBuffers.get(bufferId)!;
		
		// Store chunk
		if (data.content) {
			buffer.chunks.set(data.chunkIndex, data.content);
		}

		console.log(`Received chunk ${data.chunkIndex + 1}/${data.totalChunks} for ${data.filePath}`);

		// Check if all chunks received
		if (buffer.chunks.size === buffer.totalChunks) {
			// Reassemble content
			let fullContent = '';
			for (let i = 0; i < buffer.totalChunks; i++) {
				const chunk = buffer.chunks.get(i);
				if (chunk === undefined) {
					console.error(`Missing chunk ${i} for ${data.filePath}`);
					this.chunkBuffers.delete(bufferId);
					return;
				}
				fullContent += chunk;
			}

			console.log(`Successfully reassembled ${data.filePath} from ${buffer.totalChunks} chunks (${Math.round(new Blob([fullContent]).size / 1024)}KB)`);

			// Clean up buffer
			this.chunkBuffers.delete(bufferId);

			// Handle the complete message
			const completeMessage: WebSocketMessage = {
				...data,
				content: fullContent,
				isChunked: false
			};

			// Process the complete message based on its type/action
			if (data.type === 'download_success') {
				this.applyFileContent(buffer.filePath, fullContent, buffer.fileType);
			} else if (data.type === 'upload_success') {
				console.log(`Large file uploaded: ${buffer.filePath}`);
				// Update local tracking to prevent re-upload
				if (buffer.lastModified) {
					this.lastModifiedTimes.set(buffer.filePath, buffer.lastModified);
					this.debouncedSaveSettings(); // Persist the tracking
				}
			}
		}
	}

	// File Operations via WebSocket
	async uploadActiveFile() {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice('No active file');
			return;
		}

		await this.uploadFile(activeFile.path);
	}

	async uploadFile(filePath: string) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			new Notice('Not connected to real-time sync');
			return;
		}

		try {
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (!file || !(file instanceof TFile)) {
				console.error(`File not found: ${filePath}`);
				return;
			}

			const content = await this.app.vault.read(file);
			const lastModified = file.stat.mtime;
			const fileType = this.getFileType(filePath);
			
			// Encode binary files as base64
			let fileContent = content;
			if (fileType === 'binary') {
				const arrayBuffer = await this.app.vault.readBinary(file);
				fileContent = this.arrayBufferToBase64(arrayBuffer);
			}

			// Check file size and notify user if it's large
			const fileSizeKB = Math.round(new Blob([fileContent]).size / 1024);
			if (fileSizeKB > 32) {
				new Notice(`Syncing large file: ${filePath} (${fileSizeKB}KB) - this may take a moment`);
				console.log(`Large file detected: ${filePath} (${fileSizeKB}KB) - will be chunked`);
			}

			console.log(`Uploading file: ${filePath} (type: ${fileType})`);
			
			const success = this.sendWebSocketMessage({
				action: 'upload',
				filePath: filePath,
				content: fileContent,
				lastModified: lastModified,
				fileType: fileType
			});

			// Note: lastModifiedTimes will be updated when we receive upload_success response
		} catch (error) {
			console.error(`Error uploading file ${filePath}:`, error);
			new Notice(`Failed to upload ${filePath}`);
		}
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

	private async applyFileContent(filePath: string, content: string, fileType: string = 'text') {
		try {
			// Temporarily disable file watching to prevent sync loop
			this.fileWatchingEnabled = false;
			
			// Create folder if it doesn't exist
			await this.createFolderIfNotExists(filePath);
			
			const file = this.app.vault.getAbstractFileByPath(filePath);
			
			if (file instanceof TFile) {
				// File exists, update it
				if (fileType === 'text') {
					await this.app.vault.modify(file, content);
				} else {
					// For binary files, decode base64 and write binary
					const binaryData = Uint8Array.from(atob(content), c => c.charCodeAt(0));
					await this.app.vault.modifyBinary(file, binaryData.buffer);
				}
				// Update last modified time to prevent sync loop
				this.lastModifiedTimes.set(filePath, file.stat.mtime);
				this.debouncedSaveSettings(); // Persist the tracking
			} else {
				// Create new file
				if (fileType === 'text') {
					await this.app.vault.create(filePath, content);
				} else {
					// For binary files, decode base64 and create binary file
					const binaryData = Uint8Array.from(atob(content), c => c.charCodeAt(0));
					await this.app.vault.createBinary(filePath, binaryData.buffer);
				}
				
				// Get the created file to update tracking
				const newFile = this.app.vault.getAbstractFileByPath(filePath);
				if (newFile instanceof TFile) {
					this.lastModifiedTimes.set(filePath, newFile.stat.mtime);
					this.debouncedSaveSettings(); // Persist the tracking
				}
			}
			
			new Notice(`Downloaded: ${filePath}`);
		} catch (error) {
			console.error('Failed to apply file content:', error);
			new Notice('Failed to save downloaded file: ' + (error as any).message);
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

	private handleFileListResponse(files: Record<string, any>) {
		// Store cloud file versions for comparison
		this.cloudFileVersions.clear();
		Object.entries(files).forEach(([path, fileInfo]) => {
			if (typeof fileInfo === 'string') {
				// Legacy format - just version string
				this.cloudFileVersions.set(path, { 
					version: fileInfo, 
					lastModified: 0, 
					fileType: 'text'
				});
			} else {
				// New format - object with metadata
				this.cloudFileVersions.set(path, {
					version: fileInfo.version,
					lastModified: fileInfo.clientLastModified || fileInfo.lastModified || 0,
					fileType: fileInfo.fileType || 'text'
				});
			}
		});

		// Determine what operation triggered this file list request
		const statusText = this.statusBarItem.getText();
		
		if (this.isAutoSyncing) {
			// This is for auto-sync operation
			this.performSmartAutoSync(files);
		} else if (statusText.includes('Smart syncing')) {
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

	private displayFileList(files: Record<string, any>) {
		const fileList = Object.keys(files);
		
		// Just log to console instead of showing notifications
		console.log(`Cloud files (${fileList.length}):`, fileList);
		
		if (fileList.length === 0) {
			console.log('No files found in cloud');
		} else {
			fileList.forEach(path => {
				const fileInfo = files[path];
				if (typeof fileInfo === 'string') {
					console.log(`  ${path} (v${fileInfo})`);
				} else {
					console.log(`  ${path} (v${fileInfo.version}, ${fileInfo.fileType})`);
				}
			});
		}
	}

	private checkAndReportSyncStatus(cloudFiles: Record<string, any>) {
		const localFiles = this.getAllLocalFiles().filter(file => this.shouldSyncFile(file));
		const outOfSyncFiles: string[] = [];
		const cloudOnlyFiles: string[] = [];
		const localOnlyFiles: string[] = [];

		console.log('=== SYNC STATUS DEBUG ===');
		console.log(`Local files count: ${localFiles.length}`);
		console.log(`Cloud files count: ${Object.keys(cloudFiles).length}`);

		// Check files that exist locally
		localFiles.forEach(file => {
			const cloudFileInfo = cloudFiles[file.path];
			if (!cloudFileInfo) {
				localOnlyFiles.push(file.path);
				console.log(`📤 LOCAL ONLY: ${file.path} (modified: ${new Date(file.stat.mtime)})`);
			} else {
				// Extract cloud version info (handle both old and new formats)
				const cloudVersion = typeof cloudFileInfo === 'string' ? cloudFileInfo : cloudFileInfo.version;
				const cloudLastModified = typeof cloudFileInfo === 'string' ? 0 : (cloudFileInfo.clientLastModified || cloudFileInfo.lastModified || 0);
				
				// Check if file has been modified since last sync or is newer than cloud version
				const lastKnownTime = this.lastModifiedTimes.get(file.path);
				const fileNeedsSync = !lastKnownTime || file.stat.mtime > lastKnownTime;
				const localIsNewer = file.stat.mtime > cloudLastModified;
				
				if (fileNeedsSync || localIsNewer) {
					outOfSyncFiles.push(file.path);
					console.log(`📝 OUT OF SYNC: ${file.path}`);
					console.log(`  - File modified: ${new Date(file.stat.mtime)}`);
					console.log(`  - Last known sync: ${lastKnownTime ? new Date(lastKnownTime) : 'Never'}`);
					console.log(`  - Cloud version: ${cloudVersion}, modified: ${new Date(cloudLastModified)}`);
					console.log(`  - Local is newer: ${localIsNewer}`);
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

		// Log sync status to console instead of showing notifications
		if (outOfSyncFiles.length === 0 && cloudOnlyFiles.length === 0 && localOnlyFiles.length === 0) {
			console.log('✅ All files are in sync');
		} else {
			console.log('📊 SYNC STATUS REPORT');
			
			if (outOfSyncFiles.length > 0) {
				console.log(`📝 MODIFIED LOCALLY (${outOfSyncFiles.length}):`);
				outOfSyncFiles.slice(0, 10).forEach(file => {
					console.log(`   • ${file}`);
				});
				if (outOfSyncFiles.length > 10) console.log(`   ... and ${outOfSyncFiles.length - 10} more`);
			}
			
			if (localOnlyFiles.length > 0) {
				console.log(`📤 LOCAL ONLY (${localOnlyFiles.length}):`);
				localOnlyFiles.slice(0, 10).forEach(file => {
					console.log(`   • ${file}`);
				});
				if (localOnlyFiles.length > 10) console.log(`   ... and ${localOnlyFiles.length - 10} more`);
			}
			
			if (cloudOnlyFiles.length > 0) {
				console.log(`📥 CLOUD ONLY (${cloudOnlyFiles.length}):`);
				cloudOnlyFiles.slice(0, 10).forEach(file => {
					console.log(`   • ${file}`);
				});
				if (cloudOnlyFiles.length > 10) console.log(`   ... and ${cloudOnlyFiles.length - 10} more`);
			}

			console.log('💡 Use "Smart sync" to sync both directions automatically!');
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
			this.uploadFile(file.path);
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
						await this.uploadFile(file.path);
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

	private async processSmartSync(cloudFiles: Record<string, any>) {
		const localFiles = this.getAllLocalFiles().filter(file => this.shouldSyncFile(file));
		const filesToUpload: TFile[] = [];
		const filesToDownload: string[] = [];

		console.log('=== SMART SYNC ANALYSIS ===');

		// Check files that exist locally
		localFiles.forEach(file => {
			const cloudFileInfo = cloudFiles[file.path];
			if (!cloudFileInfo) {
				// File doesn't exist in cloud, upload it
				filesToUpload.push(file);
				console.log(`📤 WILL UPLOAD: ${file.path} (not in cloud)`);
			} else {
				// Extract cloud timestamp info
				const cloudLastModified = typeof cloudFileInfo === 'string' ? 0 : (cloudFileInfo.clientLastModified || cloudFileInfo.lastModified || 0);
				
				// Check if file has been modified since last sync or is newer than cloud version
				const lastKnownTime = this.lastModifiedTimes.get(file.path);
				const fileNeedsSync = !lastKnownTime || file.stat.mtime > lastKnownTime;
				const localIsNewer = file.stat.mtime > cloudLastModified;
				
				if (fileNeedsSync || localIsNewer) {
					// File was modified locally or is newer than cloud, upload it
					filesToUpload.push(file);
					console.log(`📤 WILL UPLOAD: ${file.path} (local: ${new Date(file.stat.mtime)}, cloud: ${new Date(cloudLastModified)})`);
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
					await this.uploadFile(file.path);
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

	private shouldSyncFile(file: TFile): boolean {
		// Skip excluded extensions
		const ext = file.extension.toLowerCase();
		if (this.excludedExtensions.has(`.${ext}`)) {
			return false;
		}

		// If sync all file types is disabled, only sync markdown files
		if (!this.settings.syncAllFileTypes && ext !== 'md') {
			return false;
		}

		// Skip files in .obsidian folder and other system folders
		if (file.path.startsWith('.obsidian/') || 
			file.path.startsWith('.trash/') || 
			file.path.startsWith('.git/')) {
			return false;
		}

		return true;
	}

	private arrayBufferToBase64(buffer: ArrayBuffer): string {
		const bytes = new Uint8Array(buffer);
		let binary = '';
		for (let i = 0; i < bytes.length; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return btoa(binary);
	}

	private getFileType(file: TFile | string): string {
		const ext = typeof file === 'string' 
			? file.split('.').pop()?.toLowerCase() || ''
			: file.extension.toLowerCase();
		if (['md', 'txt', 'json', 'yaml', 'yml', 'xml', 'html', 'css', 'js', 'ts', 'py', 'java', 'cpp', 'c', 'h'].includes(ext)) {
			return 'text';
		}
		return 'binary';
	}

	private async createFolderIfNotExists(filePath: string): Promise<void> {
		const folderPath = filePath.substring(0, filePath.lastIndexOf('/'));
		if (folderPath && !this.app.vault.getAbstractFileByPath(folderPath)) {
			try {
				await this.app.vault.createFolder(folderPath);
				console.log(`Created folder: ${folderPath}`);
			} catch (error) {
				console.error(`Failed to create folder ${folderPath}:`, error);
			}
		}
	}

	startAutoSync() {
		if (this.autoSyncInterval || !this.settings.autoSyncEnabled) {
			return;
		}

		// Start auto sync every 30 seconds
		this.autoSyncInterval = setInterval(() => {
			if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.isAutoSyncing && !this.isBulkSyncing) {
				this.performAutoSync();
			}
		}, 30000);

		console.log('Auto-sync started');
	}

	stopAutoSync() {
		if (this.autoSyncInterval) {
			clearInterval(this.autoSyncInterval);
			this.autoSyncInterval = null;
			console.log('Auto-sync stopped');
		}
	}

	private async performAutoSync() {
		if (this.isAutoSyncing || this.isBulkSyncing) {
			return;
		}

		try {
			this.isAutoSyncing = true;
			console.log('Performing auto-sync check...');

			// Request file list to compare with local files
			const success = this.sendWebSocketMessage({ action: 'list' });
			if (success) {
				// The file list response will trigger automatic sync in handleFileListResponse
			}
		} catch (error) {
			console.error('Auto-sync failed:', error);
		} finally {
			setTimeout(() => {
				this.isAutoSyncing = false;
			}, 5000); // Prevent rapid auto-sync
		}
	}

	private async performSmartAutoSync(cloudFiles: Record<string, any>) {
		if (!this.isAutoSyncing) {
			return;
		}

		console.log('Performing smart auto-sync...');

		const localFiles = this.getAllLocalFiles();
		const filesToUpload: TFile[] = [];
		const filesToDownload: string[] = [];

		// Check files that exist locally
		localFiles.forEach(file => {
			if (!this.shouldSyncFile(file)) {
				return;
			}

			const cloudFileInfo = cloudFiles[file.path];
			if (!cloudFileInfo) {
				// File doesn't exist in cloud, upload it
				filesToUpload.push(file);
				console.log(`Auto-sync: Will upload ${file.path} (not in cloud)`);
			} else {
				// Extract cloud timestamp info
				const cloudLastModified = typeof cloudFileInfo === 'string' ? 0 : (cloudFileInfo.clientLastModified || cloudFileInfo.lastModified || 0);
				
				// Check if file has been modified since last sync or is newer than cloud version
				const lastKnownTime = this.lastModifiedTimes.get(file.path);
				const fileNeedsSync = !lastKnownTime || file.stat.mtime > lastKnownTime;
				const localIsNewer = file.stat.mtime > cloudLastModified;
				
				if (fileNeedsSync || localIsNewer) {
					// File was modified locally or is newer than cloud, upload it
					filesToUpload.push(file);
					console.log(`Auto-sync: Will upload ${file.path} (local: ${new Date(file.stat.mtime)}, cloud: ${new Date(cloudLastModified)})`);
				}
			}
		});

		// Check files that exist only in cloud - download them
		Object.keys(cloudFiles).forEach(cloudPath => {
			const localFile = localFiles.find(f => f.path === cloudPath);
			if (!localFile) {
				filesToDownload.push(cloudPath);
				console.log(`Auto-sync: Will download ${cloudPath} (not local)`);
			}
		});

		// Perform uploads (limited batch size for auto-sync)
		const maxAutoSyncFiles = 5;
		for (let i = 0; i < Math.min(filesToUpload.length, maxAutoSyncFiles); i++) {
			const file = filesToUpload[i];
			try {
				await this.uploadFile(file.path);
				await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting
			} catch (error) {
				console.error(`Auto-sync upload failed for ${file.path}:`, error);
			}
		}

		// Perform downloads (limited batch size for auto-sync)
		for (let i = 0; i < Math.min(filesToDownload.length, maxAutoSyncFiles); i++) {
			const filePath = filesToDownload[i];
			try {
				this.downloadFile(filePath);
				await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting
			} catch (error) {
				console.error(`Auto-sync download failed for ${filePath}:`, error);
			}
		}

		if (filesToUpload.length > maxAutoSyncFiles || filesToDownload.length > maxAutoSyncFiles) {
			new Notice(`Auto-sync: Processed ${maxAutoSyncFiles} files. Use Smart Sync command for full sync.`);
		} else if (filesToUpload.length > 0 || filesToDownload.length > 0) {
			new Notice(`Auto-sync: ${filesToUpload.length} uploaded, ${filesToDownload.length} downloaded`);
		}
	}

	private getAllLocalFiles(): TFile[] {
		return this.app.vault.getFiles().filter(file => file instanceof TFile) as TFile[];
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

		containerEl.createEl('h3', {text: 'Sync Settings'});

		new Setting(containerEl)
			.setName('Enable Auto-Sync')
			.setDesc('Automatically sync files when connected (checks every 30 seconds)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSyncEnabled)
				.onChange(async (value) => {
					this.plugin.settings.autoSyncEnabled = value;
					await this.plugin.saveSettings();
					
					// Start/stop auto-sync based on setting
					if (value && this.plugin.ws && this.plugin.ws.readyState === WebSocket.OPEN) {
						this.plugin.startAutoSync();
					} else {
						this.plugin.stopAutoSync();
					}
				}));

		new Setting(containerEl)
			.setName('Sync All File Types')
			.setDesc('Sync all file types (images, PDFs, etc.), not just markdown files')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncAllFileTypes)
				.onChange(async (value) => {
					this.plugin.settings.syncAllFileTypes = value;
					await this.plugin.saveSettings();
				}));

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

			<p><strong>🔄 Auto-Sync:</strong></p>
			<ul>
				<li>When enabled, automatically syncs files every 30 seconds</li>
				<li>Handles missing files in both directions (upload local-only, download cloud-only)</li>
				<li>Compares timestamps to determine which version is newer</li>
				<li>Supports all file types (markdown, images, PDFs, etc.)</li>
				<li>Automatically creates folders when downloading files</li>
			</ul>

			<p><strong>Bulk Operations (Ctrl/Cmd+P):</strong></p>
			<ul>
				<li><strong>Sync: Smart sync (upload newer, download missing)</strong> - ⭐ RECOMMENDED: Full bidirectional sync</li>
				<li><strong>Sync: Toggle auto-sync</strong> - Enable/disable automatic syncing</li>
				<li><strong>Sync: Upload all files to cloud</strong> - Upload only (one direction)</li>
				<li><strong>Sync: Download entire vault from cloud</strong> - Download only (one direction)</li>
				<li><strong>Sync: Check which files are out of sync</strong> - Compare local vs cloud files</li>
			</ul>

			<p><strong>Individual File Commands:</strong></p>
			<ul>
				<li><strong>Sync: Upload active file to cloud</strong> - Manual upload of current file</li>
				<li><strong>Sync: Download active file from cloud</strong> - Manual download of current file</li>
				<li><strong>Sync: List files in cloud</strong> - Show all files available in the cloud</li>
				<li><strong>Sync: Toggle automatic file watching</strong> - Enable/disable real-time sync on file changes</li>
			</ul>
		`;
	}
}
