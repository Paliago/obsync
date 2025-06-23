import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, PutCommand, GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { Resource } from "sst";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});

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

    switch (message.action) {
      case "upload":
        return await handleFileUpload(message, connectionId, apiGatewayClient);
      case "download":
        return await handleFileDownload(message, connectionId, apiGatewayClient);
      case "list":
        return await handleFileList(connectionId, apiGatewayClient);
      case "ping":
        await sendToConnection(apiGatewayClient, connectionId, { type: "pong" });
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

async function handleFileUpload(
  message: any, 
  connectionId: string, 
  apiGatewayClient: ApiGatewayManagementApiClient
) {
  const { filePath, content, version } = message;
  
  if (!filePath || !content) {
    await sendToConnection(apiGatewayClient, connectionId, {
      type: "error",
      message: "Missing filePath or content",
    });
    return { statusCode: 400, body: "Missing filePath or content" };
  }

  const key = `files/${filePath}`;
  const newVersion = version || Date.now().toString();

  try {
    // Upload to S3
    await s3Client.send(
      new PutObjectCommand({
        Bucket: Resource.Storage.name,
        Key: key,
        Body: content,
        Metadata: {
          version: newVersion,
          uploadedBy: connectionId,
        },
      })
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
          lastModified: Date.now(),
          uploadedBy: connectionId,
        },
      })
    );

    // Notify the uploader
    await sendToConnection(apiGatewayClient, connectionId, {
      type: "upload_success",
      filePath,
      version: newVersion,
    });

    // Broadcast file change to other connected clients
    await broadcastFileChange(apiGatewayClient, connectionId, {
      type: "file_changed",
      filePath,
      version: newVersion,
      action: "upload",
    });

    console.log(`File uploaded: ${filePath} version ${newVersion}`);
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
  apiGatewayClient: ApiGatewayManagementApiClient
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
      })
    );

    const content = await s3Response.Body?.transformToString();
    const version = s3Response.Metadata?.version || "unknown";

    // Send file content back through WebSocket
    await sendToConnection(apiGatewayClient, connectionId, {
      type: "download_success",
      filePath,
      content,
      version,
    });

    console.log(`File downloaded: ${filePath} version ${version}`);
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

async function handleFileList(
  connectionId: string, 
  apiGatewayClient: ApiGatewayManagementApiClient
) {
  try {
    // Get all files from DynamoDB
    const response = await docClient.send(
      new ScanCommand({
        TableName: Resource.Table.name,
        FilterExpression: "begins_with(pk, :filePrefix)",
        ExpressionAttributeValues: {
          ":filePrefix": "FILE#",
        },
      })
    );

    const files: Record<string, string> = {};
    response.Items?.forEach((item) => {
      if (item.filePath && item.version) {
        files[item.filePath] = item.version;
      }
    });

    // Send file list back through WebSocket
    await sendToConnection(apiGatewayClient, connectionId, {
      type: "file_list",
      files,
    });

    console.log(`File list sent to ${connectionId}, found ${Object.keys(files).length} files`);
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

async function sendToConnection(
  apiGatewayClient: ApiGatewayManagementApiClient,
  connectionId: string,
  data: any
) {
  try {
    await apiGatewayClient.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify(data),
      })
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
        })
      );
    }
  }
}

async function broadcastFileChange(
  apiGatewayClient: ApiGatewayManagementApiClient,
  excludeConnectionId: string,
  data: any
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
      })
    );

    const broadcastPromises = connections.Items?.map(async (connection) => {
      if (connection.connectionId !== excludeConnectionId) {
        await sendToConnection(apiGatewayClient, connection.connectionId, data);
      }
    }) || [];

    await Promise.all(broadcastPromises);
    console.log(`Broadcasted file change to ${broadcastPromises.length} clients`);
  } catch (error) {
    console.error("Broadcast error:", error);
  }
} 
