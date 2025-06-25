/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "obsync",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "aws",
    };
  },
  async run() {
    $transform(sst.aws.Function, (args) => {
      args.runtime ??= "nodejs22.x";
      args.architecture ??= "arm64";
    });

    // API Key secret for authentication
    const apiKeySecret = new sst.Secret("ApiKey");

    const bucket = new sst.aws.Bucket("Storage");

    const table = new sst.aws.Dynamo("Table", {
      fields: {
        pk: "string",
        sk: "string",
        gsi1pk: "string",
        gsi1sk: "string",
        gsi2pk: "string",
        gsi2sk: "string",
      },
      primaryIndex: { hashKey: "pk", rangeKey: "sk" },
      globalIndexes: {
        GSI1: { hashKey: "gsi1pk", rangeKey: "gsi1sk" },
        GSI2: { hashKey: "gsi2pk", rangeKey: "gsi2sk" },
      },
      stream: "new-and-old-images",
      ttl: "expireAt",
    });

    // DynamoDB Stream subscriber for handling TTL expiration
    table.subscribe(
      "TTLExpirationSubscriber",
      {
        handler: "packages/backend/src/websocket/connect.handler",
        link: [table],
      },
      {
        filters: [
          {
            dynamodb: {
              eventName: ["REMOVE"],
            },
          },
        ],
      },
    );

    // WebSocket API for real-time sync
    const websocketApi = new sst.aws.ApiGatewayWebSocket("WebSocketAPI", {
      accessLog: {
        retention: "1 week",
      },
    });

    // Create routes to WebSocket API
    websocketApi.route("$connect", {
      handler: "packages/backend/src/websocket/connect.handler",
      link: [table, websocketApi, apiKeySecret],
    });
    websocketApi.route("$disconnect", {
      handler: "packages/backend/src/websocket/disconnect.handler",
      link: [table, websocketApi, apiKeySecret],
    });
    websocketApi.route("$default", {
      handler: "packages/backend/src/websocket/message.handler",
      link: [table, bucket, websocketApi, apiKeySecret],
    });
  },
});
