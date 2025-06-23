# Obsidian MD Sync Engine

This is a personal, "self-hosted" (on AWS but your personal account) Obsidian.md sync engine that is made for a single user (me).
The project consists of a backend and an obsidian plugin.

### Milestone 1: Project Setup & Foundations

The goal here is to create the project structure and deploy the absolute bare minimum of cloud infrastructure.

-   [x] **Project Repository**
    -   [x] Initialize a Git repository.
    -   [x] Create a monorepo structure with two main packages: `packages/backend` and `packages/plugin`.
    -   [x] Initialize biome.
-   [x] **Backend Setup (SST)**
        -   [x] sst.config.ts has the infra
        -   [x] **Amazon S3:** Create one S3 bucket to store all the vault files.
        -   [x] **Amazon DynamoDB:** Create one DynamoDB table
-   [x] **Plugin Setup**
    -   [x] Add the obsidian sample plugin to `obsidian-sample-plugin`

---

### Milestone 2: Backend - Core File Operations & Auth

This milestone focuses on building the stateless, request/response part of the backend using a Lambda Function URL. At the end of this, you'll be able to upload and download files using a tool like Postman.

-   [x] **Implement Lambda Endpoints**
    -   [x] **File Download:** Create logic to handle a `GET` request with a file path. It should read the file from S3 and return its content.
    -   [x] **File List:** Create logic to handle a `GET /versions` request. It should query DynamoDB for all files belonging to the authenticated user and return a simple map of `filePath: version`.
-   [x] **Testing**
    -   [x] Create an .md file to test with
    -   [x] Use curl to test the functionality thus far

---

### Milestone 3: Plugin - Manual Sync & Settings

Now, let's make the plugin talk to the backend. We'll skip automatic sync for now and focus on user-triggered actions.

-   [x] **Plugin UI**
    -   [x] Create a "Settings" tab for your plugin in Obsidian.
    -   [x] Add fields for the user to enter their username, password, and the Lambda Function URL.
-   [x] **Manual Sync Commands**
    -   [x] Add two commands to the Obsidian command palette:
        -   `Sync: Upload active file to cloud`
        -   `Sync: Download active file from cloud`
    -   [x] **Bonus**: Added `Sync: List files in cloud` command
-   [x] **Testing**
    -   [x] Built the plugin successfully (generates `main.js`)
    -   [x] Backend API supports file upload, download, and listing
    -   [x] Verified complete upload → list → download workflow via API testing

---

### Milestone 4: Real-time Sync Engine (WebSockets)

**Context**: Milestone 3 revealed CORS issues with Lambda Function URLs when called from Obsidian (`app://obsidian.md` origin). Backend operations work perfectly (uploads/downloads succeed), but browser blocks responses due to duplicate CORS headers. WebSockets will solve this by bypassing HTTP CORS entirely and enabling true real-time sync.

**Current State**: 
- ✅ Backend: Upload, download, list operations working via Lambda Function URL
- ✅ Plugin: Manual commands implemented, build pipeline established (`bun run deploy-plugin`)
- ❌ CORS blocking browser responses (server operations still succeed)
- 📍 Files: `packages/plugin/` (main location), SST infrastructure deployed

This milestone implements WebSocket-based real-time sync to replace HTTP-based manual sync.

-   [x] **Backend WebSocket API (SST)**
    -   [x] Add **API Gateway WebSocket API** to `sst.config.ts`
    -   [x] Create **three new Lambda functions** in `packages/backend/src/`:
        - `websocket/connect.ts` - Handle WebSocket connections
        - `websocket/disconnect.ts` - Handle disconnections  
        - `websocket/message.ts` - Handle real-time messages
    -   [x] **Connection Management**: Store `connectionId` in DynamoDB with user association
    -   [x] **Message Routing**: Route file changes to other connected clients
    -   [x] **Integration**: Use existing S3/DynamoDB logic from HTTP endpoints
-   [x] **Plugin WebSocket Client**
    -   [x] **Replace HTTP calls** with WebSocket connections (built-in `WebSocket` API)
    -   [x] **Connection lifecycle**: Connect on plugin load, reconnect on failures
    -   [x] **File watching**: Use Obsidian's `vault.on('modify')` to detect changes
    -   [x] **Real-time sync**: Send file changes immediately via WebSocket
    -   [x] **Receive updates**: Apply incoming changes from other clients
    -   [x] **Debouncing**: Prevent sync loops and excessive updates
-   [x] **Testing & Validation**
    -   [x] Test WebSocket connection from Obsidian
    -   [x] Verify real-time sync between multiple clients
    -   [x] Confirm CORS issues are resolved
    -   [x] Update deployment script for new infrastructure

---

### Milestone 5: Offline Mode & Conflict Resolution

This makes the plugin robust and implements your desired user-controlled conflict resolution.

-   [x] **Plugin Logic**
    -   [x] **Bulk Sync Operations:** Sync all files, download entire vault, check sync status
    -   [x] **Queue Management:** Batched processing to avoid overwhelming the server
    -   [x] **Sync Status Detection:** Automatic detection of out-of-sync files with visual indicators
    -   [x] **Reconnection Logic:** Auto-check sync status when WebSocket reconnects
    -   [x] **Progress Tracking:** Real-time progress display during bulk operations
    -   [ ] **Conflict UI:** If a conflict is detected (`local changes exist` AND `server version is newer`), use the Obsidian Modal API to display the choice dialog.
    -   [ ] **Implement User Choices:**
        -   "Keep Local": Trigger the file upload function from Milestone 3.
        -   "Use Cloud": Trigger the file download function from Milestone 3.
    -   [ ] Once all conflicts are resolved and the offline queue is cleared, resume normal real-time operation.

---

### Milestone 6: Polishing and Finalizing

-   [ ] **Error Handling:** Add robust error handling for network failures, failed patches, etc.
-   [ ] **Status Indicator:** Add a small status icon in the Obsidian status bar to show sync status (e.g., "Connected," "Syncing," "Offline," "Conflict").
-   [ ] **Security Review:** Ensure your Lambda functions have the minimum necessary IAM permissions (e.g., only access to their specific S3 paths and DynamoDB tables).
-   [ ] **Documentation:** Write a clear `README.md` explaining how to deploy the backend and install/configure the plugin.


- [ ] add ttl on ddb object which triggers a stream which removes the file from s3 finally
- [ ] auth the whole way so noone else can see your files
