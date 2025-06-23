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
    -   [x] Add the obsidian sample plugin to the packages dir to use as reference for our `packages/plugin`

---

### Milestone 2: Backend - Core File Operations & Auth

This milestone focuses on building the stateless, request/response part of the backend using a Lambda Function URL. At the end of this, you'll be able to upload and download files using a tool like Postman.

-   [ ] **Implement Lambda Endpoints**
    -   [ ] **File Download:** Create logic to handle a `GET` request with a file path. It should read the file from S3 and return its content.
    -   [ ] **File List:** Create logic to handle a `GET /versions` request. It should query DynamoDB for all files belonging to the authenticated user and return a simple map of `filePath: version`.
-   [ ] **Testing**
    -   [ ] Create an .md file to test with
    -   [ ] Use curl to test the functionality thus far

---

### Milestone 3: Plugin - Manual Sync & Settings

Now, let's make the plugin talk to the backend. We'll skip automatic sync for now and focus on user-triggered actions.

-   [ ] **Plugin UI**
    -   [ ] Create a "Settings" tab for your plugin in Obsidian.
    -   [ ] Add fields for the user to enter their username, password, and the Lambda Function URL.
-   [ ] **Authentication Logic**
    -   [ ] Add a "Login" button. When clicked, use a library like `amazon-cognito-identity-js` to send the credentials to Cognito and retrieve JWT tokens.
    -   [ ] Securely store the tokens in the plugin's local storage.
-   [ ] **Manual Sync Commands**
    -   [ ] Add two commands to the Obsidian command palette:
        -   `Sync: Upload active file to cloud`
        -   `Sync: Download active file from cloud`
    -   [ ] Wire these commands to call your Lambda Function URL using `fetch`, attaching the auth token in the headers.
-   [ ] **Testing**
    -   [ ] Install the plugin in Obsidian. Log in via the settings.
    -   [ ] Verify you can manually push a file to S3 and pull it back down, overwriting the local file.

---

### Milestone 4: Real-time Sync Engine (WebSockets)

This is where the "instant" sync magic happens.

-   [ ] **Backend WebSocket API**
    -   [ ] In your CDK stack, define an **API Gateway WebSocket API**.
    -   [ ] Create three new Lambda functions: `OnConnect`, `OnDisconnect`, and `OnMessage`.
    -   [ ] Configure the API Gateway routes: `$connect`, `$disconnect`, and a custom route named `message` to point to the respective Lambdas.
    -   [ ] **`OnConnect` Lambda:** Implement logic to authorize the user (from the token passed in the connection request) and store their `connectionId` in the DynamoDB table.
    -   [ ] **`OnDisconnect` Lambda:** Implement logic to remove the `connectionId` from DynamoDB.
    -   [ ] **`OnMessage` Lambda:** This is the core.
        -   [ ] It receives a patch from a client.
        -   [ ] It fetches the current file from S3, applies the patch.
        -   [ ] It saves the new file back to S3 and updates the version in DynamoDB.
        -   [ ] It queries DynamoDB for all *other* active connections for that user.
        -   [ ] It uses the `ApiGatewayManagementApi` to post the patch message to those other connections.
-   [ ] **Plugin WebSocket Client**
    -   [ ] Integrate a WebSocket client library (`ws`) into your plugin.
    -   [ ] On startup (after login), connect to the WebSocket URL.
    -   [ ] **Listen for Patches:** When a message arrives from the server, apply the patch to the correct local file. **Crucially, disable the file watcher before you write the file and re-enable it after to prevent sync loops.**
    -   [ ] **Watch for Local Changes:** Use Obsidian's API (`metadataCache.on('changed', ...)`) to detect local file edits.
    -   [ ] **Send Patches:** When a change is detected, use a diffing library to create a patch and send it to the server via the WebSocket `message` route.
    -   [ ] Implement a "debounce" mechanism so you don't send patches on every single keystroke.

---

### Milestone 5: Offline Mode & Conflict Resolution

This makes the plugin robust and implements your desired user-controlled conflict resolution.

-   [ ] **Plugin Logic**
    -   [ ] **Offline Queue:** Create a system (e.g., a JSON file) to log changes made while the WebSocket is disconnected.
    -   [ ] **Reconnection Logic:** When the WebSocket reconnects, trigger a "reconciliation mode."
    -   [ ] **Fetch Server State:** Call the `GET /versions` endpoint on your Lambda URL to get the latest state from the cloud.
    -   [ ] **Comparison Logic:** For each file with offline changes, compare its last known version with the server's current version.
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
