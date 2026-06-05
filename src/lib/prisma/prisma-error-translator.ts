import { Prisma } from '@prisma/client';
import { DatabaseError, NotFoundError, ValidationError } from '@/lib/errors';

/**
 * Prisma error codes and their mapped application errors.
 *
 * Reference: https://www.prisma.io/docs/orm/reference/error-reference
 */
const PRISMA_ERROR_MAP: Record<string, PrismaErrorMapping> = {
  // Unique constraint violation
  P2002: {
    errorClass: ValidationError,
    message: 'A record with this value already exists',
    retryable: false,
  },
  // Foreign key constraint violation
  P2003: {
    errorClass: ValidationError,
    message: 'Referenced record does not exist',
    retryable: false,
  },
  // Record not found (findUniqueOrThrow, findFirstOrThrow)
  P2025: {
    errorClass: NotFoundError,
    message: 'Record not found',
    retryable: false,
  },
  // Connection pool timeout
  P2024: {
    errorClass: DatabaseError,
    message: 'Database connection pool timeout',
    retryable: true,
  },
  // Cannot connect to database
  P1001: {
    errorClass: DatabaseError,
    message: 'Cannot connect to database server',
    retryable: true,
  },
  // Connection timed out
  P1002: {
    errorClass: DatabaseError,
    message: 'Database connection timed out',
    retryable: true,
  },
  // Database does not exist
  P1003: {
    errorClass: DatabaseError,
    message: 'Database does not exist',
    retryable: false,
  },
  // Authentication failed
  P1000: {
    errorClass: DatabaseError,
    message: 'Database authentication failed',
    retryable: false,
  },
};

interface PrismaErrorMapping {
  errorClass: typeof DatabaseError | typeof NotFoundError | typeof ValidationError;
  message: string;
  retryable: boolean;
}

/**
 * Translates a Prisma error into the appropriate application error.
 *
 * Handles:
 * - Known Prisma error codes (P2002, P2025, etc.) → typed AppError
 * - Unknown Prisma error codes → generic DatabaseError
 * - Non-Prisma errors → re-thrown as-is
 *
 * @param err - The caught error
 * @param defaultMessage - Fallback message if the error code is unknown
 * @returns A typed AppError instance
 *
 * @example
 * try {
 *   return await prisma.match.findUniqueOrThrow({ where: { id } });
 * } catch (err) {
 *   throw translatePrismaError(err, 'Failed to fetch match');
 * }
 */
export function translatePrismaError(
  err: unknown,
  defaultMessage: string,
): Error {
  // If it's not a Prisma error, return as-is
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
    if (err instanceof Error) {
      return err;
    }
    return new Error(String(err));
  }

  const mapping = PRISMA_ERROR_MAP[err.code];

  if (mapping) {
    return new mapping.errorClass(mapping.message, {
      cause: err,
      retryable: mapping.retryable,
      context: {
        prismaCode: err.code,
        model: (err.meta as Record<string, unknown> | undefined)?.modelName,
        field: (err.meta as Record<string, unknown> | undefined)?.target,
      },
    });
  }

  // Unknown Prisma error code — wrap in generic DatabaseError
  return new DatabaseError(defaultMessage, {
    retryable: true,
    cause: err,
    context: {
      prismaCode: err.code,
      prismaMessage: err.message,
    },
  });
}
