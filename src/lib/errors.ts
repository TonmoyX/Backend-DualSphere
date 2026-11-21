export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public details?: unknown,
  ) {
    super(message ?? code);
  }
}

export const badRequest = (code: string, message?: string, details?: unknown) => new AppError(400, code, message, details);
export const unauthorized = (code = 'UNAUTHORIZED', message = 'Authentication required') => new AppError(401, code, message);
export const forbidden = (code = 'FORBIDDEN', message = 'Insufficient permissions') => new AppError(403, code, message);
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, message?: string) => new AppError(409, code, message);
export const tooMany = (message = 'Too many requests') => new AppError(429, 'RATE_LIMITED', message);
