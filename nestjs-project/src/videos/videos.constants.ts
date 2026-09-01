/** Object-storage key layout — single bucket, per-video prefix (phase-03-videos/TD-04). */
export const VIDEOS_KEY_PREFIX = 'videos';

export function originalKey(videoId: string, extension: string): string {
  return `${VIDEOS_KEY_PREFIX}/${videoId}/original.${extension}`;
}

export function thumbnailKey(videoId: string): string {
  return `${VIDEOS_KEY_PREFIX}/${videoId}/thumbnail.jpg`;
}

/** Lower-cased file extension without the leading dot; `bin` when absent. */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return 'bin';
  return fileName.slice(dot + 1).toLowerCase();
}

/** 10 GiB hard cap on a single upload (phase-03-videos/TD-02). */
export const MAX_UPLOAD_BYTES = 10 * 1024 ** 3;

/**
 * Multipart part size. 64 MiB keeps a 10 GiB upload at ~160 parts — far below
 * the S3 10,000-part limit — while staying above the 5 MiB minimum part size.
 */
export const MULTIPART_PART_SIZE = 64 * 1024 ** 2;

/** Number of presigned part URLs to issue for a file of the given size. */
export function partCount(fileSize: number): number {
  return Math.max(1, Math.ceil(fileSize / MULTIPART_PART_SIZE));
}

export const PRESIGN_TTL_SECONDS = {
  /** Per-part upload URLs — large parts over slow links. */
  UPLOAD_PART: 60 * 60,
  /** Stream / download redirect targets — short-lived by design. */
  GET_OBJECT: 15 * 60,
} as const;

/**
 * A `draft` older than this with an open multipart is considered abandoned and
 * reclaimed by the hourly sweep (abandoned-upload-cleanup/TD-01).
 */
export const ABANDONED_UPLOAD_TTL_HOURS = 24;

/** Cron for the abandoned-upload sweep — hourly (abandoned-upload-cleanup/TD-01). */
export const ABANDONED_UPLOAD_SWEEP_CRON = '0 * * * *';

/** `error_reason` written on a row reclaimed by the sweep. */
export const ABANDONED_UPLOAD_ERROR_REASON = 'upload_abandoned_ttl_exceeded';
