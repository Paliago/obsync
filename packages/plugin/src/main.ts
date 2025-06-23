import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';

interface SyncSettings {
	username: string;
	password: string;
	apiUrl: string;
}

const DEFAULT_SETTINGS: SyncSettings = {
	username: '',
	password: '',
	apiUrl: ''
}

export default class ObsidianSyncPlugin extends Plugin {
	settings: SyncSettings;
	statusBarItem: HTMLElement;

	async onload() {
		await this.loadSettings();

		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar('Disconnected');

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

		this.addSettingTab(new SyncSettingTab(this.app, this));
	}

	onunload() {
		this.statusBarItem?.remove();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	updateStatusBar(status: string) {
		this.statusBarItem.setText(`Sync: ${status}`);
	}

	private validateSettings(): boolean {
		if (!this.settings.apiUrl) {
			new Notice('Please configure API URL in settings');
			return false;
		}
		return true;
	}

	async uploadActiveFile() {
		if (!this.validateSettings()) return;

		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice('No active file');
			return;
		}

		try {
			this.updateStatusBar('Uploading...');
			
			const content = await this.app.vault.read(activeFile);
			
			const response = await fetch(this.settings.apiUrl, {
				method: 'PUT',
				headers: {
					'Content-Type': 'text/markdown',
				},
				body: JSON.stringify({
					filePath: activeFile.path,
					content: content
				})
			});

			if (response.ok) {
				new Notice(`Successfully uploaded: ${activeFile.name}`);
				this.updateStatusBar('Upload complete');
			} else {
				throw new Error(`Upload failed: ${response.status}`);
			}
		} catch (error) {
			console.error('Upload error:', error);
			new Notice('Upload failed: ' + error.message);
			this.updateStatusBar('Upload failed');
		}

		setTimeout(() => this.updateStatusBar('Connected'), 3000);
	}

	async downloadActiveFile() {
		if (!this.validateSettings()) return;

		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice('No active file');
			return;
		}

		try {
			this.updateStatusBar('Downloading...');
			
			const apiUrl = this.settings.apiUrl.endsWith('/') ? this.settings.apiUrl.slice(0, -1) : this.settings.apiUrl;
			const response = await fetch(`${apiUrl}/${activeFile.path}`);

			if (response.ok) {
				const content = await response.text();
				await this.app.vault.modify(activeFile, content);
				new Notice(`Successfully downloaded: ${activeFile.name}`);
				this.updateStatusBar('Download complete');
			} else if (response.status === 404) {
				new Notice('File not found in cloud');
				this.updateStatusBar('File not found');
			} else {
				throw new Error(`Download failed: ${response.status}`);
			}
		} catch (error) {
			console.error('Download error:', error);
			new Notice('Download failed: ' + error.message);
			this.updateStatusBar('Download failed');
		}

		setTimeout(() => this.updateStatusBar('Connected'), 3000);
	}

	async listCloudFiles() {
		if (!this.validateSettings()) return;

		try {
			this.updateStatusBar('Fetching file list...');
			
			const apiUrl = this.settings.apiUrl.endsWith('/') ? this.settings.apiUrl.slice(0, -1) : this.settings.apiUrl;
			const response = await fetch(`${apiUrl}/versions`);

			if (response.ok) {
				const files = await response.json();
				const fileList = Object.keys(files);
				
				if (fileList.length === 0) {
					new Notice('No files found in cloud');
				} else {
					const fileListText = fileList.map(path => `${path} (v${files[path]})`).join('\n');
					new Notice(`Cloud files:\n${fileListText}`);
				}
				this.updateStatusBar('File list retrieved');
			} else {
				throw new Error(`Failed to fetch file list: ${response.status}`);
			}
		} catch (error) {
			console.error('List files error:', error);
			new Notice('Failed to fetch file list: ' + error.message);
			this.updateStatusBar('List failed');
		}

		setTimeout(() => this.updateStatusBar('Connected'), 3000);
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
			.setName('API URL')
			.setDesc('The URL of your sync API endpoint')
			.addText(text => text
				.setPlaceholder('https://your-lambda-url.amazonaws.com/')
				.setValue(this.plugin.settings.apiUrl)
				.onChange(async (value) => {
					this.plugin.settings.apiUrl = value.trim();
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
			<p>1. Enter your API URL above (get this from your SST deployment output)</p>
			<p>2. Use the Command Palette (Ctrl/Cmd+P) to access sync commands:</p>
			<ul>
				<li><strong>Sync: Upload active file to cloud</strong> - Upload the currently open file</li>
				<li><strong>Sync: Download active file from cloud</strong> - Download and replace the currently open file</li>
				<li><strong>Sync: List files in cloud</strong> - Show all files available in the cloud</li>
			</ul>
			<p>3. The status bar at the bottom shows the current sync status</p>
		`;
	}
}
