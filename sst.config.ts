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
      ttl: "expireAt",
    });

    const example = new sst.aws.Function("Example", {
      url: true,
      handler: "packages/backend/src/example.handler",
      link: [table, bucket],
    });
  },
});
