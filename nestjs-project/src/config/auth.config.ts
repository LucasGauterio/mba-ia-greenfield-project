import { registerAs } from '@nestjs/config';

/**
 * Reads a required environment variable. The Joi schema in
 * `src/config/env.validation.ts` already guarantees presence at boot; this
 * throws only if the factory is somehow evaluated before validation.
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export default registerAs('auth', () => ({
  jwtSecret: required('JWT_SECRET'),
  jwtRefreshSecret: required('JWT_REFRESH_SECRET'),
  jwtAccessExpiration: process.env.JWT_ACCESS_EXPIRATION || '15m',
  jwtRefreshExpiration: process.env.JWT_REFRESH_EXPIRATION || '7d',
  confirmationTokenExpirationHours: parseInt(
    process.env.CONFIRMATION_TOKEN_EXPIRATION_HOURS || '1',
    10,
  ),
  passwordResetTokenExpirationHours: parseInt(
    process.env.PASSWORD_RESET_TOKEN_EXPIRATION_HOURS || '1',
    10,
  ),
}));
