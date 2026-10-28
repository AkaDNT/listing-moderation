import { ServerResponse } from 'node:http';
import { stringifyJson } from './json-codec';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ErrorEnvelope {
  error: { code: string; message: string };
}

export function errorEnvelope(code: string, message: string): ErrorEnvelope {
  return { error: { code, message } };
}

const SAFE_INTERNAL_ERROR = '{"error":{"code":"internal_error","message":"Internal server error"}}';

export function writeJsonResponse(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent || response.destroyed) return;
  let body: string;
  try { body = stringifyJson(value); }
  catch { body = SAFE_INTERNAL_ERROR; status = 500; }
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(body);
}
