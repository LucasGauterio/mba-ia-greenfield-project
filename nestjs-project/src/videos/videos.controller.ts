import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Redirect,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
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
import {
  CompleteUploadResult,
  InitiateUploadResult,
  VideoDetailResult,
  VideosService,
} from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Pre-registers the video as a draft and returns presigned multipart upload URLs.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        status: { type: 'string', example: 'draft' },
        uploadId: { type: 'string' },
        parts: {
          type: 'array',
          items: {
            properties: {
              partNumber: { type: 'number' },
              uploadUrl: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or file exceeds the 10GB cap',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':id/complete-upload')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Finalizes the multipart upload, verifies the object in storage, and enqueues processing.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed and processing enqueued',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Authenticated user does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video upload has already been completed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 502,
    description: 'Upload could not be verified in storage',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(user.sub, id, dto);
  }

  @Get(':slug')
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary: 'Get video details',
    description:
      'Returns video details. Ready videos are visible to anyone; non-ready videos are visible only to their owner.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video details',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        title: { type: 'string', nullable: true },
        status: { type: 'string', example: 'ready' },
        durationSeconds: { type: 'number', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found, or not visible to the requester',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getBySlug(
    @CurrentUser() user: JwtPayload | undefined,
    @Param('slug') slug: string,
  ): Promise<VideoDetailResult> {
    return this.videosService.findBySlug(slug, user?.sub);
  }

  @Get(':slug/stream')
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Redirect()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects to a presigned storage URL for streaming (supports Range requests). Same visibility rule as GET /videos/:slug.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to a presigned URL' })
  @ApiResponse({
    status: 404,
    description: 'Video not found, or not visible to the requester',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @CurrentUser() user: JwtPayload | undefined,
    @Param('slug') slug: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getStreamUrl(slug, user?.sub);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Get(':slug/download')
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Redirect()
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects to a presigned storage URL with response-content-disposition=attachment. Same visibility rule as GET /videos/:slug.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to a presigned URL' })
  @ApiResponse({
    status: 404,
    description: 'Video not found, or not visible to the requester',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @CurrentUser() user: JwtPayload | undefined,
    @Param('slug') slug: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getDownloadUrl(slug, user?.sub);
    return { url, statusCode: HttpStatus.FOUND };
  }
}
