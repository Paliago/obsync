import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

export const handler: APIGatewayProxyHandler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const timestamp = Date.now();

  console.log(`WebSocket connection: ${connectionId}`);

  try {
    await docClient.send(
      new PutCommand({
        TableName: Resource.Table.name,
        Item: {
          pk: `CONNECTION#${connectionId}`,
          sk: `CONNECTION#${connectionId}`,
          connectionId,
          connectedAt: timestamp,
          ttl: Math.floor(timestamp / 1000) + 86400, // 24 hours
        },
      })
    );

    return {
      statusCode: 200,
      body: "Connected",
    };
  } catch (error) {
    console.error("Failed to store connection:", error);
    return {
      statusCode: 500,
      body: "Failed to connect",
    };
  }
}; 
