import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify GitHub webhook HMAC-SHA256 signature.
 * Returns true if the signature header matches the expected HMAC of the raw body.
 */
export function verifySignature(secret: string, rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;

  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');

  if (expected.length !== signatureHeader.length) return false;

  return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}
