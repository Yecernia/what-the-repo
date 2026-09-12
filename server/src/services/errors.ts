export class ProductServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ProductServiceError";
  }
}

export function serviceError(code: string, message: string, statusCode: number): ProductServiceError {
  return new ProductServiceError(code, message, statusCode);
}
