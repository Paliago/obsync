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

  // Download promise tracking
  private pendingDownloads: Map<string, (success: boolean) => void> = new Map();

  // Settings deleted files callback
  private pendingSettingsDeletedFilesCallback:
    | ((files: Record<string, any>) => void)
    | null = null;

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

    this.addCommand({
      id: "view-deleted-files",
      name: "View deleted files",
      callback: () => {
        this.viewDeletedFiles();
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
        // Use the local file's timestamp as the sync reference point
        if (data.filePath) {
          const file = this.app.vault.getAbstractFileByPath(data.filePath);
          if (file instanceof TFile) {
            this.lastModifiedTimes.set(data.filePath, file.stat.mtime);
            this.debouncedSaveSettings(); // Persist the tracking
          }
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
          // Resolve pending download promise
          if (this.pendingDownloads.has(data.filePath)) {
            const resolve = this.pendingDownloads.get(data.filePath);
            this.pendingDownloads.delete(data.filePath);
            resolve?.(true);
          }
        }
        break;

      case "file_list":
        if (data.files) {
          this.handleFileListResponse(data.files);
        }
        break;

      case "file_changed":
        if (data.filePath) {
          if (data.action === "upload") {
            new Notice(`File updated by another client: ${data.filePath}`);
            // Auto-download the updated file to keep devices in sync
            this.downloadFile(data.filePath);
          } else if (data.action === "delete") {
            new Notice(`File deleted by another client: ${data.filePath}`);
            // Delete the file locally to keep devices in sync
            const file = this.app.vault.getAbstractFileByPath(data.filePath);
            if (file instanceof TFile) {
              console.log(
                `Deleting file locally due to remote deletion: ${data.filePath}`,
              );
              this.fileWatchingEnabled = false; // Temporarily disable to prevent loop
              this.app.vault
                .delete(file)
                .then(() => {
                  // Remove from tracking
                  this.lastModifiedTimes.delete(data.filePath!);
                  this.debouncedSaveSettings();
                  // Re-enable file watching after a short delay
                  setTimeout(() => {
                    this.fileWatchingEnabled = true;
                  }, 1000);
                })
                .catch((error) => {
                  console.error(
                    `Failed to delete file locally: ${data.filePath}`,
                    error,
                  );
                  this.fileWatchingEnabled = true;
                });
            }
          }
        }
        break;

      case "delete_success":
        if (data.filePath) {
          new Notice(`File deleted from cloud: ${data.filePath}`);
          console.log(`File deleted successfully: ${data.filePath}`);
        }
        break;

      case "deleted_files_list":
        if (data.files) {
          this.handleDeletedFilesListResponse(data.files);
        }
        break;

      case "restore_success":
        if (data.filePath) {
          new Notice(`File restored: ${data.filePath}`);
          console.log(`File restored successfully: ${data.filePath}`);
          // Refresh the file list to show the restored file
          this.listCloudFiles();
        }
        break;

      case "error":
        new Notice(`Sync error: ${data.message}`);
        console.error("WebSocket error:", data.message);
        // If this is a download error, resolve any pending download promises
        if (data.filePath && this.pendingDownloads.has(data.filePath)) {
          const resolve = this.pendingDownloads.get(data.filePath);
          this.pendingDownloads.delete(data.filePath);
          resolve?.(false);
        }
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

      // Send the upload message
      const success = this.sendWebSocketMessage({
        action: "upload",
        filePath: filePath,
        content: fileContent,
        fileType: fileType,
        lastModified: file.stat.mtime,
      });

      if (!success) {
        throw new Error("Failed to send upload message");
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

  downloadFile(filePath: string): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      new Notice("Not connected to real-time sync");
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      try {
        this.updateStatusBar("Downloading...", "syncing");

        // Store the resolve function to call when download completes
        if (!this.pendingDownloads) {
          this.pendingDownloads = new Map();
        }
        this.pendingDownloads.set(filePath, resolve);

        const success = this.sendWebSocketMessage({
          action: "download",
          filePath: filePath,
        });

        if (success) {
          console.log(`Downloading file: ${filePath}`);
        } else {
          new Notice(`Failed to request download for: ${filePath}`);
          this.pendingDownloads.delete(filePath);
          resolve(false);
          return;
        }

        // Set timeout to detect if download fails
        setTimeout(() => {
          if (this.pendingDownloads?.has(filePath)) {
            console.error(`Download timeout for ${filePath}`);
            this.pendingDownloads.delete(filePath);
            resolve(false);
          }
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.updateStatusBar("Connected", "connected");
          }
        }, this.settings.operationTimeoutMs);
      } catch (error) {
        console.error(`Error downloading file ${filePath}:`, error);
        new Notice(`Failed to download ${filePath}: ${(error as any).message}`);
        if (this.pendingDownloads?.has(filePath)) {
          this.pendingDownloads.delete(filePath);
        }
        resolve(false);
      }
    });
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
        // Update last known sync time to the cloud's timestamp to prevent sync loop
        // This tracks when we last synced, not the local file's timestamp
        if (lastModified) {
          this.lastModifiedTimes.set(filePath, lastModified);
        }
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
        if (newFile instanceof TFile && lastModified) {
          // Track the cloud's timestamp as our last sync time
          this.lastModifiedTimes.set(filePath, lastModified);
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

  private handleDeletedFilesListResponse(files: Record<string, any>) {
    console.log("Received deleted files list:", files);

    // Check if this is for settings display
    if (this.pendingSettingsDeletedFilesCallback) {
      this.pendingSettingsDeletedFilesCallback(files);
      this.pendingSettingsDeletedFilesCallback = null;
      return;
    }

    const deletedFilesList = Object.keys(files);

    if (deletedFilesList.length === 0) {
      new Notice("No deleted files found");
      return;
    }

    // Create a modal to show deleted files with restore options
    const modal = new DeletedFilesModal(this.app, files, (filePath: string) => {
      this.restoreFile(filePath);
    });
    modal.open();
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

        // Check if file has been modified since last sync
        const lastKnownTime = this.lastModifiedTimes.get(file.path);
        const localModified = file.stat.mtime > (lastKnownTime || 0);
        const cloudModified = cloudLastModified > (lastKnownTime || 0);

        if (localModified || cloudModified) {
          outOfSyncFiles.push(file.path);
          console.log(`📝 OUT OF SYNC: ${file.path}`);
          console.log(`  - File modified: ${new Date(file.stat.mtime)}`);
          console.log(
            `  - Last known sync: ${lastKnownTime ? new Date(lastKnownTime) : "Never"}`,
          );
          console.log(
            `  - Cloud version: ${cloudVersion}, modified: ${new Date(cloudLastModified)}`,
          );
          console.log(
            `  - Local modified: ${localModified}, Cloud modified: ${cloudModified}`,
          );
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

  private async processSmartSync(
    cloudFiles: Record<string, any>,
    options: {
      isBackground?: boolean;
      maxFiles?: number;
      showConflicts?: boolean;
      rateLimitMs?: number;
    } = {},
  ) {
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
        // If we don't have a lastKnownTime, this is the first sync - not a conflict
        if (!lastKnownTime) {
          // First time seeing this file - determine which version to use based on timestamps
          const timeDiff = Math.abs(file.stat.mtime - cloudLastModified);
          const significantDifference = timeDiff > 1000; // 1 second threshold

          if (significantDifference && file.stat.mtime > cloudLastModified) {
            filesToUpload.push(file);
            console.log(
              `📤 WILL UPLOAD: ${file.path} (first sync, local newer - local: ${new Date(file.stat.mtime)}, cloud: ${new Date(cloudLastModified)})`,
            );
          } else if (
            significantDifference &&
            cloudLastModified > file.stat.mtime
          ) {
            filesToDownload.push(file.path);
            console.log(
              `📥 WILL DOWNLOAD: ${file.path} (first sync, cloud newer - local: ${new Date(file.stat.mtime)}, cloud: ${new Date(cloudLastModified)})`,
            );
          } else {
            // Files are essentially the same, just track them
            console.log(
              `✅ IN SYNC: ${file.path} (first sync, timestamps similar - local: ${new Date(file.stat.mtime)}, cloud: ${new Date(cloudLastModified)}, diff: ${timeDiff}ms)`,
            );
          }
        } else {
          // We have tracking info, check for real conflicts
          const localModified = file.stat.mtime > lastKnownTime;
          const cloudModified = cloudLastModified > lastKnownTime;

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
          } else if (localModified && !cloudModified) {
            // Only local has changes since last sync, upload it
            filesToUpload.push(file);
            console.log(
              `📤 WILL UPLOAD: ${file.path} (only local modified - local: ${new Date(file.stat.mtime)}, cloud: ${new Date(cloudLastModified)}, last sync: ${new Date(lastKnownTime)})`,
            );
          } else if (cloudModified && !localModified) {
            // Only cloud has changes since last sync, download it
            filesToDownload.push(file.path);
            console.log(
              `📥 WILL DOWNLOAD: ${file.path} (only cloud modified - local: ${new Date(file.stat.mtime)}, cloud: ${new Date(cloudLastModified)}, last sync: ${new Date(lastKnownTime)})`,
            );
          } else if (!localModified && !cloudModified) {
            // Neither has changed since last sync - files should be in sync
            // Only check for significant timestamp differences (more than 1 second) to avoid
            // unnecessary syncing due to minor timestamp variations
            const timeDiff = Math.abs(file.stat.mtime - cloudLastModified);
            const significantDifference = timeDiff > 1000; // 1 second threshold

            if (significantDifference && file.stat.mtime > cloudLastModified) {
              // Local is significantly newer but wasn't marked as modified
              filesToUpload.push(file);
              console.log(
                `📤 WILL UPLOAD: ${file.path} (local significantly newer - local: ${new Date(file.stat.mtime)}, cloud: ${new Date(cloudLastModified)}, diff: ${timeDiff}ms)`,
              );
            } else if (
              significantDifference &&
              cloudLastModified > file.stat.mtime
            ) {
              // Cloud is significantly newer but wasn't marked as modified
              filesToDownload.push(file.path);
              console.log(
                `📥 WILL DOWNLOAD: ${file.path} (cloud significantly newer - local: ${new Date(file.stat.mtime)}, cloud: ${new Date(cloudLastModified)}, diff: ${timeDiff}ms)`,
              );
            } else {
              // Files are in sync (or difference is negligible)
              console.log(
                `✅ IN SYNC: ${file.path} (local: ${new Date(file.stat.mtime)}, cloud: ${new Date(cloudLastModified)}, diff: ${timeDiff}ms)`,
              );
            }
          }
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
      console.log(`Found ${conflicts.length} conflicts...`);

      // For background sync, skip conflicts and just log them
      if (options.isBackground) {
        new Notice(
          `Background sync: Skipping ${conflicts.length} conflicts. Use manual Smart Sync to resolve.`,
        );
        // Remove conflicts from sync operations
        conflicts.forEach((conflict) => {
          const uploadIndex = filesToUpload.findIndex(
            (f) => f.path === conflict.filePath,
          );
          const downloadIndex = filesToDownload.findIndex(
            (path) => path === conflict.filePath,
          );
          if (uploadIndex >= 0) filesToUpload.splice(uploadIndex, 1);
          if (downloadIndex >= 0) filesToDownload.splice(downloadIndex, 1);
        });
      } else {
        // For manual sync, show conflict resolution dialog
        console.log("Showing conflict resolution dialog...");

        // Load content for text file conflicts to show preview
        for (const conflict of conflicts) {
          const localFile = localFiles.find(
            (f) => f.path === conflict.filePath,
          );
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
            await this.executeSyncOperations(
              filesToUpload,
              filesToDownload,
              options,
            );
          },
        );

        modal.open();
        return; // Exit early, modal callback will continue the sync
      }
    }

    // No conflicts, proceed with normal sync
    await this.executeSyncOperations(filesToUpload, filesToDownload, options);
  }

  private async executeSyncOperations(
    filesToUpload: TFile[],
    filesToDownload: string[],
    options: {
      isBackground?: boolean;
      maxFiles?: number;
      showConflicts?: boolean;
      rateLimitMs?: number;
    } = {},
  ) {
    // Apply limits for background sync
    const maxFiles = options.maxFiles || Number.MAX_SAFE_INTEGER;
    const rateLimitMs = options.rateLimitMs || 500;
    const isBackground = options.isBackground || false;

    // Limit files for background sync
    const limitedFilesToUpload = isBackground
      ? filesToUpload.slice(0, maxFiles)
      : filesToUpload;
    const limitedFilesToDownload = isBackground
      ? filesToDownload.slice(0, maxFiles)
      : filesToDownload;

    const totalOperations =
      limitedFilesToUpload.length + limitedFilesToDownload.length;
    if (totalOperations === 0) {
      if (!isBackground) {
        new Notice("✅ All files are already in sync");
      }
      this.isBulkSyncing = false;
      this.updateStatusBar("Connected", "connected");
      return;
    }

    this.syncProgress = { current: 0, total: totalOperations };
    const syncType = isBackground ? "Background sync" : "Smart sync";
    console.log(
      `${syncType}: ${limitedFilesToUpload.length} uploads, ${limitedFilesToDownload.length} downloads`,
    );

    // Process uploads first (in batches or individually for background)
    const batchSize = isBackground ? 1 : this.settings.batchSize;
    for (let i = 0; i < limitedFilesToUpload.length; i += batchSize) {
      const batch = limitedFilesToUpload.slice(i, i + batchSize);

      if (isBackground) {
        // Sequential processing for background sync
        for (const file of batch) {
          try {
            await this.uploadFile(file.path);
            this.syncProgress.current++;
            await new Promise((resolve) => setTimeout(resolve, rateLimitMs));
          } catch (error) {
            console.error(
              `Background sync upload failed for ${file.path}:`,
              error,
            );
          }
        }
      } else {
        // Parallel processing for manual sync
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

        if (i + batchSize < limitedFilesToUpload.length) {
          await new Promise((resolve) => setTimeout(resolve, rateLimitMs));
        }
      }
    }

    // Process downloads
    if (isBackground) {
      // Sequential processing for background sync
      for (const filePath of limitedFilesToDownload) {
        try {
          await this.downloadFile(filePath);
          await new Promise((resolve) => setTimeout(resolve, rateLimitMs));
        } catch (error) {
          console.error(
            `Background sync download failed for ${filePath}:`,
            error,
          );
        }
      }
    } else {
      // Batch processing for manual sync
      for (let i = 0; i < limitedFilesToDownload.length; i += batchSize) {
        const batch = limitedFilesToDownload.slice(i, i + batchSize);

        await Promise.all(
          batch.map(async (filePath) => {
            try {
              await this.downloadFile(filePath);
              this.syncProgress.current++;
              this.updateStatusBar("Smart syncing", "syncing");
            } catch (error) {
              console.error(`Failed to download file ${filePath}:`, error);
            }
          }),
        );

        if (i + batchSize < limitedFilesToDownload.length) {
          await new Promise((resolve) => setTimeout(resolve, rateLimitMs));
        }
      }
    }

    // Show completion notice
    if (isBackground) {
      if (
        limitedFilesToUpload.length > 0 ||
        limitedFilesToDownload.length > 0
      ) {
        console.log(
          `Background sync completed: ${limitedFilesToUpload.length} uploaded, ${limitedFilesToDownload.length} downloaded`,
        );
      }
    } else {
      new Notice(
        `Smart sync completed: ${limitedFilesToUpload.length} uploaded, ${limitedFilesToDownload.length} downloaded`,
      );
    }

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

    console.log("Performing background smart sync...");

    // Use the same smart sync logic but with background-specific options
    await this.processSmartSync(cloudFiles, {
      isBackground: true,
      maxFiles: 5,
      showConflicts: false,
      rateLimitMs: 1000,
    });

    this.isAutoSyncing = false;
  }

  private getAllLocalFiles(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter((file) => file instanceof TFile) as TFile[];
  }

  async viewDeletedFiles() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      new Notice("Not connected to real-time sync");
      return;
    }

    try {
      // Request deleted files list from server
      this.sendWebSocketMessage({
        action: "list_deleted",
      });

      new Notice("Fetching deleted files...");
    } catch (error) {
      console.error("Error requesting deleted files:", error);
      new Notice("Failed to fetch deleted files");
    }
  }

  async restoreFile(filePath: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      new Notice("Not connected to real-time sync");
      return;
    }

    try {
      this.sendWebSocketMessage({
        action: "restore",
        filePath: filePath,
      });

      new Notice(`Restoring file: ${filePath}`);
    } catch (error) {
      console.error("Error restoring file:", error);
      new Notice("Failed to restore file");
    }
  }

  async requestDeletedFilesForSettings(
    callback: (files: Record<string, any>) => void,
  ) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to real-time sync");
    }

    this.pendingSettingsDeletedFilesCallback = callback;

    try {
      this.sendWebSocketMessage({
        action: "list_deleted",
      });
    } catch (error) {
      this.pendingSettingsDeletedFilesCallback = null;
      throw error;
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
    const { containerEl } = this;

    containerEl.empty();

    // Connection Settings Section
    containerEl.createEl("h2", { text: "🔗 Connection Settings" });

    const connectionDesc = containerEl.createEl("p", {
      text: "Configure your sync server connection. Get these values from your SST deployment output.",
    });
    connectionDesc.style.color = "var(--text-muted)";
    connectionDesc.style.fontSize = "0.9em";
    connectionDesc.style.marginBottom = "20px";

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

    // Sync Behavior Section
    containerEl.createEl("h2", { text: "⚡ Sync Behavior" });

    const syncOverview = containerEl.createEl("div");
    syncOverview.innerHTML = `
      <p style="color: var(--text-muted); font-size: 0.9em; margin-bottom: 20px;">
        ObSync has two sync modes that work together:
      </p>
      <ul style="color: var(--text-muted); font-size: 0.9em; margin-bottom: 20px; padding-left: 20px;">
        <li><strong>Live Sync:</strong> Files sync instantly as you type (always active when connected)</li>
        <li><strong>Smart Sync:</strong> Bidirectional sync with conflict resolution (manual via commands, or automatic in background)</li>
      </ul>
    `;

    containerEl.createEl("h3", { text: "📝 Live Sync (File Watching)" });

    const liveDesc = containerEl.createEl("p", {
      text: "Automatically syncs files as you edit them. This is the primary sync method and is always active when connected.",
    });
    liveDesc.style.color = "var(--text-muted)";
    liveDesc.style.fontSize = "0.9em";
    liveDesc.style.marginBottom = "20px";

    new Setting(containerEl)
      .setName("Immediate Upload")
      .setDesc("Upload files instantly when changed (no typing delay)")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.instantSyncMode)
          .onChange(async (value) => {
            this.plugin.settings.instantSyncMode = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Typing Delay (ms)")
      .setDesc(
        "Wait time after you stop typing before uploading (ignored if Immediate Upload is enabled)",
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

    containerEl.createEl("h3", { text: "🔄 Background Smart Sync" });

    const backgroundDesc = containerEl.createEl("p", {
      text: "Periodically runs Smart Sync in the background to catch files that may have been missed by live sync or changed on other devices. Uses the same logic as manual Smart Sync but with conservative limits.",
    });
    backgroundDesc.style.color = "var(--text-muted)";
    backgroundDesc.style.fontSize = "0.9em";
    backgroundDesc.style.marginBottom = "20px";

    new Setting(containerEl)
      .setName("Enable Background Smart Sync")
      .setDesc(
        "Automatically run Smart Sync at regular intervals (max 5 files per run, skips conflicts)",
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
      .setName("Check Interval (seconds)")
      .setDesc("How often to check for missed changes")
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

    containerEl.createEl("h2", { text: "📁 File Filtering" });

    const filteringDesc = containerEl.createEl("p", {
      text: "Control which files and folders are included in sync operations.",
    });
    filteringDesc.style.color = "var(--text-muted)";
    filteringDesc.style.fontSize = "0.9em";
    filteringDesc.style.marginBottom = "20px";

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

    containerEl.createEl("h2", { text: "⚙️ Performance & Limits" });

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

    containerEl.createEl("h2", { text: "🔧 Debug & Development" });

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

    // Deleted Files Section
    containerEl.createEl("h2", { text: "🗑️ Deleted Files" });

    const deletedDesc = containerEl.createEl("p", {
      text: "View and restore files that have been deleted. Files are kept for 30 days before permanent deletion.",
    });
    deletedDesc.style.color = "var(--text-muted)";
    deletedDesc.style.fontSize = "0.9em";
    deletedDesc.style.marginBottom = "20px";

    // Container for deleted files list
    const deletedFilesContainer = containerEl.createEl("div");
    deletedFilesContainer.id = "deleted-files-container";
    deletedFilesContainer.style.border =
      "1px solid var(--background-modifier-border)";
    deletedFilesContainer.style.borderRadius = "8px";
    deletedFilesContainer.style.padding = "15px";
    deletedFilesContainer.style.marginBottom = "20px";
    deletedFilesContainer.style.backgroundColor = "var(--background-secondary)";

    // Initial loading state
    deletedFilesContainer.createEl("p", {
      text: "Click 'Refresh Deleted Files' to load deleted files list",
      cls: "deleted-files-placeholder",
    });

    new Setting(containerEl)
      .setName("Refresh Deleted Files")
      .setDesc("Load the current list of deleted files from the server")
      .addButton((button) =>
        button
          .setButtonText("Refresh")
          .setCta()
          .onClick(async () => {
            await this.refreshDeletedFiles(deletedFilesContainer);
          }),
      );

    containerEl.createEl("h2", { text: "📖 Quick Start Guide" });

    const instructions = containerEl.createEl("div");
    instructions.innerHTML = `
			<div style="background: var(--background-secondary); padding: 15px; border-radius: 8px; margin-bottom: 20px;">
				<p><strong>🚀 Getting Started:</strong></p>
				<ol style="margin: 10px 0; padding-left: 20px;">
					<li>Enter your WebSocket URL and API Key above</li>
					<li>Click the sync status indicator in the status bar to connect</li>
					<li>Files will sync automatically as you edit them!</li>
				</ol>
			</div>
			
			<p><strong>Status Bar Indicators:</strong></p>
			<ul style="margin: 10px 0; padding-left: 20px;">
				<li>🟢 <strong>Connected</strong> - Live sync active</li>
				<li>🔴 <strong>Disconnected</strong> - Click to connect</li>
				<li>🔵 <strong>Syncing</strong> - Processing files</li>
				<li>🟡 <strong>Error</strong> - Connection issues</li>
			</ul>

			<p><strong>Available Commands (Ctrl/Cmd+P):</strong></p>
			<ul style="margin: 10px 0; padding-left: 20px;">
				<li><strong>Sync: Smart sync</strong> - Full bidirectional sync with conflict resolution</li>
				<li><strong>Sync: Check sync status</strong> - Compare local vs cloud files</li>
				<li><strong>Sync: Upload/Download active file</strong> - Manual file operations</li>
				<li><strong>Sync: Toggle background sync</strong> - Enable/disable periodic checks</li>
			</ul>
			
			<div style="background: var(--background-modifier-border); padding: 10px; border-radius: 6px; margin-top: 15px;">
				<p style="margin: 0; font-size: 0.9em; color: var(--text-muted);">
					<strong>💡 Tip:</strong> Live sync handles most scenarios automatically. Use Smart Sync when you need to resolve conflicts or sync after being offline.
				</p>
			</div>

			<p><strong>💡 Pro Tips:</strong></p>
			<ul>
				<li>Real-time sync handles your daily editing automatically</li>
				<li>Enable background auto-sync for multi-device scenarios</li>
				<li>Use Smart Sync to resolve conflicts and ensure everything is in sync</li>
				<li>Adjust debounce delay if you want faster/slower real-time sync</li>
			</ul>
		`;
  }

  private async refreshDeletedFiles(container: HTMLElement) {
    if (!this.plugin.ws || this.plugin.ws.readyState !== WebSocket.OPEN) {
      container.empty();
      container.createEl("p", {
        text: "❌ Not connected to sync server. Please connect first.",
        cls: "deleted-files-error",
      });
      return;
    }

    // Show loading state
    container.empty();
    container.createEl("p", {
      text: "🔄 Loading deleted files...",
      cls: "deleted-files-loading",
    });

    try {
      await this.plugin.requestDeletedFilesForSettings((deletedFiles) => {
        this.displayDeletedFiles(container, deletedFiles);
      });
    } catch (error) {
      console.error("Error fetching deleted files:", error);
      container.empty();
      container.createEl("p", {
        text: "❌ Failed to load deleted files. Please try again.",
        cls: "deleted-files-error",
      });
    }
  }

  private displayDeletedFiles(
    container: HTMLElement,
    deletedFiles: Record<string, any>,
  ) {
    container.empty();

    const filesList = Object.keys(deletedFiles);

    if (filesList.length === 0) {
      container.createEl("p", {
        text: "✅ No deleted files found.",
        cls: "deleted-files-empty",
      });
      return;
    }

    // Header with count
    const headerEl = container.createEl("div");
    headerEl.style.marginBottom = "15px";
    headerEl.createEl("strong", {
      text: `Found ${filesList.length} deleted file(s)`,
    });
    headerEl.createEl("p", {
      text: "Files will be permanently deleted after 30 days.",
      cls: "deleted-files-note",
    });

    // Files list
    const listEl = container.createEl("div");
    listEl.style.maxHeight = "300px";
    listEl.style.overflowY = "auto";
    listEl.style.border = "1px solid var(--background-modifier-border-hover)";
    listEl.style.borderRadius = "4px";

    filesList.forEach((filePath, index) => {
      const fileInfo = deletedFiles[filePath];
      const fileEl = listEl.createEl("div");
      fileEl.style.display = "flex";
      fileEl.style.justifyContent = "space-between";
      fileEl.style.alignItems = "center";
      fileEl.style.padding = "12px";
      if (index < filesList.length - 1) {
        fileEl.style.borderBottom =
          "1px solid var(--background-modifier-border-hover)";
      }

      const infoEl = fileEl.createEl("div");
      infoEl.style.flex = "1";
      infoEl.style.minWidth = "0";

      const pathEl = infoEl.createEl("div", {
        text: filePath,
        cls: "deleted-file-path",
      });
      pathEl.style.fontWeight = "500";
      pathEl.style.marginBottom = "4px";
      pathEl.style.wordBreak = "break-all";

      const deletedDate = new Date(fileInfo.deletedAt).toLocaleString();
      const expiresDate = new Date(fileInfo.expireAt * 1000).toLocaleString();

      const metaEl = infoEl.createEl("small", {
        text: `Deleted: ${deletedDate} | Expires: ${expiresDate}`,
        cls: "deleted-file-meta",
      });
      metaEl.style.color = "var(--text-muted)";
      metaEl.style.fontSize = "0.8em";

      const restoreBtn = fileEl.createEl("button", {
        text: "Restore",
        cls: "mod-cta",
      });
      restoreBtn.style.marginLeft = "10px";
      restoreBtn.style.flexShrink = "0";

      restoreBtn.onclick = async () => {
        restoreBtn.disabled = true;
        restoreBtn.textContent = "Restoring...";

        try {
          await this.plugin.restoreFile(filePath);
          // Refresh the list after restore
          setTimeout(() => {
            this.refreshDeletedFiles(container);
          }, 1000);
        } catch (error) {
          restoreBtn.disabled = false;
          restoreBtn.textContent = "Restore";
          console.error("Error restoring file:", error);
        }
      };
    });
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

class DeletedFilesModal extends Modal {
  private deletedFiles: Record<string, any>;
  private onRestore: (filePath: string) => void;

  constructor(
    app: App,
    deletedFiles: Record<string, any>,
    onRestore: (filePath: string) => void,
  ) {
    super(app);
    this.deletedFiles = deletedFiles;
    this.onRestore = onRestore;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Deleted Files" });

    const filesList = Object.keys(this.deletedFiles);

    if (filesList.length === 0) {
      contentEl.createEl("p", { text: "No deleted files found." });
      return;
    }

    contentEl.createEl("p", {
      text: `Found ${filesList.length} deleted file(s). Files will be permanently deleted after 30 days.`,
    });

    const listEl = contentEl.createEl("div");
    listEl.style.maxHeight = "400px";
    listEl.style.overflowY = "auto";
    listEl.style.border = "1px solid var(--background-modifier-border)";
    listEl.style.borderRadius = "4px";
    listEl.style.padding = "10px";
    listEl.style.marginTop = "10px";

    filesList.forEach((filePath) => {
      const fileInfo = this.deletedFiles[filePath];
      const fileEl = listEl.createEl("div");
      fileEl.style.display = "flex";
      fileEl.style.justifyContent = "space-between";
      fileEl.style.alignItems = "center";
      fileEl.style.padding = "8px";
      fileEl.style.borderBottom =
        "1px solid var(--background-modifier-border-hover)";

      const infoEl = fileEl.createEl("div");
      infoEl.createEl("div", {
        text: filePath,
        cls: "deleted-file-path",
      });

      const deletedDate = new Date(fileInfo.deletedAt).toLocaleString();
      const expiresDate = new Date(fileInfo.expireAt * 1000).toLocaleString();

      infoEl.createEl("small", {
        text: `Deleted: ${deletedDate} | Expires: ${expiresDate}`,
        cls: "deleted-file-meta",
      });

      const restoreBtn = fileEl.createEl("button", {
        text: "Restore",
        cls: "mod-cta",
      });

      restoreBtn.onclick = () => {
        this.onRestore(filePath);
        this.close();
      };
    });

    // Close button
    const closeBtn = contentEl.createEl("button", {
      text: "Close",
      cls: "mod-cta",
    });
    closeBtn.style.marginTop = "20px";
    closeBtn.onclick = () => this.close();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
