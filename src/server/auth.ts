import { createHmac, randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const COOKIE_NAME = 'hurlicane_session';
const USERNAME_COOKIE = 'hurlicane_user';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const secret = process.env.AUTH_SECRET ?? randomBytes(32).toString('hex');

export function isAuthEnabled(): boolean {
  return !!process.env.AUTH_PASSWORD;
}

function sign(timestamp: string): string {
  return createHmac('sha256', secret).update(timestamp).digest('hex');
}

function makeSessionValue(): string {
  const ts = String(Date.now());
  return `${ts}.${sign(ts)}`;
}

function isValidSession(cookieValue: string): boolean {
  const dot = cookieValue.indexOf('.');
  if (dot === -1) return false;
  const ts = cookieValue.substring(0, dot);
  const sig = cookieValue.substring(dot + 1);

  // Check signature
  if (sign(ts) !== sig) return false;

  // Check expiry
  const age = Date.now() - Number(ts);
  if (age < 0 || age > COOKIE_MAX_AGE_MS) return false;

  return true;
}

function parseCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

function hasValidCookie(cookieHeader: string | undefined): boolean {
  const value = parseCookie(cookieHeader, COOKIE_NAME);
  return !!value && isValidSession(value);
}

/** Express middleware — gates all routes below it when AUTH_PASSWORD is set. */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthEnabled()) return next();
  if (hasValidCookie(req.headers.cookie)) return next();

  // Allow localhost requests (internal service-to-service, e.g. Eye → orchestrator)
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();

  // API calls get JSON 401
  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // Browser requests get the login page
  res.status(401).send(getLoginPageHtml());
}

/** POST /auth/login handler */
export function handleLogin(req: Request, res: Response): void {
  if (!isAuthEnabled()) {
    res.redirect('/');
    return;
  }

  const password = req.body?.password;
  const username = (req.body?.username ?? '').trim();
  if (password !== process.env.AUTH_PASSWORD) {
    res.status(401).send(getLoginPageHtml('Invalid password'));
    return;
  }

  if (!username) {
    res.status(401).send(getLoginPageHtml('Username is required'));
    return;
  }

  const maxAge = Math.floor(COOKIE_MAX_AGE_MS / 1000);
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=${makeSessionValue()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
    `${USERNAME_COOKIE}=${encodeURIComponent(username)}; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
  ]);
  res.redirect('/');
}

/** Clear session cookie */
export function handleLogout(_req: Request, res: Response): void {
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    `${USERNAME_COOKIE}=; SameSite=Lax; Path=/; Max-Age=0`,
  ]);
  res.redirect('/');
}

/** Validate cookie from Socket.io handshake */
export function isSocketAuthenticated(cookieHeader: string | undefined): boolean {
  if (!isAuthEnabled()) return true;
  return hasValidCookie(cookieHeader);
}

/** Extract username from cookie header */
export function getUsername(req: Request): string | null {
  const value = parseCookie(req.headers.cookie, USERNAME_COOKIE);
  return value ? decodeURIComponent(value) : null;
}

/** GET /api/me handler */
export function handleMe(req: Request, res: Response): void {
  const username = getUsername(req);
  res.json({ username, authEnabled: isAuthEnabled() });
}

function getLoginPageHtml(error?: string): string {
  const errorHtml = error
    ? `<div style="color:#f87171;margin-bottom:16px;font-size:14px">${error}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hurlicane — Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #171717;
      border: 1px solid #262626;
      border-radius: 12px;
      padding: 40px;
      width: 100%;
      max-width: 380px;
    }
    h1 { font-size: 20px; margin-bottom: 24px; text-align: center; }
    input[type="text"], input[type="password"] {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #404040;
      border-radius: 6px;
      background: #0a0a0a;
      color: #e5e5e5;
      font-size: 14px;
      margin-bottom: 16px;
      outline: none;
    }
    input[type="text"]:focus, input[type="password"]:focus { border-color: #6366f1; }
    button {
      width: 100%;
      padding: 10px;
      border: none;
      border-radius: 6px;
      background: #6366f1;
      color: #fff;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
    }
    button:hover { background: #4f46e5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Hurlicane</h1>
    ${errorHtml}
    <form method="POST" action="/auth/login">
      <input type="text" name="username" placeholder="Username" autofocus required>
      <input type="password" name="password" placeholder="Password" required>
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;
}
