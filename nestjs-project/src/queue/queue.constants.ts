/** Job queue name for the async video-processing pipeline (phase-03-videos/TD-01). */
export const QUEUE_VIDEO_PROCESSING = 'video-processing';

/** Scheduled queue that reclaims abandoned uploads (abandoned-upload-cleanup/TD-01). */
export const QUEUE_ABANDONED_UPLOAD_SWEEP = 'abandoned-upload-sweep';

/** Payload of a `video-processing` job (see Events/Messages → video-processing). */
export interface VideoProcessingPayload {
  videoId: string;
}

/**
 * Retry policy for `video-processing` jobs (phase-03-videos/TD-08). pg-boss v10
 * defaults `retryLimit` to 2 — pinned to 3 explicitly here.
 */
export const VIDEO_PROCESSING_JOB_OPTIONS = {
  retryLimit: 3,
  retryDelay: 5,
  retryBackoff: true,
} as const;
