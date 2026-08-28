import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  AuthTokens,
  CompleteUploadResult,
  ErrorEnvelope,
  InitiateUploadResult,
} from './contracts';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const mailService = app.get(MailService);
    let capturedToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_email, _name, token) => {
        capturedToken = token;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return (res.body as AuthTokens).access_token;
  }

  async function initiateVideoUpload(
    accessToken: string,
  ): Promise<InitiateUploadResult> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        fileName: 'clip.txt',
        fileSize: 10,
        contentType: 'text/plain',
      })
      .expect(201);
    return res.body as InitiateUploadResult;
  }

  async function uploadPart(uploadUrl: string): Promise<string> {
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      body: Buffer.from('0123456789'),
    });
    const etag = res.headers.get('etag');
    if (etag === null) {
      throw new Error('Storage did not return an ETag for the uploaded part');
    }
    return etag.replace(/"/g, '');
  }

  describe('POST /videos', () => {
    it('returns 201 with id, slug, status draft, uploadId and parts for a valid request', async () => {
      const accessToken = await registerConfirmAndLogin(
        'video_owner@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          fileName: 'movie.mp4',
          fileSize: 12 * 1024 ** 2,
          contentType: 'video/mp4',
          title: 'My movie',
        })
        .expect(201);

      const body = res.body as InitiateUploadResult;
      expect(body.id).toBeDefined();
      expect(body.slug).toHaveLength(10);
      expect(body.status).toBe('draft');
      expect(body.uploadId).toBeDefined();
      expect(Array.isArray(body.parts)).toBe(true);
      expect(body.parts.length).toBeGreaterThan(0);
      expect(body.parts[0]).toHaveProperty('partNumber');
      expect(body.parts[0]).toHaveProperty('uploadUrl');
    }, 30000);

    it('returns 400 VIDEO_FILE_TOO_LARGE when fileSize exceeds the 10GB cap', async () => {
      const accessToken = await registerConfirmAndLogin(
        'big_upload@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          fileName: 'huge.mp4',
          fileSize: 10 * 1024 ** 3 + 1,
          contentType: 'video/mp4',
        })
        .expect(400);

      expect((res.body as ErrorEnvelope).error).toBe('VIDEO_FILE_TOO_LARGE');
    }, 30000);

    it('returns 400 for missing required fields', async () => {
      const accessToken = await registerConfirmAndLogin(
        'missing_fields@example.com',
      );

      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'No file info' })
        .expect(400);
    }, 30000);

    it('returns 401 without a JWT', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({
          fileName: 'movie.mp4',
          fileSize: 1024,
          contentType: 'video/mp4',
        })
        .expect(401);
    });
  });

  describe('POST /videos/:id/complete-upload', () => {
    it('returns 200 and flips status to processing for the owner with valid parts', async () => {
      const accessToken = await registerConfirmAndLogin(
        'complete_owner@example.com',
      );
      const draft = await initiateVideoUpload(accessToken);
      const eTag = await uploadPart(draft.parts[0].uploadUrl);

      const res = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, eTag }] })
        .expect(200);

      expect(res.body as CompleteUploadResult).toEqual({
        id: draft.id,
        status: 'processing',
      });
    }, 30000);

    it('returns 403 VIDEO_NOT_OWNED for a non-owner', async () => {
      const ownerToken = await registerConfirmAndLogin(
        'complete_owner2@example.com',
      );
      const draft = await initiateVideoUpload(ownerToken);
      const otherToken = await registerConfirmAndLogin(
        'complete_other@example.com',
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/complete-upload`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ parts: [{ partNumber: 1, eTag: 'etag' }] })
        .expect(403);

      expect((res.body as ErrorEnvelope).error).toBe('VIDEO_NOT_OWNED');
    }, 30000);

    it('returns 409 VIDEO_UPLOAD_ALREADY_COMPLETED when the video is not draft', async () => {
      const accessToken = await registerConfirmAndLogin(
        'complete_twice@example.com',
      );
      const draft = await initiateVideoUpload(accessToken);
      const eTag = await uploadPart(draft.parts[0].uploadUrl);

      await request(app.getHttpServer())
        .post(`/videos/${draft.id}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, eTag }] })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, eTag }] })
        .expect(409);

      expect((res.body as ErrorEnvelope).error).toBe(
        'VIDEO_UPLOAD_ALREADY_COMPLETED',
      );
    }, 30000);

    it('returns 404 VIDEO_NOT_FOUND for an unknown video id', async () => {
      const accessToken = await registerConfirmAndLogin(
        'complete_unknown@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/complete-upload')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, eTag: 'etag' }] })
        .expect(404);

      expect((res.body as ErrorEnvelope).error).toBe('VIDEO_NOT_FOUND');
    }, 30000);

    it('returns 400 for missing/invalid parts', async () => {
      const accessToken = await registerConfirmAndLogin(
        'complete_invalid@example.com',
      );
      const draft = await initiateVideoUpload(accessToken);

      await request(app.getHttpServer())
        .post(`/videos/${draft.id}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [] })
        .expect(400);
    }, 30000);

    it('returns 401 without a JWT', async () => {
      await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/complete-upload')
        .send({ parts: [{ partNumber: 1, eTag: 'etag' }] })
        .expect(401);
    });
  });
});
