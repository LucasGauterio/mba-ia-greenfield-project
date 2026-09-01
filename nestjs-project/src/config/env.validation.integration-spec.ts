import * as Joi from 'joi';
import { envValidationSchema } from './env.validation';

interface ValidatedEnv {
  SWAGGER_ENABLED: string;
}

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ENDPOINT: 'http://minio:9000',
  STORAGE_REGION: 'us-east-1',
  STORAGE_BUCKET: 'streamtube',
  STORAGE_ACCESS_KEY_ID: 'streamtube',
  STORAGE_SECRET_ACCESS_KEY: 'streamtube',
};

// Joi's `ValidationResult.value` is typed `any` regardless of the schema
// generic, so narrow it explicitly here to keep the assertions type-safe.
const validate = (
  env: Record<string, string>,
): { value: ValidatedEnv; error?: Joi.ValidationError } =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  ) as { value: ValidatedEnv; error?: Joi.ValidationError };

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});
