export const PG_BOSS = Symbol('PG_BOSS');

export const QUEUE_NAMES = {
  VIDEO_PROCESSING: 'video-processing',
  CLEANUP_ABANDONED_UPLOADS: 'cleanup-abandoned-uploads',
} as const;

export const CLEANUP_ABANDONED_UPLOADS_CRON = '0 * * * *';
