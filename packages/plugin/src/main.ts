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

	async onload() {
		await this.loadSettings();

		this.statusBarItem = this.addStatusBarItem();
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
		
		this.statusBarItem.setText(`🔄 ${status}`);
		this.statusBarItem.style.setProperty('color', colors[state]);
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
					this.displayFileList(data.files);
				}
				break;
				
			case 'file_changed':
				if (data.filePath && data.action === 'upload') {
					new Notice(`File updated by another client: ${data.filePath}`);
					// Optionally auto-download the updated file
					// this.downloadFile(data.filePath);
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

	private displayFileList(files: Record<string, string>) {
		const fileList = Object.keys(files);
		
		if (fileList.length === 0) {
			new Notice('No files found in cloud');
		} else {
			const fileListText = fileList.map(path => `${path} (v${files[path]})`).join('\n');
			new Notice(`Cloud files:\n${fileListText}`);
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
			<p>1. Enter your WebSocket URL above (get this from your SST deployment output)</p>
			<p>2. Use the Command Palette (Ctrl/Cmd+P) to access sync commands:</p>
			<ul>
				<li><strong>Sync: Upload active file to cloud</strong> - Upload the currently open file</li>
				<li><strong>Sync: Download active file from cloud</strong> - Download and replace the currently open file</li>
				<li><strong>Sync: List files in cloud</strong> - Show all files available in the cloud</li>
				<li><strong>Sync: Connect to real-time sync</strong> - Connect to the real-time sync service</li>
				<li><strong>Sync: Disconnect from real-time sync</strong> - Disconnect from the real-time sync service</li>
				<li><strong>Sync: Toggle automatic file watching</strong> - Toggle automatic file watching</li>
			</ul>
			<p>3. The status bar at the bottom shows the current sync status</p>
		`;
	}
}
