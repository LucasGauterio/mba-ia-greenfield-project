import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { StorageService } from '../videos/storage.service';
import { VideoProcessingWorker } from './video-processing.worker';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  let moduleRef: TestingModule;

  afterAll(async () => {
    await moduleRef.close();
  });

  it('compiles with forFeature([Video, Channel, User]) and wires the worker + storage', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(moduleRef.get(VideoProcessingWorker)).toBeInstanceOf(
      VideoProcessingWorker,
    );
    expect(moduleRef.get(StorageService)).toBeInstanceOf(StorageService);
  }, 30000);
});
