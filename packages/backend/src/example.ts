import { Resource } from "sst";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

const s3Client = new S3Client({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

function createResponse(statusCode: number, body: any, contentType: string = "application/json"): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*"
    },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  };
}

interface FileRecord {
  pk: string;
  sk: string;
  filePath: string;
  version: number;
  lastModified: string;
  userId: string;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  console.log("Event:", JSON.stringify(event, null, 2));

  try {
    const path = event.rawPath || "";
    const method = event.requestContext.http.method;
    
// For now, we'll use a hardcoded userId for testing
    const userId = "test-user";

    if (method === "GET" && path === "/versions") {
      return await handleListFiles(userId);
    } else if (method === "GET" && path !== "/versions") {
      const filePath = decodeURIComponent(path.substring(1));
      return await handleDownloadFile(userId, filePath);
    } else if (method === "PUT") {
      const body = JSON.parse(event.body || '{}');
      return await handleUploadFile(userId, body.filePath, body.content);
    } else {
      return createResponse(404, { error: "Not found" });
    }
  } catch (error) {
    console.error("Error:", error);
    return createResponse(500, { error: "Internal server error" });
  }
};

async function handleDownloadFile(userId: string, filePath: string): Promise<APIGatewayProxyResultV2> {
  try {
    const s3Key = `${userId}/${filePath}`;
    
    const command = new GetObjectCommand({
      Bucket: Resource.Storage.name,
      Key: s3Key,
    });

    const response = await s3Client.send(command);
    
    if (!response.Body) {
      return createResponse(404, { error: "File not found" });
    }

    const content = await response.Body.transformToString();
    console.log(`✅ Downloaded file from S3: ${s3Key} (${content.length} characters)`);
    
    return createResponse(200, content, "text/markdown");
  } catch (error: any) {
    if (error.name === "NoSuchKey") {
      return createResponse(404, { error: "File not found" });
    }
    throw error;
  }
}

async function handleListFiles(userId: string): Promise<APIGatewayProxyResultV2> {
  try {
    const command = new QueryCommand({
      TableName: Resource.Table.name,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :skPrefix)",
      ExpressionAttributeValues: {
        ":pk": `USER#${userId}`,
        ":skPrefix": "FILE#"
      }
    });

    const response = await docClient.send(command);
    const items = response.Items as FileRecord[] || [];
    
    const fileVersions: Record<string, number> = {};
    
    for (const item of items) {
      fileVersions[item.filePath] = item.version;
    }
    
    console.log(`✅ Listed files for user: ${userId} (${Object.keys(fileVersions).length} files found)`);
    return createResponse(200, fileVersions);
  } catch (error) {
    console.error("Error listing files:", error);
    throw error;
  }
}

async function handleUploadFile(userId: string, filePath: string, content: string): Promise<APIGatewayProxyResultV2> {
  try {
    const s3Key = `${userId}/${filePath}`;
    
    const s3Command = new PutObjectCommand({
      Bucket: Resource.Storage.name,
      Key: s3Key,
      Body: content,
      ContentType: "text/markdown",
    });
    
    await s3Client.send(s3Command);
    console.log(`✅ Uploaded file to S3: ${s3Key}`);
    
    const existingFileQuery = new QueryCommand({
      TableName: Resource.Table.name,
      KeyConditionExpression: "pk = :pk AND sk = :sk",
      ExpressionAttributeValues: {
        ":pk": `USER#${userId}`,
        ":sk": `FILE#${filePath}`
      }
    });
    
    const existingFile = await docClient.send(existingFileQuery);
    const currentVersion = existingFile.Items?.[0]?.version || 0;
    const newVersion = currentVersion + 1;
    
    const dynamoCommand = new PutCommand({
      TableName: Resource.Table.name,
      Item: {
        pk: `USER#${userId}`,
        sk: `FILE#${filePath}`,
        filePath: filePath,
        version: newVersion,
        lastModified: new Date().toISOString(),
        userId: userId,
        gsi1pk: `FILE#${filePath}`,
        gsi1sk: `USER#${userId}`,
      },
    });
    
    await docClient.send(dynamoCommand);
    console.log(`✅ Updated DynamoDB record for: ${filePath} (v${newVersion})`);
    
    return createResponse(200, {
      message: "File uploaded successfully",
      filePath: filePath,
      version: newVersion
    });
  } catch (error) {
    console.error("Error uploading file:", error);
    throw error;
  }
}
