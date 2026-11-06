/** Error whose message is safe to return to clients. */
export class AppError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (code: string, msg: string) => new AppError(400, code, msg);
export const unauthorized = () => new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
export const forbidden = () => new AppError(403, 'FORBIDDEN', 'Not allowed');
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, msg: string) => new AppError(409, code, msg);
