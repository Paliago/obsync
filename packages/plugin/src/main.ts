import {
  type App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";

interface SyncSettings {
  username: string;
  password: string;
  apiKey: string;
  apiUrl: string;
  websocketUrl: string;
  autoSyncEnabled: boolean;
  syncAllFileTypes: boolean;
  lastModifiedTimes: Record<string, number>;
  debounceDelay: number;
  autoSyncInterval: number;
  instantSyncMode: boolean;
  // File filtering
  useWhitelist: boolean;
  extensionWhitelist: string[];
  extensionBlacklist: string[];
  excludedFolders: string[];
  // Performance settings
  chunkSizeKB: number;
  batchSize: number;
  maxRetryAttempts: number;
  operationTimeoutMs: number;
  maxFileSizeMB: number;
  fileSizeWarningMB: number;
  // Debug settings
  enableDebugLogging: boolean;
  showPerformanceMetrics: boolean;
}

const DEFAULT_SETTINGS: SyncSettings = {
  username: "",
  password: "",
  apiKey: "",
  apiUrl: "",
  websocketUrl: "",
  autoSyncEnabled: true,
  syncAllFileTypes: true,
  lastModifiedTimes: {},
  debounceDelay: 2000,
  autoSyncInterval: 30000,
  instantSyncMode: false,
  // File filtering
  useWhitelist: false,
  extensionWhitelist: ["md", "txt", "pdf", "png", "jpg", "jpeg"],
  extensionBlacklist: ["tmp", "log", "cache", "DS_Store"],
  excludedFolders: [".obsidian", ".trash", ".git"],
  // Performance settings
  chunkSizeKB: 28,
  batchSize: 3,
  maxRetryAttempts: 5,
  operationTimeoutMs: 10000,
  maxFileSizeMB: 100,
  fileSizeWarningMB: 5,
  // Debug settings
  enableDebugLogging: false,
  showPerformanceMetrics: false,
};

interface WebSocketMessage {
  action: string;
  apiKey?: string;
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

interface ConflictFile {
  filePath: string;
  localModified: number;
  cloudModified: number;
  localContent?: string;
  cloudContent?: string;
}

interface ConflictResolution {
  filePath: string;
  choice: "local" | "cloud";
}

export default class ObsidianSyncPlugin extends Plugin {
  settings!: SyncSettings;
  statusBarItem!: HTMLElement;
  ws: WebSocket | null = null;
  isConnecting = false;
  reconnectAttempts = 0;
  get maxReconnectAttempts() {
    return this.settings.maxRetryAttempts;
  }
  reconnectTimeout: NodeJS.Timeout | null = null;
  fileWatchingEnabled = true;
  lastModifiedTimes: Map<string, number> = new Map();

  // Enhanced sync management
  uploadQueue: string[] = [];
  downloadQueue: string[] = [];
  isProcessingQueue = false;
  cloudFileVersions: Map<string, CloudFile> = new Map();
  localFileVersions: Map<string, number> = new Map();
  isBulkSyncing = false;
  syncProgress: { current: number; total: number } = { current: 0, total: 0 };

  // Auto-sync management
  autoSyncInterval: NodeJS.Timeout | null = null;
  isAutoSyncing = false;
  excludedExtensions: Set<string> = new Set([
    ".tmp",
    ".log",
    ".cache",
    ".DS_Store",
  ]);
  excludedFolders: Set<string> = new Set([".obsidian", ".trash", ".git"]);

  // Chunking support
  private chunkBuffers: Map<string, ChunkBuffer> = new Map();
  private get MAX_CHUNK_SIZE() {
    return this.settings.chunkSizeKB * 1000; // Convert KB to bytes, leaving room for JSON overhead
  }

  // Debounced settings save
  private saveSettingsTimeout: NodeJS.Timeout | null = null;

  async onload() {
    await this.loadSettings();

    // Restore lastModifiedTimes from settings
    this.restoreLastModifiedTimes();

    // Add ribbon icon
    const ribbonIconEl = this.addRibbonIcon(
      "sync",
      "Toggle Sync",
      (_evt: MouseEvent) => {
        this.toggleSync();
      },
    );
    ribbonIconEl.addClass("obsync-ribbon-class");

    // Add status bar item
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar("Disconnected");

    // Add commands
    this.addCommand({
      id: "toggle-sync",
      name: "Toggle real-time sync",
      callback: () => {
        this.toggleSync();
      },
    });

    this.addCommand({
      id: "upload-active-file",
      name: "Upload active file",
      callback: () => {
        this.uploadActiveFile();
      },
    });

    this.addCommand({
      id: "download-active-file",
      name: "Download active file",
      callback: () => {
        this.downloadActiveFile();
      },
    });

    this.addCommand({
      id: "list-cloud-files",
      name: "List cloud files",
      callback: () => {
        this.listCloudFiles();
      },
    });

    this.addCommand({
      id: "sync-all-files",
      name: "Sync all files",
      callback: () => {
        this.syncAllFiles();
      },
    });

    this.addCommand({
      id: "download-entire-vault",
      name: "Download entire vault",
      callback: () => {
        this.downloadEntireVault();
      },
    });

    this.addCommand({
      id: "check-sync-status",
      name: "Check sync status",
      callback: () => {
        this.checkSyncStatus();
      },
    });

    this.addCommand({
      id: "smart-sync",
      name: "Smart sync",
      callback: () => {
        this.smartSync();
      },
    });

    this.addCommand({
      id: "toggle-auto-sync",
      name: "Toggle auto-sync",
      callback: () => {
        this.settings.autoSyncEnabled = !this.settings.autoSyncEnabled;
        this.saveSettings();
        if (
          this.settings.autoSyncEnabled &&
          this.ws &&
          this.ws.readyState === WebSocket.OPEN
        ) {
          this.startAutoSync();
          new Notice("Auto-sync enabled");
        } else {
          this.stopAutoSync();
          new Notice("Auto-sync disabled");
        }
      },
    });

    // This creates an icon in the left ribbon.
    this.addSettingTab(new SyncSettingTab(this.app, this));

    // Auto-connect if WebSocket URL is configured but don't auto-sync all files
    if (this.settings.websocketUrl) {
      this.connectWebSocket();
    }

    // Register file events for real-time sync
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (
          file instanceof TFile &&
          this.shouldSyncFile(file) &&
          this.fileWatchingEnabled
        ) {
          console.log(`File created: ${file.path}`);
          this.debounceFileSync(file);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (
          file instanceof TFile &&
          this.shouldSyncFile(file) &&
          this.fileWatchingEnabled
        ) {
          console.log(`File modified: ${file.path}`);
          this.debounceFileSync(file);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && this.shouldSyncFile(file)) {
          console.log(`File deleted: ${file.path}`);
          this.handleFileDeleted(file.path);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile && this.shouldSyncFile(file)) {
          console.log(`File renamed: ${oldPath} -> ${file.path}`);
          // Handle rename as delete old + create new
          this.handleFileDeleted(oldPath);
          this.debounceFileSync(file);
        }
      }),
    );
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
    this.debounceTimeouts.forEach((timeout) => clearTimeout(timeout));
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
      this.lastModifiedTimes = new Map(
        Object.entries(this.settings.lastModifiedTimes),
      );
      console.log(
        `Restored sync tracking for ${this.lastModifiedTimes.size} files`,
      );
    }
  }

  private persistLastModifiedTimes() {
    // Convert Map to Object for JSON serialization
    this.settings.lastModifiedTimes = Object.fromEntries(
      this.lastModifiedTimes,
    );
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

  updateStatusBar(
    status: string,
    state: "connected" | "disconnected" | "syncing" | "error" = "disconnected",
  ) {
    const colors = {
      connected: "#22c55e",
      disconnected: "#ef4444",
      syncing: "#3b82f6",
      error: "#f59e0b",
    };

    const icons = {
      connected: "🟢",
      disconnected: "🔴",
      syncing: "🔵",
      error: "🟡",
    };

    let statusText = `${icons[state]} ${status}`;

    // Add progress indicator during bulk sync
    if (this.isBulkSyncing && this.syncProgress.total > 0) {
      statusText += ` (${this.syncProgress.current}/${this.syncProgress.total})`;
    }

    // Add out-of-sync indicator
    if (state === "connected" && this.hasOutOfSyncFiles()) {
      statusText += " ⚠️";
    }

    this.statusBarItem.setText(statusText);
    this.statusBarItem.style.setProperty("color", colors[state]);
    this.statusBarItem.style.setProperty("cursor", "pointer");
  }

  toggleSync() {
    if (!this.validateWebSocketSettings()) {
      // If no WebSocket URL is configured, show notice and open settings
      new Notice("Please configure WebSocket URL in settings first");
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
      new Notice("Please configure WebSocket URL in settings");
      return false;
    }
    if (!this.settings.apiKey) {
      new Notice("Please configure API Key in settings");
      return false;
    }
    return true;
  }

  // WebSocket Connection Management
  connectWebSocket() {
    if (!this.validateWebSocketSettings()) return;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      new Notice("Already connected to real-time sync");
      return;
    }

    if (this.isConnecting) {
      new Notice("Already attempting to connect...");
      return;
    }

    this.isConnecting = true;
    this.updateStatusBar("Connecting...", "syncing");

    try {
      // Add API key as query parameter for WebSocket connection
      const wsUrl = new URL(this.settings.websocketUrl);
      wsUrl.searchParams.set("apiKey", this.settings.apiKey);
      this.ws = new WebSocket(wsUrl.toString());

      this.ws.onopen = () => {
        console.log("WebSocket connected");
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.updateStatusBar("Connected", "connected");
        new Notice("Connected to real-time sync");

        // Send ping to test connection
        this.sendWebSocketMessage({ action: "ping" });

        // Start auto-sync if enabled (but don't trigger immediate sync)
        if (this.settings.autoSyncEnabled) {
          this.startAutoSync();
        }

        // Check sync status after connecting (for display only)
        setTimeout(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            // Use a flag to indicate this is for status check only, not auto-sync
            this.isAutoSyncing = false;
            this.sendWebSocketMessage({ action: "list" });
          }
        }, 1000);
      };

      this.ws.onmessage = (event) => {
        try {
          const data: WebSocketMessage = JSON.parse(event.data);
          this.handleWebSocketMessage(data);
        } catch (error) {
          console.error("Failed to parse WebSocket message:", error);
        }
      };

      this.ws.onclose = (event) => {
        console.log("WebSocket closed:", event.code, event.reason);
        this.isConnecting = false;
        this.ws = null;
        this.updateStatusBar("Disconnected", "disconnected");

        // Handle specific error codes
        if (event.code === 1009) {
          new Notice(
            "Large file detected - implementing chunking for better sync",
          );
          console.log(
            "WebSocket closed due to message size limit - chunking should handle this",
          );
        }

        // Attempt to reconnect if not manually closed
        if (
          event.code !== 1000 &&
          this.reconnectAttempts < this.maxReconnectAttempts
        ) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (error) => {
        console.error("WebSocket error:", error);
        this.isConnecting = false;
        this.updateStatusBar("Connection Error", "error");
        new Notice(
          "WebSocket connection error. Will retry automatically.",
          5000,
        );
        this.scheduleReconnect();
      };
    } catch (error) {
      console.error("Failed to create WebSocket:", error);
      this.isConnecting = false;
      this.updateStatusBar("Connection Failed", "error");
      new Notice("Failed to connect to real-time sync");
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
      this.ws.close(1000, "Manual disconnect");
      this.ws = null;
    }

    this.updateStatusBar("Disconnected", "disconnected");
    new Notice("Disconnected from real-time sync");
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.updateStatusBar("Connection failed", "error");
      new Notice(
        `Failed to connect after ${this.maxReconnectAttempts} attempts. Click sync icon to retry manually.`,
        8000,
      );
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000); // Exponential backoff, max 30s

    console.log(
      `Scheduling reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`,
    );
    this.updateStatusBar(
      `Reconnecting ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${Math.ceil(delay / 1000)}s...`,
      "syncing",
    );

    this.reconnectTimeout = setTimeout(() => {
      this.connectWebSocket();
    }, delay);
  }

  private sendWebSocketMessage(message: WebSocketMessage) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      new Notice("Not connected to real-time sync");
      return false;
    }

    try {
      // Always include API key in message
      message.apiKey = this.settings.apiKey;

      const messageStr = JSON.stringify(message);
      const messageSizeKB = new Blob([messageStr]).size;

      // If message is larger than ~28KB, chunk it
      if (messageSizeKB > this.MAX_CHUNK_SIZE) {
        return this.sendChunkedMessage(message);
      }

      this.ws.send(messageStr);
      return true;
    } catch (error: unknown) {
      console.error("Failed to send WebSocket message:", error);
      new Notice("Failed to send message");
      return false;
    }
  }

  private sendChunkedMessage(message: WebSocketMessage): boolean {
    try {
      if (!message.filePath || !message.content) {
        console.error("Cannot chunk message without filePath and content");
        return false;
      }

      const chunkId = `${message.filePath}-${Date.now()}`;
      const content = message.content;
      const chunks: string[] = [];

      // Split content into chunks
      for (let i = 0; i < content.length; i += this.MAX_CHUNK_SIZE) {
        chunks.push(content.slice(i, i + this.MAX_CHUNK_SIZE));
      }

      console.log(
        `Chunking large file ${message.filePath} into ${chunks.length} chunks (${Math.round(new Blob([content]).size / 1024)}KB)`,
      );

      // Send each chunk
      for (let i = 0; i < chunks.length; i++) {
        const chunkMessage: WebSocketMessage = {
          action: message.action,
          apiKey: this.settings.apiKey,
          filePath: message.filePath,
          content: chunks[i],
          fileType: message.fileType,
          lastModified: message.lastModified,
          isChunked: true,
          chunkId: chunkId,
          chunkIndex: i,
          totalChunks: chunks.length,
        };

        const chunkStr = JSON.stringify(chunkMessage);
        this.ws!.send(chunkStr);

        // Add small delay between chunks to avoid overwhelming the server
        if (i < chunks.length - 1) {
          setTimeout(() => {}, 50);
        }
      }

      console.log(
        `Successfully sent ${chunks.length} chunks for ${message.filePath}`,
      );
      return true;
    } catch (error) {
      console.error("Failed to send chunked message:", error);
      return false;
    }
  }

  private handleWebSocketMessage(data: WebSocketMessage) {
    console.log("Received WebSocket message:", data);

    // Handle chunked messages
    if (
      data.isChunked &&
      data.chunkId &&
      data.chunkIndex !== undefined &&
      data.totalChunks
    ) {
      return this.handleChunkedMessage(data);
    }

    switch (data.type) {
      case "pong":
        console.log("Pong received");
        break;

      case "upload_success":
        console.log(`File uploaded: ${data.filePath}`);
        // Update local tracking to prevent re-upload
        if (data.filePath && data.lastModified) {
          this.lastModifiedTimes.set(data.filePath, data.lastModified);
          this.debouncedSaveSettings(); // Persist the tracking
        }
        break;

      case "download_success":
        if (data.filePath && data.content !== undefined) {
          this.applyFileContent(
            data.filePath,
            data.content,
            data.fileType || "text",
            data.lastModified,
          );
        }
        break;

      case "file_list":
        if (data.files) {
          this.handleFileListResponse(data.files);
        }
        break;

      case "file_changed":
        if (data.filePath && data.action === "upload") {
          new Notice(`File updated by another client: ${data.filePath}`);
          // Optionally auto-download the updated file
          // this.downloadFile(data.filePath);
        }
        break;

      case "delete_success":
        if (data.filePath) {
          new Notice(`File deleted from cloud: ${data.filePath}`);
          console.log(`File deleted successfully: ${data.filePath}`);
        }
        break;

      case "error":
        new Notice(`Sync error: ${data.message}`);
        console.error("WebSocket error:", data.message);
        break;

      default:
        console.log("Unknown message type:", data.type);
    }
  }

  private handleChunkedMessage(data: WebSocketMessage): void {
    if (
      !data.chunkId ||
      data.chunkIndex === undefined ||
      !data.totalChunks ||
      !data.filePath
    ) {
      console.error("Invalid chunked message:", data);
      return;
    }

    const bufferId = data.chunkId;

    // Initialize chunk buffer if needed
    if (!this.chunkBuffers.has(bufferId)) {
      this.chunkBuffers.set(bufferId, {
        chunks: new Map(),
        totalChunks: data.totalChunks,
        filePath: data.filePath,
        fileType: data.fileType || "text",
        lastModified: data.lastModified,
      });
    }

    const buffer = this.chunkBuffers.get(bufferId)!;

    // Store chunk
    if (data.content) {
      buffer.chunks.set(data.chunkIndex, data.content);
    }

    console.log(
      `Received chunk ${data.chunkIndex + 1}/${data.totalChunks} for ${data.filePath}`,
    );

    // Check if all chunks received
    if (buffer.chunks.size === buffer.totalChunks) {
      // Reassemble content
      let fullContent = "";
      for (let i = 0; i < buffer.totalChunks; i++) {
        const chunk = buffer.chunks.get(i);
        if (chunk === undefined) {
          console.error(`Missing chunk ${i} for ${data.filePath}`);
          this.chunkBuffers.delete(bufferId);
          return;
        }
        fullContent += chunk;
      }

      console.log(
        `Successfully reassembled ${data.filePath} from ${buffer.totalChunks} chunks (${Math.round(new Blob([fullContent]).size / 1024)}KB)`,
      );

      // Clean up buffer
      this.chunkBuffers.delete(bufferId);

      // Process the complete message based on its type/action
      if (data.type === "download_success") {
        this.applyFileContent(
          buffer.filePath,
          fullContent,
          buffer.fileType,
          buffer.lastModified,
        );
      } else if (data.type === "upload_success") {
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
      new Notice("No active file");
      return;
    }

    await this.uploadFile(activeFile.path);
  }

  async uploadFile(filePath: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      new Notice("Not connected to real-time sync");
      return;
    }

    try {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!file || !(file instanceof TFile)) {
        console.error(`File not found: ${filePath}`);
        return;
      }

      const content = await this.app.vault.read(file);
      const fileType = this.getFileType(filePath);

      // Encode binary files as base64
      let fileContent = content;
      if (fileType === "binary") {
        const arrayBuffer = await this.app.vault.readBinary(file);
        fileContent = this.arrayBufferToBase64(arrayBuffer);
      }

      // Check file size and notify user if it's large
      const fileSizeKB = Math.round(new Blob([fileContent]).size / 1024);
      const fileSizeMB = fileSizeKB / 1024;

      if (fileSizeMB > this.settings.fileSizeWarningMB) {
        new Notice(
          `Syncing large file: ${filePath} (${fileSizeMB.toFixed(1)}MB) - this may take a moment`,
        );
        if (this.settings.enableDebugLogging) {
          console.log(
            `Large file detected: ${filePath} (${fileSizeKB}KB) - will be chunked`,
          );
        }
      }

      if (this.settings.enableDebugLogging) {
        console.log(`Uploading file: ${filePath} (type: ${fileType})`);
      }

      // Note: lastModifiedTimes will be updated when we receive upload_success response
    } catch (error) {
      console.error(`Error uploading file ${filePath}:`, error);
      new Notice(`Failed to upload ${filePath}`);
    }
  }

  async downloadActiveFile() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("No active file");
      return;
    }

    this.downloadFile(activeFile.path);
  }

  downloadFile(filePath: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      new Notice("Not connected to real-time sync");
      return false;
    }

    try {
      this.updateStatusBar("Downloading...", "syncing");

      const success = this.sendWebSocketMessage({
        action: "download",
        filePath: filePath,
      });

      if (success) {
        console.log(`Downloading file: ${filePath}`);
      } else {
        new Notice(`Failed to request download for: ${filePath}`);
        return false;
      }

      // Set timeout to detect if download fails
      setTimeout(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.updateStatusBar("Connected", "connected");
        }
      }, this.settings.operationTimeoutMs);

      return true;
    } catch (error) {
      console.error(`Error downloading file ${filePath}:`, error);
      new Notice(`Failed to download ${filePath}: ${(error as any).message}`);
      return false;
    }
  }

  private async applyFileContent(
    filePath: string,
    content: string,
    fileType = "text",
    lastModified?: number,
  ) {
    try {
      // Temporarily disable file watching to prevent sync loop
      this.fileWatchingEnabled = false;

      // Create folder if it doesn't exist
      await this.createFolderIfNotExists(filePath);

      const file = this.app.vault.getAbstractFileByPath(filePath);

      if (file instanceof TFile) {
        // File exists, update it
        if (fileType === "text") {
          await this.app.vault.modify(file, content);
        } else {
          // For binary files, decode base64 and write binary
          const binaryData = Uint8Array.from(atob(content), (c) =>
            c.charCodeAt(0),
          );
          await this.app.vault.modifyBinary(file, binaryData.buffer);
        }
        // Update last modified time to prevent sync loop
        this.lastModifiedTimes.set(filePath, lastModified || file.stat.mtime);
        this.debouncedSaveSettings(); // Persist the tracking
      } else {
        // Create new file
        if (fileType === "text") {
          await this.app.vault.create(filePath, content);
        } else {
          // For binary files, decode base64 and create binary file
          const binaryData = Uint8Array.from(atob(content), (c) =>
            c.charCodeAt(0),
          );
          await this.app.vault.createBinary(filePath, binaryData.buffer);
        }

        // Get the created file to update tracking
        const newFile = this.app.vault.getAbstractFileByPath(filePath);
        if (newFile instanceof TFile) {
          this.lastModifiedTimes.set(
            filePath,
            lastModified || newFile.stat.mtime,
          );
          this.debouncedSaveSettings(); // Persist the tracking
        }
      }

      new Notice(`Downloaded: ${filePath}`);
    } catch (error) {
      console.error("Failed to apply file content:", error);
      new Notice(`Failed to save downloaded file: ${(error as any).message}`);
    } finally {
      // Re-enable file watching after a short delay
      setTimeout(() => {
        this.fileWatchingEnabled = true;
      }, 1000);
    }
  }

  listCloudFiles() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      new Notice("Not connected to real-time sync");
      return;
    }

    this.updateStatusBar("Fetching file list...", "syncing");

    const success = this.sendWebSocketMessage({
      action: "list",
    });

    if (success) {
      console.log("Requesting file list");
    }

    setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.updateStatusBar("Connected", "connected");
      }
    }, 2000);
  }

  private handleFileListResponse(files: Record<string, any>) {
    // Store cloud file versions for comparison
    this.cloudFileVersions.clear();
    Object.entries(files).forEach(([path, fileInfo]) => {
      if (typeof fileInfo === "string") {
        // Legacy format - just version string
        this.cloudFileVersions.set(path, {
          version: fileInfo,
          lastModified: 0,
          fileType: "text",
        });
      } else {
        // New format - object with metadata
        this.cloudFileVersions.set(path, {
          version: fileInfo.version,
          lastModified:
            fileInfo.clientLastModified || fileInfo.lastModified || 0,
          fileType: fileInfo.fileType || "text",
        });
      }
    });

    // Determine what operation triggered this file list request
    const statusText = this.statusBarItem.getText();

    if (this.isAutoSyncing) {
      // This is for auto-sync operation
      this.performSmartAutoSync(files);
    } else if (statusText.includes("Smart syncing")) {
      // This is for smart sync operation
      this.processSmartSync(files);
    } else if (this.isBulkSyncing) {
      // This is for bulk download operation
      this.downloadQueue = Object.keys(files);
      this.syncProgress = { current: 0, total: this.downloadQueue.length };

      if (this.downloadQueue.length === 0) {
        new Notice("No files found in cloud");
        this.isBulkSyncing = false;
        this.updateStatusBar("Connected", "connected");
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
    if (
      this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      !this.isBulkSyncing
    ) {
      this.updateStatusBar("Connected", "connected");
    }
  }

  private displayFileList(files: Record<string, any>) {
    const fileList = Object.keys(files);

    // Just log to console instead of showing notifications
    console.log(`Cloud files (${fileList.length}):`, fileList);

    if (fileList.length === 0) {
      console.log("No files found in cloud");
    } else {
      fileList.forEach((path) => {
        const fileInfo = files[path];
        if (typeof fileInfo === "string") {
          console.log(`  ${path} (v${fileInfo})`);
        } else {
          console.log(`  ${path} (v${fileInfo.version}, ${fileInfo.fileType})`);
        }
      });
    }
  }

  private checkAndReportSyncStatus(cloudFiles: Record<string, any>) {
    const localFiles = this.getAllLocalFiles().filter((file) =>
      this.shouldSyncFile(file),
    );
    const outOfSyncFiles: string[] = [];
    const cloudOnlyFiles: string[] = [];
    const localOnlyFiles: string[] = [];

    console.log("=== SYNC STATUS DEBUG ===");
    console.log(`Local files count: ${localFiles.length}`);
    console.log(`Cloud files count: ${Object.keys(cloudFiles).length}`);

    // Check files that exist locally
    localFiles.forEach((file) => {
      const cloudFileInfo = cloudFiles[file.path];
      if (!cloudFileInfo) {
        localOnlyFiles.push(file.path);
        console.log(
          `📤 LOCAL ONLY: ${file.path} (modified: ${new Date(file.stat.mtime)})`,
        );
      } else {
        // Extract cloud version info (handle both old and new formats)
        const cloudVersion =
          typeof cloudFileInfo === "string"
            ? cloudFileInfo
            : cloudFileInfo.version;
        const cloudLastModified =
          typeof cloudFileInfo === "string"
            ? 0
            : cloudFileInfo.clientLastModified ||
              cloudFileInfo.lastModified ||
              0;

        // Check if file has been modified since last sync or is newer than cloud version
        const lastKnownTime = this.lastModifiedTimes.get(file.path);
        const fileNeedsSync = !lastKnownTime || file.stat.mtime > lastKnownTime;
        const localIsNewer = file.stat.mtime > cloudLastModified;

        if (fileNeedsSync || localIsNewer) {
          outOfSyncFiles.push(file.path);
          console.log(`📝 OUT OF SYNC: ${file.path}`);
          console.log(`  - File modified: ${new Date(file.stat.mtime)}`);
          console.log(
            `  - Last known sync: ${lastKnownTime ? new Date(lastKnownTime) : "Never"}`,
          );
          console.log(
            `  - Cloud version: ${cloudVersion}, modified: ${new Date(cloudLastModified)}`,
          );
          console.log(`  - Local is newer: ${localIsNewer}`);
        } else {
          console.log(`✅ IN SYNC: ${file.path}`);
        }
      }
    });

    // Check files that exist only in cloud
    Object.keys(cloudFiles).forEach((cloudPath) => {
      const localFile = localFiles.find((f) => f.path === cloudPath);
      if (!localFile) {
        cloudOnlyFiles.push(cloudPath);
        console.log(
          `📥 CLOUD ONLY: ${cloudPath} (version: ${cloudFiles[cloudPath]})`,
        );
      }
    });

    console.log("=== SYNC STATUS SUMMARY ===");
    console.log(`Out of sync: ${outOfSyncFiles.length}`);
    console.log(`Local only: ${localOnlyFiles.length}`);
    console.log(`Cloud only: ${cloudOnlyFiles.length}`);

    // Log sync status to console instead of showing notifications
    if (
      outOfSyncFiles.length === 0 &&
      cloudOnlyFiles.length === 0 &&
      localOnlyFiles.length === 0
    ) {
      console.log("✅ All files are in sync");
    } else {
      console.log("📊 SYNC STATUS REPORT");

      if (outOfSyncFiles.length > 0) {
        console.log(`📝 MODIFIED LOCALLY (${outOfSyncFiles.length}):`);
        outOfSyncFiles.slice(0, 10).forEach((file) => {
          console.log(`   • ${file}`);
        });
        if (outOfSyncFiles.length > 10)
          console.log(`   ... and ${outOfSyncFiles.length - 10} more`);
      }

      if (localOnlyFiles.length > 0) {
        console.log(`📤 LOCAL ONLY (${localOnlyFiles.length}):`);
        localOnlyFiles.slice(0, 10).forEach((file) => {
          console.log(`   • ${file}`);
        });
        if (localOnlyFiles.length > 10)
          console.log(`   ... and ${localOnlyFiles.length - 10} more`);
      }

      if (cloudOnlyFiles.length > 0) {
        console.log(`📥 CLOUD ONLY (${cloudOnlyFiles.length}):`);
        cloudOnlyFiles.slice(0, 10).forEach((file) => {
          console.log(`   • ${file}`);
        });
        if (cloudOnlyFiles.length > 10)
          console.log(`   ... and ${cloudOnlyFiles.length - 10} more`);
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

    // If instant sync mode is enabled, sync immediately
    if (this.settings.instantSyncMode) {
      this.uploadFile(file.path);
      return;
    }

    // Clear existing timeout for this file
    const existingTimeout = this.debounceTimeouts.get(file.path);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set new timeout with configurable delay
    const timeout = setTimeout(() => {
      this.uploadFile(file.path);
      this.debounceTimeouts.delete(file.path);
    }, this.settings.debounceDelay);

    this.debounceTimeouts.set(file.path, timeout);
  }

  private toggleFileWatching() {
    this.fileWatchingEnabled = !this.fileWatchingEnabled;
    const status = this.fileWatchingEnabled ? "enabled" : "disabled";
    new Notice(`Automatic file watching ${status}`);
    console.log(`File watching ${status}`);
  }

  // Bulk Sync Operations
  async syncAllFiles() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      new Notice("Not connected to real-time sync");
      return;
    }

    if (this.isBulkSyncing) {
      new Notice("Bulk sync already in progress");
      return;
    }

    try {
      this.isBulkSyncing = true;
      const markdownFiles = this.app.vault.getMarkdownFiles();

      // Filter out files that don't need syncing
      const filesToSync = markdownFiles.filter((file) => {
        // Always sync if we don't have version info, or if file is newer
        const lastKnownTime = this.lastModifiedTimes.get(file.path);
        return !lastKnownTime || file.stat.mtime > lastKnownTime;
      });

      if (filesToSync.length === 0) {
        new Notice("All files are already in sync");
        this.isBulkSyncing = false;
        return;
      }

      this.syncProgress = { current: 0, total: filesToSync.length };
      this.updateStatusBar("Syncing all files", "syncing");

      new Notice(`Syncing ${filesToSync.length} files...`);

      // Process files in batches to avoid overwhelming the server
      const batchSize = 3;
      for (let i = 0; i < filesToSync.length; i += batchSize) {
        const batch = filesToSync.slice(i, i + batchSize);

        // Process batch in parallel
        await Promise.all(
          batch.map(async (file) => {
            try {
              await this.uploadFile(file.path);
              this.syncProgress.current++;
              this.updateStatusBar("Syncing all files", "syncing");
            } catch (error) {
              console.error(`Failed to sync file ${file.path}:`, error);
            }
          }),
        );

        // Small delay between batches
        if (i + batchSize < filesToSync.length) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      new Notice(`Successfully synced ${this.syncProgress.current} files`);
    } catch (error) {
      console.error("Bulk sync failed:", error);
      new Notice(`Bulk sync failed: ${(error as any).message}`);
    } finally {
      this.isBulkSyncing = false;
      this.syncProgress = { current: 0, total: 0 };
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.updateStatusBar("Connected", "connected");
      }
    }
  }

  async downloadEntireVault() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      new Notice("Not connected to real-time sync");
      return;
    }

    if (this.isBulkSyncing) {
      new Notice("Bulk operation already in progress");
      return;
    }

    try {
      this.isBulkSyncing = true;
      this.updateStatusBar("Fetching file list", "syncing");

      // First get the list of all files in the cloud
      const success = this.sendWebSocketMessage({ action: "list" });
      if (!success) {
        throw new Error("Failed to request file list");
      }

      new Notice("Downloading entire vault from cloud...");

      // The file list response will be handled in handleWebSocketMessage
      // and will trigger the actual download process
    } catch (error) {
      console.error("Download vault failed:", error);
      new Notice(`Download vault failed: ${(error as any).message}`);
      this.isBulkSyncing = false;
      this.syncProgress = { current: 0, total: 0 };
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.updateStatusBar("Connected", "connected");
      }
    }
  }

  async checkSyncStatus() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      new Notice("Not connected to real-time sync");
      return;
    }

    try {
      this.updateStatusBar("Checking sync status", "syncing");

      // Request file list to compare with local files
      const success = this.sendWebSocketMessage({ action: "list" });
      if (!success) {
        throw new Error("Failed to request file list");
      }

      // The comparison will be done in handleWebSocketMessage when we receive the file list
    } catch (error) {
      console.error("Check sync status failed:", error);
      new Notice(`Check sync status failed: ${(error as any).message}`);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.updateStatusBar("Connected", "connected");
      }
    }
  }

  private hasOutOfSyncFiles(): boolean {
    // Check if any local files have been modified since last sync
    const markdownFiles = this.app.vault.getMarkdownFiles();
    return markdownFiles.some((file) => {
      const lastKnownTime = this.lastModifiedTimes.get(file.path);
      return !lastKnownTime || file.stat.mtime > lastKnownTime;
    });
  }

  private async processDownloadQueue() {
    if (this.downloadQueue.length === 0) {
      this.isBulkSyncing = false;
      this.syncProgress = { current: 0, total: 0 };
      new Notice("Vault download completed");
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.updateStatusBar("Connected", "connected");
      }
      return;
    }

    const batchSize = 3;
    const batch = this.downloadQueue.splice(0, batchSize);

    // Process batch in parallel
    await Promise.all(
      batch.map(async (filePath) => {
        try {
          this.downloadFile(filePath);
          await new Promise((resolve) => setTimeout(resolve, 100)); // Small delay
        } catch (error) {
          console.error(`Failed to download file ${filePath}:`, error);
        }
      }),
    );

    // Continue with next batch
    setTimeout(() => this.processDownloadQueue(), 500);
  }

  async smartSync() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      new Notice("Not connected to real-time sync");
      return;
    }

    if (this.isBulkSyncing) {
      new Notice("Bulk operation already in progress");
      return;
    }

    try {
      this.isBulkSyncing = true;
      this.updateStatusBar("Smart syncing", "syncing");

      // First get the list of all files in the cloud
      const success = this.sendWebSocketMessage({ action: "list" });
      if (!success) {
        throw new Error("Failed to request file list");
      }

      new Notice("Starting smart sync (both directions)...");

      // The file list response will be handled in handleWebSocketMessage
      // and will trigger the smart sync process
    } catch (error) {
      console.error("Smart sync failed:", error);
      new Notice(`Smart sync failed: ${(error as any).message}`);
      this.isBulkSyncing = false;
      this.syncProgress = { current: 0, total: 0 };
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.updateStatusBar("Connected", "connected");
      }
    }
  }

  private async processSmartSync(cloudFiles: Record<string, any>) {
    const localFiles = this.getAllLocalFiles().filter((file) =>
      this.shouldSyncFile(file),
    );
    const filesToUpload: TFile[] = [];
    const filesToDownload: string[] = [];
    const conflicts: ConflictFile[] = [];

    console.log("=== SMART SYNC ANALYSIS ===");

    // Check files that exist locally
    localFiles.forEach((file) => {
      const cloudFileInfo = cloudFiles[file.path];
      if (!cloudFileInfo) {
        // File doesn't exist in cloud, upload it
        filesToUpload.push(file);
        console.log(`📤 WILL UPLOAD: ${file.path} (not in cloud)`);
      } else {
        // Extract cloud timestamp info
        const cloudLastModified =
          typeof cloudFileInfo === "string"
            ? 0
            : cloudFileInfo.clientLastModified ||
              cloudFileInfo.lastModified ||
              0;
        const lastKnownTime = this.lastModifiedTimes.get(file.path);

        // Detect true conflicts: both local and cloud have been modified since last sync
        const localModified = file.stat.mtime > (lastKnownTime || 0);
        const cloudModified = cloudLastModified > (lastKnownTime || 0);

        if (
          localModified &&
          cloudModified &&
          file.stat.mtime !== cloudLastModified
        ) {
          // True conflict: both sides have changes
          conflicts.push({
            filePath: file.path,
            localModified: file.stat.mtime,
            cloudModified: cloudLastModified,
          });
          console.log(
            `⚠️ CONFLICT: ${file.path} (local: ${new Date(file.stat.mtime)}, cloud: ${new Date(cloudLastModified)})`,
          );
        } else if (localModified || file.stat.mtime > cloudLastModified) {
          // Local is newer or only local has changes, upload it
          filesToUpload.push(file);
          console.log(
            `📤 WILL UPLOAD: ${file.path} (local: ${new Date(file.stat.mtime)}, cloud: ${new Date(cloudLastModified)})`,
          );
        } else if (cloudModified || cloudLastModified > file.stat.mtime) {
          // Cloud is newer or only cloud has changes, download it
          filesToDownload.push(file.path);
          console.log(
            `📥 WILL DOWNLOAD: ${file.path} (local: ${new Date(file.stat.mtime)}, cloud: ${new Date(cloudLastModified)})`,
          );
        }
      }
    });

    // Check files that exist only in cloud - download them
    Object.keys(cloudFiles).forEach((cloudPath) => {
      const localFile = localFiles.find((f) => f.path === cloudPath);
      if (!localFile) {
        filesToDownload.push(cloudPath);
        console.log(`📥 WILL DOWNLOAD: ${cloudPath} (not local)`);
      }
    });

    // Handle conflicts first if any exist
    if (conflicts.length > 0) {
      console.log(
        `Found ${conflicts.length} conflicts, showing resolution dialog...`,
      );

      // Load content for text file conflicts to show preview
      for (const conflict of conflicts) {
        const localFile = localFiles.find((f) => f.path === conflict.filePath);
        if (localFile && this.getFileType(localFile) === "text") {
          try {
            conflict.localContent = await this.app.vault.read(localFile);
            // Get cloud content - we'll need to fetch it
            // For now, we'll resolve conflicts without content preview
            // This could be enhanced later by fetching cloud content
          } catch (error) {
            console.error(
              `Failed to read local file ${conflict.filePath}:`,
              error,
            );
          }
        }
      }

      // Show conflict resolution modal
      const modal = new ConflictResolutionModal(
        this.app,
        this,
        conflicts,
        async (resolutions: ConflictResolution[]) => {
          // Process conflict resolutions
          for (const resolution of resolutions) {
            if (resolution.choice === "local") {
              // User chose to keep local version - upload it
              const localFile = localFiles.find(
                (f) => f.path === resolution.filePath,
              );
              if (localFile) {
                filesToUpload.push(localFile);
                console.log(
                  `🔄 CONFLICT RESOLVED: Will upload ${resolution.filePath} (keep local)`,
                );
              }
            } else {
              // User chose to use cloud version - download it
              filesToDownload.push(resolution.filePath);
              console.log(
                `🔄 CONFLICT RESOLVED: Will download ${resolution.filePath} (use cloud)`,
              );
            }
          }

          // Continue with normal sync after resolving conflicts
          await this.executeSyncOperations(filesToUpload, filesToDownload);
        },
      );

      modal.open();
      return; // Exit early, modal callback will continue the sync
    }

    // No conflicts, proceed with normal sync
    await this.executeSyncOperations(filesToUpload, filesToDownload);
  }

  private async executeSyncOperations(
    filesToUpload: TFile[],
    filesToDownload: string[],
  ) {
    const totalOperations = filesToUpload.length + filesToDownload.length;
    if (totalOperations === 0) {
      new Notice("✅ All files are already in sync");
      this.isBulkSyncing = false;
      this.updateStatusBar("Connected", "connected");
      return;
    }

    this.syncProgress = { current: 0, total: totalOperations };
    console.log(
      `Smart sync: ${filesToUpload.length} uploads, ${filesToDownload.length} downloads`,
    );

    // Process uploads first (in batches)
    const batchSize = this.settings.batchSize;
    for (let i = 0; i < filesToUpload.length; i += batchSize) {
      const batch = filesToUpload.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (file) => {
          try {
            await this.uploadFile(file.path);
            this.syncProgress.current++;
            this.updateStatusBar("Smart syncing", "syncing");
          } catch (error) {
            console.error(`Failed to upload file ${file.path}:`, error);
          }
        }),
      );

      if (i + batchSize < filesToUpload.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    // Process downloads (in batches)
    for (let i = 0; i < filesToDownload.length; i += batchSize) {
      const batch = filesToDownload.slice(i, i + batchSize);

      batch.forEach((filePath) => {
        this.downloadFile(filePath);
      });

      if (i + batchSize < filesToDownload.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    new Notice(
      `Smart sync completed: ${filesToUpload.length} uploaded, ${filesToDownload.length} downloaded`,
    );
    this.isBulkSyncing = false;
    this.syncProgress = { current: 0, total: 0 };
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.updateStatusBar("Connected", "connected");
    }
  }

  handleFileDeleted(filePath: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log(`File deleted locally but not connected: ${filePath}`);
      return;
    }

    console.log(`File deleted locally, notifying cloud: ${filePath}`);

    const success = this.sendWebSocketMessage({
      action: "delete",
      filePath: filePath,
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
    const ext = file.extension.toLowerCase();

    // Check excluded folders
    for (const folder of this.settings.excludedFolders) {
      if (file.path.startsWith(`${folder}/`) || file.path === folder) {
        return false;
      }
    }

    // Check file size limits
    if (file.stat.size > this.settings.maxFileSizeMB * 1024 * 1024) {
      if (this.settings.enableDebugLogging) {
        console.log(
          `Skipping ${file.path}: exceeds max file size (${Math.round(file.stat.size / 1024 / 1024)}MB)`,
        );
      }
      return false;
    }

    // If sync all file types is disabled, only sync markdown files
    if (!this.settings.syncAllFileTypes && ext !== "md") {
      return false;
    }

    // If sync all file types is enabled, use whitelist/blacklist logic
    if (this.settings.syncAllFileTypes) {
      if (this.settings.useWhitelist) {
        // Whitelist mode: only sync files with extensions in the whitelist
        return this.settings.extensionWhitelist.includes(ext);
      }
      // Blacklist mode: sync all files except those in the blacklist
      return !this.settings.extensionBlacklist.includes(ext);
    }

    return true;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private getFileType(file: TFile | string): string {
    const ext =
      typeof file === "string"
        ? file.split(".").pop()?.toLowerCase() || ""
        : file.extension.toLowerCase();
    if (
      [
        "md",
        "txt",
        "json",
        "yaml",
        "yml",
        "xml",
        "html",
        "css",
        "js",
        "ts",
        "py",
        "java",
        "cpp",
        "c",
        "h",
      ].includes(ext)
    ) {
      return "text";
    }
    return "binary";
  }

  private async createFolderIfNotExists(filePath: string): Promise<void> {
    const folderPath = filePath.substring(0, filePath.lastIndexOf("/"));
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

    // Start auto sync with configurable interval
    this.autoSyncInterval = setInterval(() => {
      if (
        this.ws &&
        this.ws.readyState === WebSocket.OPEN &&
        !this.isAutoSyncing &&
        !this.isBulkSyncing
      ) {
        this.performAutoSync();
      }
    }, this.settings.autoSyncInterval);

    console.log(
      `Auto-sync started with ${this.settings.autoSyncInterval}ms interval`,
    );
  }

  stopAutoSync() {
    if (this.autoSyncInterval) {
      clearInterval(this.autoSyncInterval);
      this.autoSyncInterval = null;
      console.log("Auto-sync stopped");
    }
  }

  private async performAutoSync() {
    if (this.isAutoSyncing || this.isBulkSyncing) {
      return;
    }

    try {
      this.isAutoSyncing = true;
      console.log("Performing auto-sync check...");

      // Request file list to compare with local files
      const success = this.sendWebSocketMessage({ action: "list" });
      if (success) {
        // The file list response will trigger automatic sync in handleFileListResponse
      }
    } catch (error) {
      console.error("Auto-sync failed:", error);
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

    console.log("Performing smart auto-sync...");

    const localFiles = this.getAllLocalFiles();
    const filesToUpload: TFile[] = [];
    const filesToDownload: string[] = [];

    // Check files that exist locally
    localFiles.forEach((file) => {
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
        const cloudLastModified =
          typeof cloudFileInfo === "string"
            ? 0
            : cloudFileInfo.clientLastModified ||
              cloudFileInfo.lastModified ||
              0;

        // Check if file has been modified since last sync or is newer than cloud version
        const lastKnownTime = this.lastModifiedTimes.get(file.path);
        const fileNeedsSync = !lastKnownTime || file.stat.mtime > lastKnownTime;
        const localIsNewer = file.stat.mtime > cloudLastModified;

        if (fileNeedsSync || localIsNewer) {
          // File was modified locally or is newer than cloud, upload it
          filesToUpload.push(file);
          console.log(
            `Auto-sync: Will upload ${file.path} (local: ${new Date(file.stat.mtime)}, cloud: ${new Date(cloudLastModified)})`,
          );
        }
      }
    });

    // Check files that exist only in cloud - download them
    Object.keys(cloudFiles).forEach((cloudPath) => {
      const localFile = localFiles.find((f) => f.path === cloudPath);
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
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Rate limiting
      } catch (error) {
        console.error(`Auto-sync upload failed for ${file.path}:`, error);
      }
    }

    // Perform downloads (limited batch size for auto-sync)
    for (
      let i = 0;
      i < Math.min(filesToDownload.length, maxAutoSyncFiles);
      i++
    ) {
      const filePath = filesToDownload[i];
      try {
        this.downloadFile(filePath);
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Rate limiting
      } catch (error) {
        console.error(`Auto-sync download failed for ${filePath}:`, error);
      }
    }

    if (
      filesToUpload.length > maxAutoSyncFiles ||
      filesToDownload.length > maxAutoSyncFiles
    ) {
      new Notice(
        `Auto-sync: Processed ${maxAutoSyncFiles} files. Use Smart Sync command for full sync.`,
      );
    } else if (filesToUpload.length > 0 || filesToDownload.length > 0) {
      new Notice(
        `Auto-sync: ${filesToUpload.length} uploaded, ${filesToDownload.length} downloaded`,
      );
    }
  }

  private getAllLocalFiles(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter((file) => file instanceof TFile) as TFile[];
  }
}

class SyncSettingTab extends PluginSettingTab {
  plugin: ObsidianSyncPlugin;

  constructor(app: App, plugin: ObsidianSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName("WebSocket URL")
      .setDesc("The URL of your WebSocket endpoint")
      .addText((text) =>
        text
          .setPlaceholder("wss://your-lambda-url.amazonaws.com/")
          .setValue(this.plugin.settings.websocketUrl)
          .onChange(async (value) => {
            this.plugin.settings.websocketUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("Your API key for authentication")
      .addText((text) => {
        text
          .setPlaceholder("Enter your API key")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Username")
      .setDesc("Your username for sync (currently for future use)")
      .addText((text) =>
        text
          .setPlaceholder("Enter your username")
          .setValue(this.plugin.settings.username)
          .onChange(async (value) => {
            this.plugin.settings.username = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Password")
      .setDesc("Your password for sync (currently for future use)")
      .addText((text) => {
        text
          .setPlaceholder("Enter your password")
          .setValue(this.plugin.settings.password)
          .onChange(async (value) => {
            this.plugin.settings.password = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    containerEl.createEl("h3", { text: "Real-time Sync (File Watching)" });

    const realtimeDesc = containerEl.createEl("p", {
      text: "Files are automatically synced when you edit them (always enabled when connected)",
    });
    realtimeDesc.style.color = "var(--text-muted)";
    realtimeDesc.style.fontSize = "0.9em";
    realtimeDesc.style.marginBottom = "20px";

    new Setting(containerEl)
      .setName("Instant Sync Mode")
      .setDesc("Sync files immediately when changed (no delay)")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.instantSyncMode)
          .onChange(async (value) => {
            this.plugin.settings.instantSyncMode = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Debounce Delay (ms)")
      .setDesc(
        "Delay before syncing after you stop typing (ignored in instant mode)",
      )
      .addText((text) =>
        text
          .setPlaceholder("2000")
          .setValue(this.plugin.settings.debounceDelay.toString())
          .onChange(async (value) => {
            const numValue = Number.parseInt(value) || 2000;
            if (numValue >= 100 && numValue <= 30000) {
              this.plugin.settings.debounceDelay = numValue;
              await this.plugin.saveSettings();
            }
          }),
      );

    containerEl.createEl("h3", { text: "Background Auto-Sync" });

    const autoSyncDesc = containerEl.createEl("p", {
      text: "Periodic background sync checks (separate from real-time file watching above)",
    });
    autoSyncDesc.style.color = "var(--text-muted)";
    autoSyncDesc.style.fontSize = "0.9em";
    autoSyncDesc.style.marginBottom = "20px";

    new Setting(containerEl)
      .setName("Enable Background Auto-Sync")
      .setDesc(
        "Automatically run sync checks in the background at regular intervals",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSyncEnabled)
          .onChange(async (value) => {
            this.plugin.settings.autoSyncEnabled = value;
            await this.plugin.saveSettings();

            // Start/stop auto-sync based on setting
            if (
              value &&
              this.plugin.ws &&
              this.plugin.ws.readyState === WebSocket.OPEN
            ) {
              this.plugin.startAutoSync();
            } else {
              this.plugin.stopAutoSync();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Auto-Sync Interval (seconds)")
      .setDesc("How often to run background sync checks")
      .addText((text) =>
        text
          .setPlaceholder("30")
          .setValue((this.plugin.settings.autoSyncInterval / 1000).toString())
          .onChange(async (value) => {
            const numValue = Number.parseInt(value) || 30;
            if (numValue >= 5 && numValue <= 600) {
              this.plugin.settings.autoSyncInterval = numValue * 1000;
              await this.plugin.saveSettings();

              // Restart auto-sync with new interval
              if (
                this.plugin.settings.autoSyncEnabled &&
                this.plugin.ws &&
                this.plugin.ws.readyState === WebSocket.OPEN
              ) {
                this.plugin.stopAutoSync();
                this.plugin.startAutoSync();
              }
            }
          }),
      );

    containerEl.createEl("h3", { text: "File Filtering" });

    new Setting(containerEl)
      .setName("Sync All File Types")
      .setDesc("Enable syncing of all file types (not just markdown)")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncAllFileTypes)
          .onChange(async (value) => {
            this.plugin.settings.syncAllFileTypes = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Use Extension Whitelist")
      .setDesc(
        "When enabled, only sync files with extensions in the whitelist. When disabled, sync all except blacklisted extensions.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useWhitelist)
          .onChange(async (value) => {
            this.plugin.settings.useWhitelist = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Extension Whitelist")
      .setDesc(
        "Comma-separated list of file extensions to sync (e.g., md,txt,pdf)",
      )
      .addText((text) =>
        text
          .setPlaceholder("md,txt,pdf,png,jpg")
          .setValue(this.plugin.settings.extensionWhitelist.join(","))
          .onChange(async (value) => {
            this.plugin.settings.extensionWhitelist = value
              .split(",")
              .map((ext) => ext.trim().toLowerCase());
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Extension Blacklist")
      .setDesc("Comma-separated list of file extensions to exclude from sync")
      .addText((text) =>
        text
          .setPlaceholder("tmp,log,cache")
          .setValue(this.plugin.settings.extensionBlacklist.join(","))
          .onChange(async (value) => {
            this.plugin.settings.extensionBlacklist = value
              .split(",")
              .map((ext) => ext.trim().toLowerCase());
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Excluded Folders")
      .setDesc("Comma-separated list of folder paths to exclude from sync")
      .addText((text) =>
        text
          .setPlaceholder(".obsidian,.trash,.git")
          .setValue(this.plugin.settings.excludedFolders.join(","))
          .onChange(async (value) => {
            this.plugin.settings.excludedFolders = value
              .split(",")
              .map((folder) => folder.trim());
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("h3", { text: "Performance & Limits" });

    new Setting(containerEl)
      .setName("Chunk Size (KB)")
      .setDesc("File size threshold for chunking large files")
      .addText((text) =>
        text
          .setPlaceholder("28")
          .setValue(this.plugin.settings.chunkSizeKB.toString())
          .onChange(async (value) => {
            const numValue = Number.parseInt(value) || 28;
            if (numValue >= 1 && numValue <= 1024) {
              this.plugin.settings.chunkSizeKB = numValue;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Batch Size")
      .setDesc(
        "Number of files to process simultaneously during bulk operations",
      )
      .addText((text) =>
        text
          .setPlaceholder("3")
          .setValue(this.plugin.settings.batchSize.toString())
          .onChange(async (value) => {
            const numValue = Number.parseInt(value) || 3;
            if (numValue >= 1 && numValue <= 20) {
              this.plugin.settings.batchSize = numValue;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Max File Size (MB)")
      .setDesc("Maximum file size allowed for sync (0 = no limit)")
      .addText((text) =>
        text
          .setPlaceholder("100")
          .setValue(this.plugin.settings.maxFileSizeMB.toString())
          .onChange(async (value) => {
            const numValue = Number.parseInt(value) || 100;
            if (numValue >= 0 && numValue <= 1000) {
              this.plugin.settings.maxFileSizeMB = numValue;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("File Size Warning (MB)")
      .setDesc("Show warning when syncing files larger than this size")
      .addText((text) =>
        text
          .setPlaceholder("5")
          .setValue(this.plugin.settings.fileSizeWarningMB.toString())
          .onChange(async (value) => {
            const numValue = Number.parseInt(value) || 5;
            if (numValue >= 0 && numValue <= 100) {
              this.plugin.settings.fileSizeWarningMB = numValue;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Max Retry Attempts")
      .setDesc("Maximum number of connection retry attempts")
      .addText((text) =>
        text
          .setPlaceholder("5")
          .setValue(this.plugin.settings.maxRetryAttempts.toString())
          .onChange(async (value) => {
            const numValue = Number.parseInt(value) || 5;
            if (numValue >= 1 && numValue <= 20) {
              this.plugin.settings.maxRetryAttempts = numValue;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Operation Timeout (ms)")
      .setDesc("Timeout for upload/download operations")
      .addText((text) =>
        text
          .setPlaceholder("10000")
          .setValue(this.plugin.settings.operationTimeoutMs.toString())
          .onChange(async (value) => {
            const numValue = Number.parseInt(value) || 10000;
            if (numValue >= 1000 && numValue <= 60000) {
              this.plugin.settings.operationTimeoutMs = numValue;
              await this.plugin.saveSettings();
            }
          }),
      );

    containerEl.createEl("h3", { text: "Debug & Development" });

    new Setting(containerEl)
      .setName("Enable Debug Logging")
      .setDesc("Show detailed console logs for troubleshooting")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableDebugLogging)
          .onChange(async (value) => {
            this.plugin.settings.enableDebugLogging = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Show Performance Metrics")
      .setDesc("Display sync timing and performance information")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showPerformanceMetrics)
          .onChange(async (value) => {
            this.plugin.settings.showPerformanceMetrics = value;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("h3", { text: "Instructions" });

    const instructions = containerEl.createEl("div");
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

			<p><strong>Three Types of Sync:</strong></p>
			<ol>
				<li><strong>🎯 Real-time Sync</strong> - Files sync automatically when you edit them (always on when connected)</li>
				<li><strong>🔄 Background Auto-Sync</strong> - Periodic checks for missing/changed files (optional, configurable interval)</li>
				<li><strong>⚡ Manual Smart Sync</strong> - Full bidirectional sync with conflict resolution (triggered via commands)</li>
			</ol>

			<p><strong>Commands (Ctrl/Cmd+P):</strong></p>
			<ul>
				<li><strong>Sync: Smart sync</strong> - ⭐ Full bidirectional sync with conflict resolution</li>
				<li><strong>Sync: Toggle auto-sync</strong> - Enable/disable background auto-sync</li>
				<li><strong>Sync: Check sync status</strong> - Compare local vs cloud files</li>
				<li><strong>Sync: Upload active file</strong> - Manual upload of current file</li>
				<li><strong>Sync: Download active file</strong> - Manual download of current file</li>
			</ul>

			<p><strong>💡 Pro Tips:</strong></p>
			<ul>
				<li>Real-time sync handles your daily editing automatically</li>
				<li>Enable background auto-sync for multi-device scenarios</li>
				<li>Use Smart Sync to resolve conflicts and ensure everything is in sync</li>
				<li>Adjust debounce delay if you want faster/slower real-time sync</li>
			</ul>
		`;
  }
}

class ConflictResolutionModal extends Modal {
  private conflicts: ConflictFile[];
  private resolutions: ConflictResolution[] = [];
  private currentIndex = 0;
  private plugin: ObsidianSyncPlugin;
  private onResolve: (resolutions: ConflictResolution[]) => void;

  constructor(
    app: App,
    plugin: ObsidianSyncPlugin,
    conflicts: ConflictFile[],
    onResolve: (resolutions: ConflictResolution[]) => void,
  ) {
    super(app);
    this.plugin = plugin;
    this.conflicts = conflicts;
    this.onResolve = onResolve;
  }

  onOpen() {
    this.displayConflict();
  }

  onClose() {
    this.contentEl.empty();
  }

  private displayConflict() {
    this.contentEl.empty();

    if (this.currentIndex >= this.conflicts.length) {
      // All conflicts resolved
      this.close();
      this.onResolve(this.resolutions);
      return;
    }

    const conflict = this.conflicts[this.currentIndex];
    const { contentEl } = this;

    // Title
    contentEl.createEl("h2", { text: "Sync Conflict Detected" });

    // Progress indicator
    const progressEl = contentEl.createEl("p", {
      text: `Conflict ${this.currentIndex + 1} of ${this.conflicts.length}`,
    });
    progressEl.style.color = "var(--text-muted)";

    // File path
    contentEl.createEl("h3", { text: `File: ${conflict.filePath}` });

    // Conflict explanation
    const explanationEl = contentEl.createEl("div");
    explanationEl.innerHTML = `
			<p>This file has been modified both locally and in the cloud:</p>
			<ul>
				<li><strong>Local version:</strong> Modified ${new Date(conflict.localModified).toLocaleString()}</li>
				<li><strong>Cloud version:</strong> Modified ${new Date(conflict.cloudModified).toLocaleString()}</li>
			</ul>
			<p>Choose which version to keep:</p>
		`;

    // Buttons container
    const buttonsEl = contentEl.createEl("div");
    buttonsEl.style.display = "flex";
    buttonsEl.style.gap = "10px";
    buttonsEl.style.marginTop = "20px";
    buttonsEl.style.justifyContent = "center";

    // Keep Local button
    const keepLocalBtn = buttonsEl.createEl("button", {
      text: "Keep Local Version",
    });
    keepLocalBtn.style.padding = "10px 20px";
    keepLocalBtn.style.backgroundColor = "var(--interactive-accent)";
    keepLocalBtn.style.color = "var(--text-on-accent)";
    keepLocalBtn.style.border = "none";
    keepLocalBtn.style.borderRadius = "4px";
    keepLocalBtn.style.cursor = "pointer";

    keepLocalBtn.onclick = () => {
      this.resolveConflict("local");
    };

    // Use Cloud button
    const useCloudBtn = buttonsEl.createEl("button", {
      text: "Use Cloud Version",
    });
    useCloudBtn.style.padding = "10px 20px";
    useCloudBtn.style.backgroundColor = "var(--interactive-normal)";
    useCloudBtn.style.color = "var(--text-normal)";
    useCloudBtn.style.border = "1px solid var(--background-modifier-border)";
    useCloudBtn.style.borderRadius = "4px";
    useCloudBtn.style.cursor = "pointer";

    useCloudBtn.onclick = () => {
      this.resolveConflict("cloud");
    };

    // Show preview if content is available (for text files)
    if (conflict.localContent && conflict.cloudContent) {
      const previewEl = contentEl.createEl("div");
      previewEl.style.marginTop = "20px";

      const localPreview = previewEl.createEl("div");
      localPreview.innerHTML = `
				<h4>Local Content Preview:</h4>
				<pre style="background: var(--background-secondary); padding: 10px; border-radius: 4px; max-height: 200px; overflow-y: auto;">${this.escapeHtml(conflict.localContent.substring(0, 500))}${conflict.localContent.length > 500 ? "..." : ""}</pre>
			`;

      const cloudPreview = previewEl.createEl("div");
      cloudPreview.innerHTML = `
				<h4>Cloud Content Preview:</h4>
				<pre style="background: var(--background-secondary); padding: 10px; border-radius: 4px; max-height: 200px; overflow-y: auto;">${this.escapeHtml(conflict.cloudContent.substring(0, 500))}${conflict.cloudContent.length > 500 ? "..." : ""}</pre>
			`;
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  private resolveConflict(choice: "local" | "cloud") {
    const conflict = this.conflicts[this.currentIndex];
    this.resolutions.push({
      filePath: conflict.filePath,
      choice: choice,
    });

    this.currentIndex++;
    this.displayConflict();
  }
}
