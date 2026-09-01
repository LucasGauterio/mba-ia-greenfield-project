import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { MAX_UPLOAD_BYTES } from '../src/videos/videos.constants';

interface InitiateUploadBody {
  id: string;
  slug: string;
  status: string;
  uploadId: string;
  parts: { partNumber: number; url: string }[];
}

interface ErrorBody {
  error: string;
}

interface CompleteUploadBody {
  id: string;
  status: string;
}

describe('Videos — upload initiation (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;

  const validBody = {
    fileName: 'holiday.mp4',
    fileSize: 40 * 1024 ** 2,
    contentType: 'video/mp4',
    title: 'Holiday clip',
  };

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
    videoRepository = dataSource.getRepository(Video);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function accessTokenFor(email: string): Promise<string> {
    const mailService: MailService = app.get(AuthService)['mailService'];
    let token = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_email, _name, confirmationToken) => {
        token = confirmationToken;
        return Promise.resolve();
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123' });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' });

    return (loginRes.body as { access_token: string }).access_token;
  }

  it('returns 201 with the draft descriptor and presigned parts', async () => {
    const accessToken = await accessTokenFor('uploader@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(validBody)
      .expect(201);
    const body = res.body as InitiateUploadBody;

    expect(typeof body.id).toBe('string');
    expect(body.slug).toHaveLength(10);
    expect(body.status).toBe('draft');
    expect(typeof body.uploadId).toBe('string');
    expect(body.parts[0].partNumber).toBe(1);
    expect(body.parts[0].url).toContain('http');
  });

  it("persists a draft row on the caller's channel with the upload id set", async () => {
    const accessToken = await accessTokenFor('persist@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(validBody)
      .expect(201);
    const body = res.body as InitiateUploadBody;

    const row = await videoRepository.findOne({
      where: { slug: body.slug },
      relations: ['channel'],
    });
    expect(row).not.toBeNull();
    expect(row?.status).toBe('draft');
    expect(typeof row?.upload_id).toBe('string');
    expect(row?.channel.user_id).toBeDefined();
  });

  it('returns 400 VIDEO_FILE_TOO_LARGE above the 10 GiB limit', async () => {
    const accessToken = await accessTokenFor('toobig@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ...validBody, fileSize: MAX_UPLOAD_BYTES + 1 })
      .expect(400);

    expect((res.body as ErrorBody).error).toBe('VIDEO_FILE_TOO_LARGE');
  });

  it('returns 400 VALIDATION_ERROR on a malformed body', async () => {
    const accessToken = await accessTokenFor('badbody@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fileName: 'noext', fileSize: 0 })
      .expect(400);

    expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
  });

  it('returns 401 without a Bearer token', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .send(validBody)
      .expect(401);
  });

  describe('POST /videos/:id/complete-upload', () => {
    async function initiate(accessToken: string): Promise<InitiateUploadBody> {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(validBody)
        .expect(201);
      return res.body as InitiateUploadBody;
    }

    async function uploadParts(
      draft: InitiateUploadBody,
    ): Promise<{ partNumber: number; eTag: string }[]> {
      const parts: { partNumber: number; eTag: string }[] = [];
      for (const part of draft.parts) {
        const put = await fetch(part.url, {
          method: 'PUT',
          body: Buffer.from('x'.repeat(1024)),
        });
        expect(put.ok).toBe(true);
        parts.push({
          partNumber: part.partNumber,
          eTag: put.headers.get('etag') as string,
        });
      }
      return parts;
    }

    it('returns 200 { id, status: processing } and flips the row on the happy path', async () => {
      const accessToken = await accessTokenFor('complete@example.com');
      const draft = await initiate(accessToken);
      const parts = await uploadParts(draft);

      const res = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts })
        .expect(200);
      const body = res.body as CompleteUploadBody;

      expect(body.id).toBe(draft.id);
      expect(body.status).toBe('processing');

      const row = await videoRepository.findOne({ where: { id: draft.id } });
      expect(row?.status).toBe('processing');
      expect(row?.upload_id).toBeNull();
    });

    it('returns 403 VIDEO_NOT_OWNED for a caller who does not own the channel', async () => {
      const ownerToken = await accessTokenFor('owner@example.com');
      const draft = await initiate(ownerToken);

      const strangerToken = await accessTokenFor('stranger@example.com');
      const res = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/complete-upload`)
        .set('Authorization', `Bearer ${strangerToken}`)
        .send({ parts: [{ partNumber: 1, eTag: 'whatever' }] })
        .expect(403);

      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_OWNED');
    });

    it('returns 409 VIDEO_UPLOAD_ALREADY_COMPLETED when the video is no longer draft', async () => {
      const accessToken = await accessTokenFor('twice@example.com');
      const draft = await initiate(accessToken);
      const parts = await uploadParts(draft);

      await request(app.getHttpServer())
        .post(`/videos/${draft.id}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts })
        .expect(409);

      expect((res.body as ErrorBody).error).toBe(
        'VIDEO_UPLOAD_ALREADY_COMPLETED',
      );
    });
  });

  describe('GET /videos/:slug read routes', () => {
    interface VideoViewBody {
      slug: string;
      title: string | null;
      status: string;
      durationSeconds: number | null;
      thumbnailUrl: string | null;
      channel: { nickname: string };
    }

    async function completedVideo(
      accessToken: string,
    ): Promise<InitiateUploadBody> {
      const initRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(validBody)
        .expect(201);
      const draft = initRes.body as InitiateUploadBody;

      const parts: { partNumber: number; eTag: string }[] = [];
      for (const part of draft.parts) {
        const put = await fetch(part.url, {
          method: 'PUT',
          body: Buffer.from('x'.repeat(1024)),
        });
        parts.push({
          partNumber: part.partNumber,
          eTag: put.headers.get('etag') as string,
        });
      }

      await request(app.getHttpServer())
        .post(`/videos/${draft.id}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts })
        .expect(200);

      return draft;
    }

    async function markReady(id: string): Promise<void> {
      await videoRepository.update(
        { id },
        {
          status: 'ready',
          duration_seconds: 5,
          thumbnail_key: `videos/${id}/thumbnail.jpg`,
        },
      );
    }

    it('returns 200 public metadata for a ready video to an anonymous caller', async () => {
      const token = await accessTokenFor('reader@example.com');
      const draft = await completedVideo(token);
      await markReady(draft.id);

      const res = await request(app.getHttpServer())
        .get(`/videos/${draft.slug}`)
        .expect(200);
      const body = res.body as VideoViewBody;

      expect(body.slug).toBe(draft.slug);
      expect(body.status).toBe('ready');
      expect(body.durationSeconds).toBe(5);
      expect(typeof body.thumbnailUrl).toBe('string');
      expect(typeof body.channel.nickname).toBe('string');
    });

    it('returns 404 VIDEO_NOT_FOUND for a non-ready video to an anonymous caller', async () => {
      const token = await accessTokenFor('hidden@example.com');
      const draft = await completedVideo(token); // stays "processing"

      const res = await request(app.getHttpServer())
        .get(`/videos/${draft.slug}`)
        .expect(404);
      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 200 for a non-ready video when the owner asks', async () => {
      const token = await accessTokenFor('me@example.com');
      const draft = await completedVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${draft.slug}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((res.body as VideoViewBody).status).toBe('processing');
    });

    it('redirects 302 to a presigned URL on /stream for a ready video', async () => {
      const token = await accessTokenFor('streamer@example.com');
      const draft = await completedVideo(token);
      await markReady(draft.id);

      const res = await request(app.getHttpServer())
        .get(`/videos/${draft.slug}/stream`)
        .expect(302);

      expect(res.headers.location).toContain('http');
      expect(res.headers.location).toContain('X-Amz-Signature');
    });

    it('redirects 302 with an attachment disposition on /download', async () => {
      const token = await accessTokenFor('downloader@example.com');
      const draft = await completedVideo(token);
      await markReady(draft.id);

      const res = await request(app.getHttpServer())
        .get(`/videos/${draft.slug}/download`)
        .expect(302);

      const location: string = res.headers.location;
      expect(location).toContain('response-content-disposition=');
      expect(decodeURIComponent(location)).toContain('attachment;');
    });
  });
});
