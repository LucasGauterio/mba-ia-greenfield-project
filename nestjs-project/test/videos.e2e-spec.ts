import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

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
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
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
    return res.body.access_token;
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

      expect(res.body.id).toBeDefined();
      expect(res.body.slug).toHaveLength(10);
      expect(res.body.status).toBe('draft');
      expect(res.body.uploadId).toBeDefined();
      expect(Array.isArray(res.body.parts)).toBe(true);
      expect(res.body.parts.length).toBeGreaterThan(0);
      expect(res.body.parts[0]).toHaveProperty('partNumber');
      expect(res.body.parts[0]).toHaveProperty('uploadUrl');
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

      expect(res.body.error).toBe('VIDEO_FILE_TOO_LARGE');
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
});
