const SESSION_COOKIE = '__Host-openmaic_feishu';
const STATE_COOKIE = '__Host-openmaic_feishu_state';
const SESSION_AGE = 7 * 24 * 60 * 60;
const STATE_AGE = 10 * 60;
const encoder = new TextEncoder();

type FeishuUser = { open_id: string; name?: string };
type Session = { sub: string; exp: number };

export function isFeishuAuthRequired() {
  return process.env.FEISHU_AUTH_REQUIRED === '1';
}

export function isFeishuAuthConfigured() {
  return Boolean(
    process.env.FEISHU_APP_ID?.trim() &&
    process.env.FEISHU_APP_SECRET?.trim() &&
    process.env.AUTH_SESSION_SECRET?.trim() &&
    process.env.FEISHU_REDIRECT_URI?.trim(),
  );
}

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function decodeBase64Url(value: string) {
  const decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function signingKey(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function cookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name: string) {
  return cookie(name, '', 0);
}

function readCookie(request: Request, name: string) {
  return request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function redirect(location: string, cookies: string[] = []) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(null, { status: 302, headers });
}

export async function createFeishuSession(user: FeishuUser, secret: string) {
  const payload = base64Url(
    encoder.encode(
      JSON.stringify({ sub: user.open_id, exp: Math.floor(Date.now() / 1000) + SESSION_AGE }),
    ),
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    await signingKey(secret),
    encoder.encode(payload),
  );
  return cookie(SESSION_COOKIE, `${payload}.${base64Url(new Uint8Array(signature))}`, SESSION_AGE);
}

export async function getFeishuSession(request: Request): Promise<Session | null> {
  const secret = process.env.AUTH_SESSION_SECRET?.trim();
  const value = readCookie(request, SESSION_COOKIE);
  if (!secret || !value) return null;

  try {
    const [payload, signature, extra] = value.split('.');
    if (!payload || !signature || extra) return null;
    const valid = await crypto.subtle.verify(
      'HMAC',
      await signingKey(secret),
      decodeBase64Url(signature),
      encoder.encode(payload),
    );
    if (!valid) return null;
    const session = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as Session;
    return typeof session.sub === 'string' &&
      session.sub.length > 0 &&
      typeof session.exp === 'number' &&
      session.exp > Math.floor(Date.now() / 1000)
      ? session
      : null;
  } catch {
    return null;
  }
}

/** Stable account key without exposing the Feishu open_id in storage paths or the UI. */
export async function feishuAccountId(subject: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`feishu:${subject}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function startFeishuLogin() {
  if (!isFeishuAuthConfigured())
    return new Response('Feishu login is not configured', { status: 503 });
  const state = crypto.randomUUID();
  const url = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
  url.searchParams.set('client_id', process.env.FEISHU_APP_ID!.trim());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', process.env.FEISHU_REDIRECT_URI!.trim());
  url.searchParams.set('state', state);
  return redirect(url.toString(), [cookie(STATE_COOKIE, state, STATE_AGE)]);
}

export async function finishFeishuLogin(request: Request) {
  if (!isFeishuAuthConfigured())
    return new Response('Feishu login is not configured', { status: 503 });
  const params = new URL(request.url).searchParams;
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state || state !== readCookie(request, STATE_COOKIE)) {
    return new Response('Invalid Feishu login callback', { status: 400 });
  }

  try {
    const tokenResponse = await fetch('https://accounts.feishu.cn/oauth/v3/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.FEISHU_APP_ID!.trim(),
        client_secret: process.env.FEISHU_APP_SECRET!.trim(),
        code,
        redirect_uri: process.env.FEISHU_REDIRECT_URI!.trim(),
      }),
    });
    const token = (await tokenResponse.json()) as { code?: number; access_token?: string };
    if (!tokenResponse.ok || token.code !== 0 || !token.access_token) throw new Error('token');

    const userResponse = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const user = (await userResponse.json()) as { code?: number; data?: FeishuUser };
    if (!userResponse.ok || user.code !== 0 || !user.data?.open_id) throw new Error('user');

    const sessionCookie = await createFeishuSession(
      user.data,
      process.env.AUTH_SESSION_SECRET!.trim(),
    );
    return redirect(new URL('/', request.url).toString(), [
      sessionCookie,
      clearCookie(STATE_COOKIE),
    ]);
  } catch {
    return new Response('Feishu login failed', { status: 502 });
  }
}
