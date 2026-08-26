import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateVideoDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsString()
  @IsNotEmpty()
  fileName: string;

  @IsInt()
  @IsPositive()
  fileSize: number;

  @IsString()
  @IsNotEmpty()
  contentType: string;
}
