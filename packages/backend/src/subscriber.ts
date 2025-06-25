import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { DynamoDBStreamHandler } from "aws-lambda";
import { Resource } from "sst";

const s3Client = new S3Client({});

export const handler: DynamoDBStreamHandler = async (event) => {
  console.log("DynamoDB Stream event:", JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    // Only process REMOVE events (when TTL expires items)
    if (record.eventName === "REMOVE") {
      const oldImage = record.dynamodb?.OldImage;

      if (!oldImage) {
        console.log("No old image found in REMOVE event");
        continue;
      }

      // Check if this was a file record that was deleted due to TTL expiration
      const pk = oldImage.pk?.S;
      const filePath = oldImage.filePath?.S;
      const deleted = oldImage.deleted?.BOOL;
      const expireAt = oldImage.expireAt?.N;

      if (pk?.startsWith("FILE#") && filePath && deleted && expireAt) {
        console.log(`Processing TTL expiration for file: ${filePath}`);

        try {
          // Hard delete the file from S3
          const key = `files/${filePath}`;
          await s3Client.send(
            new DeleteObjectCommand({
              Bucket: Resource.Storage.name,
              Key: key,
            }),
          );

          console.log(`Successfully deleted file from S3: ${key}`);
        } catch (error) {
          console.error(`Failed to delete file from S3: ${filePath}`, error);
          // Don't throw - we want to continue processing other records
        }
      }
    }
  }

  return {
    batchItemFailures: [], // No failures to report
  };
};
