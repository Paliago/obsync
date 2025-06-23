import { Resource } from "sst";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const s3Client = new S3Client({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

export const setupTestData = async () => {
  const userId = "test-user";
  const filePath = "test-file.md";
  
  try {
    const fileContent = `# Test File for Obsidian Sync

This is a test file to verify the sync functionality works correctly.

## Features to Test

- File upload to S3
- File download from S3
- Version tracking in DynamoDB
- File listing endpoint

## Test Content

Here's some sample content:

\`\`\`javascript
console.log("Hello from synced file!");
\`\`\`

> This is a blockquote to test markdown rendering

- List item 1
- List item 2  
- List item 3

Last updated: ${new Date().toISOString()}`;
    
    const s3Key = `${userId}/${filePath}`;
    
    const s3Command = new PutObjectCommand({
      Bucket: Resource.Storage.name,
      Key: s3Key,
      Body: fileContent,
      ContentType: "text/markdown",
    });
    
    await s3Client.send(s3Command);
    console.log(`✅ Uploaded file to S3: ${s3Key}`);
    
    const dynamoCommand = new PutCommand({
      TableName: Resource.Table.name,
      Item: {
        pk: `USER#${userId}`,
        sk: `FILE#${filePath}`,
        filePath: filePath,
        version: 1,
        lastModified: new Date().toISOString(),
        userId: userId,
        gsi1pk: `FILE#${filePath}`,
        gsi1sk: `USER#${userId}`,
      },
    });
    
    await docClient.send(dynamoCommand);
    console.log(`✅ Created DynamoDB record for: ${filePath}`);
    
    return {
      userId,
      filePath,
      s3Key,
      message: "Test data setup complete"
    };
    
  } catch (error) {
    console.error("❌ Error setting up test data:", error);
    throw error;
  }
};

export const handler = async () => {
  try {
    const result = await setupTestData();
    return {
      statusCode: 200,
      body: JSON.stringify(result),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
    };
  }
}; 
