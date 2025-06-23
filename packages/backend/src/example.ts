import { Resource } from "sst";

export const handler = async () => {
  console.log("Hello, world!");
  console.log(Resource.Table.name);
  console.log(Resource.Storage.name);

  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Hello, world!" }),
  };
};
