import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { InitiateUploadResult, VideosService } from './videos.service';

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
}
