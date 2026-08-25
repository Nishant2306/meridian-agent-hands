import type { AddressInfo } from 'node:net';
import { createLegacyApp, type LegacyAppOptions } from '../../fixtures/legacy-app/server.js';

export interface RunningLegacyApp {
  readonly baseUrl: string;
  readonly seed: number;
  close(): Promise<void>;
}

/** Boot the fixture on an ephemeral port. */
export async function startLegacyApp(options: LegacyAppOptions = {}): Promise<RunningLegacyApp> {
  const { app, seed } = createLegacyApp(options);

  return await new Promise<RunningLegacyApp>((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        seed,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/** Sign on and return the session cookie header value. The fixture accepts any non-empty pair. */
export async function signOn(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ctl00$Main$txtOperator: 'fixture-operator',
      ctl00$Main$txtPasscode: 'fixture-passcode',
    }).toString(),
  });

  const setCookie = response.headers.get('set-cookie');
  if (setCookie === null) throw new Error('fixture did not issue a session cookie');
  const value = setCookie.split(';')[0];
  if (value === undefined) throw new Error('malformed session cookie');
  return value;
}

export async function getHtml(baseUrl: string, path: string, cookie: string): Promise<string> {
  const response = await fetch(`${baseUrl}${path}`, { headers: { cookie }, redirect: 'manual' });
  return await response.text();
}

export function attributeValues(html: string, attribute: string): string[] {
  const pattern = new RegExp(`${attribute}="([^"]*)"`, 'g');
  return [...html.matchAll(pattern)].map((match) => match[1] ?? '');
}
