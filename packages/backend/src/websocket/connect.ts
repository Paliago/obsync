import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyHandler } from "aws-lambda";
import { Resource } from "sst";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

export const handler: APIGatewayProxyHandler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const timestamp = Date.now();

  console.log(`WebSocket connection attempt: ${connectionId}`);

  try {
    // Check API key authentication
    const queryParams = event.queryStringParameters || {};
    const providedApiKey = queryParams.apiKey;

    if (!providedApiKey) {
      console.error("No API key provided in connection");
      return {
        statusCode: 401,
        body: "API key required",
      };
    }

    if (providedApiKey !== Resource.ApiKey.value) {
      console.error("Invalid API key provided");
      return {
        statusCode: 401,
        body: "Invalid API key",
      };
    }

    await docClient.send(
      new PutCommand({
        TableName: Resource.Table.name,
        Item: {
          pk: `CONNECTION#${connectionId}`,
          sk: `CONNECTION#${connectionId}`,
          connectionId,
          connectedAt: timestamp,
          expireAt: Math.floor(timestamp / 1000) + 86400, // 24 hours
        },
      }),
    );

    console.log(`WebSocket connection authenticated: ${connectionId}`);
    return {
      statusCode: 200,
      body: "Connected",
    };
  } catch (error) {
    console.error("Failed to authenticate or store connection:", error);
    return {
      statusCode: 500,
      body: "Failed to connect",
    };
  }
};
