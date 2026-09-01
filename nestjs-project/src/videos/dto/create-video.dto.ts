import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateVideoDto {
  @IsString()
  @MinLength(1)
  @Matches(/\.[^./\\\s]+$/, {
    message: 'fileName must include a file extension',
  })
  fileName: string;

  @IsInt()
  @Min(1)
  fileSize: number;

  @IsString()
  @MinLength(1)
  contentType: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;
}
