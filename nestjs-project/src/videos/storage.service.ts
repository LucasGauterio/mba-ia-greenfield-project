import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  type CompletedPart,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { PRESIGN_TTL_SECONDS } from './videos.constants';

export interface PresignGetOptions {
  /** Value for the `response-content-disposition` response header override. */
  disposition?: string;
}

/**
 * S3-compatible object storage (MinIO locally, S3 in prod). The API is
 * control-plane only for uploads — bytes never transit this process on the
 * write path (phase-03-videos/TD-02) nor the read path (TD-07). The worker's
 * `downloadObject` / `uploadObject` are the sole exception (small thumbnails,
 * originals to a local tempfile — phase-03-videos/TD-05).
 */
@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY) config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true, // MinIO has no vhost-style buckets
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!UploadId) {
      throw new Error(
        `CreateMultipartUpload returned no UploadId for "${key}"`,
      );
    }
    return UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: PRESIGN_TTL_SECONDS.UPLOAD_PART },
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
  }

  /** Idempotent — an already-completed or unknown `uploadId` is a no-op. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  }

  async headObject(key: string): Promise<{ contentLength: number }> {
    const { ContentLength } = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return { contentLength: ContentLength ?? 0 };
  }

  async presignGetObject(
    key: string,
    options: PresignGetOptions = {},
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(options.disposition
          ? { ResponseContentDisposition: options.disposition }
          : {}),
      }),
      { expiresIn: PRESIGN_TTL_SECONDS.GET_OBJECT },
    );
  }

  /** Streams an object to a local file — used by the worker only. */
  async downloadObject(key: string, destPath: string): Promise<void> {
    const { Body } = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!(Body instanceof Readable)) {
      throw new Error(`GetObject body for "${key}" is not a readable stream`);
    }
    await pipeline(Body, createWriteStream(destPath));
  }

  /** Uploads a local file — used by the worker only (thumbnails). */
  async uploadObject(
    key: string,
    srcPath: string,
    contentType: string,
  ): Promise<void> {
    const { size } = await stat(srcPath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(srcPath),
        ContentType: contentType,
        // The SDK cannot infer length from a stream; omitting it fails with a
        // cryptic header error (PLAN §11.4).
        ContentLength: size,
      }),
    );
  }
}

function isNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'NoSuchUpload' || err.name === 'NotFound') return true;
  const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return meta?.httpStatusCode === 404;
}
