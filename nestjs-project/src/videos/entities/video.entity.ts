import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

export const VIDEO_STATUSES = [
  'draft',
  'processing',
  'ready',
  'error',
] as const;

export type VideoStatus = (typeof VIDEO_STATUSES)[number];

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 10, unique: true })
  slug: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  title: string | null;

  @Index()
  @Column({ type: 'enum', enum: VIDEO_STATUSES, default: 'draft' })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 255, nullable: true })
  error_reason: string | null;

  @Column({ type: 'varchar', length: 512 })
  storage_key: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  @Column({ type: 'int', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  // Unilateral @ManyToOne for now — the inverse @OneToMany on Channel lands in
  // SI-03.5 (VideosModule), once a module registers Video via forFeature
  // (per PLAN §11.2 — adding the inverse earlier breaks AppModule boot).
  @ManyToOne(() => Channel)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
