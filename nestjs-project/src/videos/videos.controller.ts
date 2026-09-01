import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Redirect,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import type {
  CompleteUploadResult,
  InitiateUploadResult,
  VideoView,
} from './videos.service';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      "Pre-registers the video as a draft on the caller's channel and returns " +
      'presigned multipart-upload URLs. The file is uploaded directly to ' +
      'object storage — it never transits the API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        status: { type: 'string', enum: ['draft'] },
        uploadId: { type: 'string' },
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              partNumber: { type: 'integer' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'File exceeds the size limit, or the body failed validation',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid Bearer token' })
  initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':id/complete-upload')
  @HttpCode(200)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Confirm a completed video upload',
    description:
      'Finalizes the multipart upload with the ETags the client collected, ' +
      'verifies the object landed in storage, transitions the video to ' +
      '`processing` and enqueues it for processing.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Video id' })
  @ApiResponse({
    status: 200,
    description: 'Upload confirmed; processing enqueued',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string', enum: ['processing'] },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'The body failed validation',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid Bearer token' })
  @ApiResponse({
    status: 403,
    description: "Caller does not own the video's channel",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'No video with this id',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The upload has already been completed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 502,
    description: 'The uploaded object could not be verified in storage',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(id, user.sub, dto.parts);
  }

  @Get(':slug')
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary: 'Get a video',
    description:
      'Public video metadata. Anonymous callers see the video only once it is ' +
      '`ready`; the channel owner sees it in any status. Unknown or ' +
      'not-yet-visible videos return 404 (never 403).',
  })
  @ApiParam({ name: 'slug', description: 'Video slug' })
  @ApiResponse({
    status: 200,
    description: 'Video metadata',
    schema: {
      properties: {
        slug: { type: 'string' },
        title: { type: 'string', nullable: true },
        status: {
          type: 'string',
          enum: ['draft', 'processing', 'ready', 'error'],
        },
        durationSeconds: { type: 'integer', nullable: true },
        thumbnailUrl: { type: 'string', nullable: true },
        channel: {
          type: 'object',
          properties: { nickname: { type: 'string' } },
        },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not visible to the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  getVideo(
    @Param('slug') slug: string,
    @CurrentUser() user: JwtPayload | undefined,
  ): Promise<VideoView> {
    return this.videosService.getVideoBySlug(slug, user?.sub);
  }

  @Get(':slug/stream')
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Redirect()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects (302) to a short-lived presigned URL for the original object. ' +
      'The endpoint does not read or forward the Range header — range ' +
      'negotiation happens between the client and storage on the redirect.',
  })
  @ApiParam({ name: 'slug', description: 'Video slug' })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned stream URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not visible to the caller, or has no object yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('slug') slug: string,
    @CurrentUser() user: JwtPayload | undefined,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getStreamRedirectUrl(slug, user?.sub);
    return { url, statusCode: 302 };
  }

  @Get(':slug/download')
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Redirect()
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Like /stream, but the presigned URL carries a Content-Disposition ' +
      'attachment header so the browser saves the file.',
  })
  @ApiParam({ name: 'slug', description: 'Video slug' })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned download URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not visible to the caller, or has no object yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('slug') slug: string,
    @CurrentUser() user: JwtPayload | undefined,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getDownloadRedirectUrl(
      slug,
      user?.sub,
    );
    return { url, statusCode: 302 };
  }
}
