import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

describe('StorageService (integration — real MinIO)', () => {
  const config = storageConfig();
  const service = new StorageService(config);

  // Raw client only for test cleanup — the service itself never deletes.
  const rawClient = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  const createdKeys: string[] = [];
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'storage-svc-'));
  });

  afterAll(async () => {
    await Promise.all(
      createdKeys.map((Key) =>
        rawClient
          .send(new DeleteObjectCommand({ Bucket: config.bucket, Key }))
          .catch(() => undefined),
      ),
    );
    rawClient.destroy();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('completes a presigned multipart upload that headObject then finds at the right size', async () => {
    const key = `videos/${randomUUID()}/original.mp4`;
    createdKeys.push(key);
    const body = Buffer.from('x'.repeat(4096));

    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const partUrl = await service.presignUploadPart(key, uploadId, 1);

    const put = await fetch(partUrl, { method: 'PUT', body });
    expect(put.ok).toBe(true);
    const eTag = put.headers.get('etag');
    expect(eTag).toBeTruthy();

    await service.completeMultipartUpload(key, uploadId, [
      { PartNumber: 1, ETag: eTag! },
    ]);

    const head = await service.headObject(key);
    expect(head.contentLength).toBe(body.length);
  });

  it('aborts an open multipart, and tolerates aborting an unknown uploadId', async () => {
    const key = `videos/${randomUUID()}/original.mp4`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');

    await expect(
      service.abortMultipartUpload(key, uploadId),
    ).resolves.toBeUndefined();

    // Second abort — the multipart no longer exists.
    await expect(
      service.abortMultipartUpload(key, uploadId),
    ).resolves.toBeUndefined();

    // A completely fabricated uploadId also must not throw.
    await expect(
      service.abortMultipartUpload(key, 'this-upload-id-never-existed'),
    ).resolves.toBeUndefined();
  });

  it('round-trips a local file through uploadObject / downloadObject preserving bytes', async () => {
    const key = `videos/${randomUUID()}/thumbnail.jpg`;
    createdKeys.push(key);
    const srcPath = join(tempDir, 'src.bin');
    const destPath = join(tempDir, 'dest.bin');
    const bytes = Buffer.from(Array.from({ length: 2048 }, (_, i) => i % 256));
    await writeFile(srcPath, bytes);

    await service.uploadObject(key, srcPath, 'image/jpeg');

    const head = await service.headObject(key);
    expect(head.contentLength).toBe(bytes.length);

    await service.downloadObject(key, destPath);
    const roundTripped = await readFile(destPath);
    expect(roundTripped.equals(bytes)).toBe(true);
  });

  it('presignGetObject with a disposition yields a URL that forces the download filename', async () => {
    const key = `videos/${randomUUID()}/thumbnail.jpg`;
    createdKeys.push(key);
    const srcPath = join(tempDir, 'disp.bin');
    await writeFile(srcPath, Buffer.from('downloadable-body'));
    await service.uploadObject(key, srcPath, 'image/jpeg');

    const url = await service.presignGetObject(key, {
      disposition: 'attachment; filename="clip.mp4"',
    });
    expect(url).toContain('response-content-disposition=');

    const res = await fetch(url);
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="clip.mp4"',
    );
    expect(await res.text()).toBe('downloadable-body');
  });
});
