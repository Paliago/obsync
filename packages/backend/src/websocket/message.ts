import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyHandler } from "aws-lambda";
import { Resource } from "sst";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});

// In-memory chunk storage (for Lambda lifecycle)
// In production, you might want to use DynamoDB for chunk storage
const chunkBuffers = new Map<
  string,
  {
    chunks: Map<number, string>;
    totalChunks: number;
    filePath: string;
    fileType: string;
    lastModified?: number;
    connectionId: string;
    action: string;
  }
>();

export const handler: APIGatewayProxyHandler = async (event) => {
  const connectionId = event.requestContext.connectionId!;
  const domainName = event.requestContext.domainName!;
  const stage = event.requestContext.stage!;

  const apiGatewayClient = new ApiGatewayManagementApiClient({
    endpoint: `https://${domainName}/${stage}`,
  });

  try {
    const message = JSON.parse(event.body || "{}");
    console.log(`WebSocket message from ${connectionId}:`, message);

    // Check API key authentication for all messages
    if (!message.apiKey) {
      console.error("No API key provided in message");
      await sendToConnection(apiGatewayClient, connectionId, {
        type: "error",
        message: "API key required",
      });
      return { statusCode: 401, body: "API key required" };
    }

    if (message.apiKey !== Resource.ApiKey.value) {
      console.error("Invalid API key provided in message");
      await sendToConnection(apiGatewayClient, connectionId, {
        type: "error",
        message: "Invalid API key",
      });
      return { statusCode: 401, body: "Invalid API key" };
    }

    // Handle chunked messages
    if (
      message.isChunked &&
      message.chunkId &&
      message.chunkIndex !== undefined &&
      message.totalChunks
    ) {
      return await handleChunkedMessage(
        message,
        connectionId,
        apiGatewayClient,
      );
    }

    switch (message.action) {
      case "upload":
        return await handleFileUpload(message, connectionId, apiGatewayClient);
      case "download":
        return await handleFileDownload(
          message,
          connectionId,
          apiGatewayClient,
        );
      case "delete":
        return await handleFileDelete(message, connectionId, apiGatewayClient);
      case "list":
        return await handleFileList(connectionId, apiGatewayClient);
      case "list_deleted":
        return await handleDeletedFileList(connectionId, apiGatewayClient);
      case "restore":
        return await handleFileRestore(message, connectionId, apiGatewayClient);
      case "ping":
        await sendToConnection(apiGatewayClient, connectionId, {
          type: "pong",
        });
        return { statusCode: 200, body: "pong" };
      default:
        console.log(`Unknown action: ${message.action}`);
        await sendToConnection(apiGatewayClient, connectionId, {
          type: "error",
          message: `Unknown action: ${message.action}`,
        });
        return { statusCode: 400, body: "Unknown action" };
    }
  } catch (error) {
    console.error("WebSocket message error:", error);
    await sendToConnection(apiGatewayClient, connectionId, {
      type: "error",
      message: "Internal server error",
    });
    return { statusCode: 500, body: "Internal server error" };
  }
};

async function handleChunkedMessage(
  message: any,
  connectionId: string,
  apiGatewayClient: ApiGatewayManagementApiClient,
) {
  const {
    chunkId,
    chunkIndex,
    totalChunks,
    filePath,
    content,
    action,
    fileType,
    lastModified,
  } = message;

  if (
    !chunkId ||
    chunkIndex === undefined ||
    !totalChunks ||
    !filePath ||
    !action
  ) {
    await sendToConnection(apiGatewayClient, connectionId, {
      type: "error",
      message: "Invalid chunked message",
    });
    return { statusCode: 400, body: "Invalid chunked message" };
  }

  // Initialize chunk buffer if needed
  if (!chunkBuffers.has(chunkId)) {
    chunkBuffers.set(chunkId, {
      chunks: new Map(),
      totalChunks,
      filePath,
      fileType: fileType || "text",
      lastModified,
      connectionId,
      action,
    });
  }

  const buffer = chunkBuffers.get(chunkId)!;

  // Store chunk
  buffer.chunks.set(chunkIndex, content || "");

  console.log(
    `Received chunk ${chunkIndex + 1}/${totalChunks} for ${filePath} (${Math.round(new Blob([content || ""]).size / 1024)}KB)`,
  );

  // Check if all chunks received
  if (buffer.chunks.size === buffer.totalChunks) {
    // Reassemble content
    let fullContent = "";
    for (let i = 0; i < buffer.totalChunks; i++) {
      const chunk = buffer.chunks.get(i);
      if (chunk === undefined) {
        console.error(`Missing chunk ${i} for ${filePath}`);
        chunkBuffers.delete(chunkId);
        await sendToConnection(apiGatewayClient, connectionId, {
          type: "error",
          message: `Missing chunk ${i} for ${filePath}`,
        });
        return { statusCode: 400, body: "Missing chunk" };
      }
      fullContent += chunk;
    }

    console.log(
      `Successfully reassembled ${filePath} from ${buffer.totalChunks} chunks (${Math.round(new Blob([fullContent]).size / 1024)}KB)`,
    );

    // Clean up buffer
    chunkBuffers.delete(chunkId);

    // Create complete message and process it
    const completeMessage = {
      action: buffer.action,
      filePath: buffer.filePath,
      content: fullContent,
      fileType: buffer.fileType,
      lastModified: buffer.lastModified,
    };

    // Process the complete message
    switch (buffer.action) {
      case "upload":
        return await handleFileUpload(
          completeMessage,
          connectionId,
          apiGatewayClient,
          true,
        );
      default:
        console.log(`Unsupported chunked action: ${buffer.action}`);
        return { statusCode: 400, body: "Unsupported chunked action" };
    }
  }

  // Not all chunks received yet
  return { statusCode: 200, body: "Chunk received" };
}

async function handleFileUpload(
  message: any,
  connectionId: string,
  apiGatewayClient: ApiGatewayManagementApiClient,
  isReassembledChunk = false,
) {
  const { filePath, content, version, lastModified, fileType } = message;

  if (!filePath || content === undefined) {
    await sendToConnection(apiGatewayClient, connectionId, {
      type: "error",
      message: "Missing filePath or content",
    });
    return { statusCode: 400, body: "Missing filePath or content" };
  }

  const key = `files/${filePath}`;
  const newVersion = version || Date.now().toString();
  const uploadedAt = Date.now();
  const clientLastModified = lastModified || uploadedAt;
  const detectedFileType = fileType || "text";

  try {
    // For binary files, we need to handle the content differently
    let bodyContent: string | Buffer = content;
    let contentType = "text/plain";

    if (detectedFileType === "binary") {
      // Content is base64 encoded, decode it for S3 storage
      bodyContent = Buffer.from(content, "base64");
      contentType = "application/octet-stream";
    }

    // Upload to S3
    await s3Client.send(
      new PutObjectCommand({
        Bucket: Resource.Storage.name,
        Key: key,
        Body: bodyContent,
        ContentType: contentType,
        Metadata: {
          version: newVersion,
          uploadedBy: connectionId,
          fileType: detectedFileType,
          clientLastModified: clientLastModified.toString(),
        },
      }),
    );

    // Update DynamoDB with file metadata
    await docClient.send(
      new PutCommand({
        TableName: Resource.Table.name,
        Item: {
          pk: `FILE#${filePath}`,
          sk: `VERSION#${newVersion}`,
          filePath,
          version: newVersion,
          lastModified: uploadedAt,
          clientLastModified: clientLastModified,
          uploadedBy: connectionId,
          fileType: detectedFileType,
        },
      }),
    );

    // Notify the uploader - return the client's original lastModified time
    await sendToConnection(apiGatewayClient, connectionId, {
      type: "upload_success",
      filePath,
      version: newVersion,
      lastModified: clientLastModified,
      fileType: detectedFileType,
    });

    // Broadcast file change to other connected clients
    await broadcastFileChange(apiGatewayClient, connectionId, {
      type: "file_changed",
      filePath,
      version: newVersion,
      action: "upload",
      fileType: detectedFileType,
    });

    const logMessage = isReassembledChunk
      ? `Large file uploaded from chunks: ${filePath} version ${newVersion} (type: ${detectedFileType})`
      : `File uploaded: ${filePath} version ${newVersion} (type: ${detectedFileType})`;
    console.log(logMessage);
    return { statusCode: 200, body: "File uploaded successfully" };
  } catch (error) {
    console.error("Upload error:", error);
    await sendToConnection(apiGatewayClient, connectionId, {
      type: "error",
      message: "Upload failed",
    });
    return { statusCode: 500, body: "Upload failed" };
  }
}

async function handleFileDownload(
  message: any,
  connectionId: string,
  apiGatewayClient: ApiGatewayManagementApiClient,
) {
  const { filePath } = message;

  if (!filePath) {
    await sendToConnection(apiGatewayClient, connectionId, {
      type: "error",
      message: "Missing filePath",
    });
    return { statusCode: 400, body: "Missing filePath" };
  }

  try {
    const key = `files/${filePath}`;

    // Get file from S3
    const s3Response = await s3Client.send(
      new GetObjectCommand({
        Bucket: Resource.Storage.name,
        Key: key,
      }),
    );

    const version = s3Response.Metadata?.version || "unknown";
    const fileType = s3Response.Metadata?.fileType || "text";
    const clientLastModified = s3Response.Metadata?.clientLastModified;

    let content: string;

    if (fileType === "binary") {
      // For binary files, convert to base64
      const bodyBytes = await s3Response.Body?.transformToByteArray();
      if (bodyBytes) {
        content = Buffer.from(bodyBytes).toString("base64");
      } else {
        throw new Error("Failed to read binary file content");
      }
    } else {
      // For text files, get as string
      content = (await s3Response.Body?.transformToString()) || "";
    }

    // Send file content back through WebSocket
    await sendToConnection(apiGatewayClient, connectionId, {
      type: "download_success",
      filePath,
      content,
      version,
      fileType,
      lastModified: clientLastModified
        ? Number.parseInt(clientLastModified)
        : undefined,
    });

    console.log(
      `File downloaded: ${filePath} version ${version} (type: ${fileType})`,
    );
    return { statusCode: 200, body: "File downloaded successfully" };
  } catch (error) {
    console.error("Download error:", error);
    await sendToConnection(apiGatewayClient, connectionId, {
      type: "error",
      message: `File not found: ${filePath}`,
    });
    return { statusCode: 404, body: "File not found" };
  }
}

async function handleFileDelete(
  message: any,
  connectionId: string,
  apiGatewayClient: ApiGatewayManagementApiClient,
) {
  const { filePath } = message;

  if (!filePath) {
    await sendToConnection(apiGatewayClient, connectionId, {
      type: "error",
      message: "Missing filePath",
    });
    return { statusCode: 400, body: "Missing filePath" };
  }

  try {
    // Soft delete: Add expireAt field to existing version records instead of hard deleting
    const expirationTime = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days
    const deletedAt = Date.now();

    // Find all version records for this file
    const scanResponse = await docClient.send(
      new ScanCommand({
        TableName: Resource.Table.name,
        FilterExpression: "pk = :pk AND begins_with(sk, :sk)",
        ExpressionAttributeValues: {
          ":pk": `FILE#${filePath}`,
          ":sk": "VERSION#",
        },
      }),
    );

    // Soft delete all version records by adding expireAt field
    for (const item of scanResponse.Items || []) {
      await docClient.send(
        new UpdateCommand({
          TableName: Resource.Table.name,
          Key: {
            pk: item.pk,
            sk: item.sk,
          },
          UpdateExpression:
            "SET deleted = :deleted, deletedAt = :deletedAt, deletedBy = :deletedBy, expireAt = :expireAt",
          ExpressionAttributeValues: {
            ":deleted": true,
            ":deletedAt": deletedAt,
            ":deletedBy": connectionId,
            ":expireAt": expirationTime,
          },
        }),
      );
    }

    // Notify the deleter
    await sendToConnection(apiGatewayClient, connectionId, {
      type: "delete_success",
      filePath,
    });

    // Broadcast file deletion to other connected clients
    await broadcastFileChange(apiGatewayClient, connectionId, {
      type: "file_changed",
      filePath,
      action: "delete",
    });

    console.log(`File soft deleted: ${filePath}`);
    return { statusCode: 200, body: "File deleted successfully" };
  } catch (error) {
    console.error("Delete error:", error);
    await sendToConnection(apiGatewayClient, connectionId, {
      type: "error",
      message: "Delete failed",
    });
    return { statusCode: 500, body: "Delete failed" };
  }
}

async function handleFileList(
  connectionId: string,
  apiGatewayClient: ApiGatewayManagementApiClient,
) {
  try {
    // Get all files from DynamoDB (excluding deleted files)
    const response = await docClient.send(
      new ScanCommand({
        TableName: Resource.Table.name,
        FilterExpression:
          "begins_with(pk, :filePrefix) AND begins_with(sk, :versionPrefix) AND attribute_not_exists(deleted)",
        ExpressionAttributeValues: {
          ":filePrefix": "FILE#",
          ":versionPrefix": "VERSION#",
        },
      }),
    );

    const files: Record<string, any> = {};
    response.Items?.forEach((item) => {
      if (item.filePath && item.version && !item.deleted) {
        files[item.filePath] = {
          version: item.version,
          lastModified: item.lastModified || 0,
          clientLastModified: item.clientLastModified || item.lastModified || 0,
          fileType: item.fileType || "text",
        };
      }
    });

    // Send file list back through WebSocket
    await sendToConnection(apiGatewayClient, connectionId, {
      type: "file_list",
      files,
    });

    console.log(
      `File list sent to ${connectionId}, found ${Object.keys(files).length} files`,
    );
    return { statusCode: 200, body: "File list sent successfully" };
  } catch (error) {
    console.error("List error:", error);
    await sendToConnection(apiGatewayClient, connectionId, {
      type: "error",
      message: "Failed to list files",
    });
    return { statusCode: 500, body: "Failed to list files" };
  }
}

async function handleDeletedFileList(
  connectionId: string,
  apiGatewayClient: ApiGatewayManagementApiClient,
) {
  try {
    // Get all deleted files from DynamoDB
    const response = await docClient.send(
      new ScanCommand({
        TableName: Resource.Table.name,
        FilterExpression:
          "begins_with(pk, :filePrefix) AND begins_with(sk, :versionPrefix) AND deleted = :deleted",
        ExpressionAttributeValues: {
          ":filePrefix": "FILE#",
          ":versionPrefix": "VERSION#",
          ":deleted": true,
        },
      }),
    );

    const deletedFiles: Record<string, any> = {};
    response.Items?.forEach((item) => {
      if (item.filePath && item.deleted) {
        deletedFiles[item.filePath] = {
          version: item.version,
          deletedAt: item.deletedAt,
          deletedBy: item.deletedBy,
          expireAt: item.expireAt,
          lastModified: item.lastModified || 0,
          fileType: item.fileType || "text",
        };
      }
    });

    await sendToConnection(apiGatewayClient, connectionId, {
      type: "deleted_files_list",
      files: deletedFiles,
    });

    console.log(
      `Deleted file list sent to ${connectionId}, found ${Object.keys(deletedFiles).length} deleted files`,
    );
    return { statusCode: 200, body: "Deleted file list sent successfully" };
  } catch (error) {
    console.error("Deleted list error:", error);
    await sendToConnection(apiGatewayClient, connectionId, {
      type: "error",
      message: "Failed to list deleted files",
    });
    return { statusCode: 500, body: "Failed to list deleted files" };
  }
}

async function handleFileRestore(
  message: any,
  connectionId: string,
  apiGatewayClient: ApiGatewayManagementApiClient,
) {
  const { filePath } = message;

  if (!filePath) {
    await sendToConnection(apiGatewayClient, connectionId, {
      type: "error",
      message: "Missing filePath",
    });
    return { statusCode: 400, body: "Missing filePath" };
  }

  try {
    // Find all deleted version records for this file
    const scanResponse = await docClient.send(
      new ScanCommand({
        TableName: Resource.Table.name,
        FilterExpression:
          "pk = :pk AND begins_with(sk, :sk) AND deleted = :deleted",
        ExpressionAttributeValues: {
          ":pk": `FILE#${filePath}`,
          ":sk": "VERSION#",
          ":deleted": true,
        },
      }),
    );

    // Restore all version records by removing the deleted fields
    for (const item of scanResponse.Items || []) {
      await docClient.send(
        new UpdateCommand({
          TableName: Resource.Table.name,
          Key: {
            pk: item.pk,
            sk: item.sk,
          },
          UpdateExpression: "REMOVE deleted, deletedAt, deletedBy, expireAt",
        }),
      );
    }

    // Notify the restorer
    await sendToConnection(apiGatewayClient, connectionId, {
      type: "restore_success",
      filePath,
    });

    // Broadcast file restoration to other connected clients
    await broadcastFileChange(apiGatewayClient, connectionId, {
      type: "file_changed",
      filePath,
      action: "restore",
    });

    console.log(`File restored: ${filePath}`);
    return { statusCode: 200, body: "File restored successfully" };
  } catch (error) {
    console.error("Restore error:", error);
    await sendToConnection(apiGatewayClient, connectionId, {
      type: "error",
      message: "Restore failed",
    });
    return { statusCode: 500, body: "Restore failed" };
  }
}

async function sendToConnection(
  apiGatewayClient: ApiGatewayManagementApiClient,
  connectionId: string,
  data: any,
) {
  try {
    await apiGatewayClient.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify(data),
      }),
    );
  } catch (error: any) {
    console.error(`Failed to send to connection ${connectionId}:`, error);
    // If connection is stale (410 Gone), clean it up
    if (error.$metadata?.httpStatusCode === 410) {
      console.log(`Cleaning up stale connection: ${connectionId}`);
      await docClient.send(
        new DeleteCommand({
          TableName: Resource.Table.name,
          Key: {
            pk: `CONNECTION#${connectionId}`,
            sk: `CONNECTION#${connectionId}`,
          },
        }),
      );
    }
  }
}

async function broadcastFileChange(
  apiGatewayClient: ApiGatewayManagementApiClient,
  excludeConnectionId: string,
  data: any,
) {
  try {
    // Get all active connections
    const connections = await docClient.send(
      new ScanCommand({
        TableName: Resource.Table.name,
        FilterExpression: "begins_with(pk, :connPrefix)",
        ExpressionAttributeValues: {
          ":connPrefix": "CONNECTION#",
        },
      }),
    );

    const broadcastPromises =
      connections.Items?.map(async (connection) => {
        if (connection.connectionId !== excludeConnectionId) {
          await sendToConnection(
            apiGatewayClient,
            connection.connectionId,
            data,
          );
        }
      }) || [];

    await Promise.all(broadcastPromises);
    console.log(
      `Broadcasted file change to ${broadcastPromises.length} clients`,
    );
  } catch (error) {
    console.error("Broadcast error:", error);
  }
}
