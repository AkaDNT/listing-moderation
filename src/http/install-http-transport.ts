import { INestApplication } from '@nestjs/common';
import { IncomingMessage, ServerResponse } from 'node:http';
import { TextDecoder } from 'node:util';
import { parseJson } from './json-codec';
import { errorEnvelope, writeJsonResponse } from './errors';

const MAX_BODY_BYTES = 1_048_576;

interface JsonRequest extends IncomingMessage { body?: unknown; }
type Next = (error?: unknown) => void;

export function jsonBodyMiddleware(request: JsonRequest, response: ServerResponse, next: Next): void {
  if (!requestHasBody(request)) { next(); return; }
  if (!hasSupportedJsonHeaders(request)) {
    request.resume();
    writeJsonResponse(response, 400, errorEnvelope('invalid_request', 'Unsupported JSON media type or encoding'));
    return;
  }

  let bytes = 0;
  let settled = false;
  const chunks: Buffer[] = [];
  const cleanup = () => {
    request.off('data', onData);
    request.off('end', onEnd);
    request.off('aborted', onAborted);
    request.off('error', onError);
    request.off('close', onClose);
    response.off('close', onResponseClose);
  };
  const abandon = () => {
    if (settled) return;
    settled = true;
    chunks.length = 0;
    cleanup();
  };
  const reject = (status: number, code: string, message: string) => {
    if (settled) return;
    settled = true;
    chunks.length = 0;
    cleanup();
    writeJsonResponse(response, status, errorEnvelope(code, message));
  };
  const onData = (chunk: Buffer | string) => {
    if (settled) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      reject(413, 'payload_too_large', 'JSON request body exceeds 1 MiB');
      request.resume();
      return;
    }
    chunks.push(buffer);
  };
  const onEnd = () => {
    if (settled) return;
    settled = true;
    cleanup();
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, bytes));
    } catch {
      writeJsonResponse(response, 400, errorEnvelope('invalid_request', 'Request body must be valid UTF-8 JSON'));
      return;
    }
    try { request.body = parseJson(text); }
    catch {
      writeJsonResponse(response, 400, errorEnvelope('invalid_request', 'Request body must be valid JSON'));
      return;
    }
    next();
  };
  const onAborted = () => abandon();
  const onError = () => reject(400, 'invalid_request', 'Unable to read JSON request body');
  const onClose = () => { if (!request.complete) abandon(); };
  const onResponseClose = () => { if (!response.writableEnded) abandon(); };

  request.on('data', onData);
  request.once('end', onEnd);
  request.once('aborted', onAborted);
  request.once('error', onError);
  request.once('close', onClose);
  response.once('close', onResponseClose);
}

export function installHttpTransport(app: INestApplication): void {
  app.use(jsonBodyMiddleware);
}

function requestHasBody(request: IncomingMessage): boolean {
  if (request.headers['transfer-encoding'] !== undefined) return true;
  const length = request.headers['content-length'];
  return length !== undefined && Number(length) > 0;
}

function hasSupportedJsonHeaders(request: IncomingMessage): boolean {
  const type = request.headers['content-type'];
  if (typeof type !== 'string') return false;
  const [media, ...parameters] = type.split(';');
  if (!/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/i.test(media.trim())) return false;

  let charsetSeen = false;
  for (const parameter of parameters) {
    const match = /^\s*charset\s*=\s*(?:"([^"]+)"|([^\s;]+))\s*$/i.exec(parameter);
    if (!match || charsetSeen) return false;
    charsetSeen = true;
    if ((match[1] ?? match[2]).toLowerCase() !== 'utf-8') return false;
  }

  const encoding = request.headers['content-encoding'];
  return encoding === undefined || (typeof encoding === 'string' && encoding.trim().toLowerCase() === 'identity');
}
