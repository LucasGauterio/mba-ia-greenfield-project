import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CompletedPartDto {
  /** 1-based part number, matching the order the parts were uploaded in. */
  @IsInt()
  @Min(1)
  partNumber: number;

  /** The `ETag` object storage returned for this uploaded part. */
  @IsString()
  @MinLength(1)
  eTag: string;
}

export class CompleteUploadDto {
  /** The uploaded parts, in part-number order. */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
