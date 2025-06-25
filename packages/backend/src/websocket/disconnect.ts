import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyHandler } from "aws-lambda";
import { Resource } from "sst";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

export const handler: APIGatewayProxyHandler = async (event) => {
  const connectionId = event.requestContext.connectionId;

  console.log(`WebSocket disconnection: ${connectionId}`);

  try {
    await docClient.send(
      new DeleteCommand({
        TableName: Resource.Table.name,
        Key: {
          pk: `CONNECTION#${connectionId}`,
          sk: `CONNECTION#${connectionId}`,
        },
      }),
    );

    return {
      statusCode: 200,
      body: "Disconnected",
    };
  } catch (error) {
    console.error("Failed to remove connection:", error);
    return {
      statusCode: 500,
      body: "Failed to disconnect",
    };
  }
};
