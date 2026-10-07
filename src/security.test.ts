import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { N01_ALLOWED_HOSTS, N01_OPERATIONS, isAllowedN01Url } from './integrations/n01/endpoints';
import { N01Client, createFetchTransport } from './integrations/n01/client';

/**
 * Security review as tests (MASTER SPEC Phase 6 §11): no credentials, no write API, no
 * secrets, no unsafe HTML, URL validation. Static checks run over the shipped source
 * (tests and test fixtures excluded), so a regression fails the suite.
 */

const ROOT = join(__dirname);

function sourceFiles(dir = ROOT): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'test' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles().map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }));

function offenders(pattern: RegExp): string[] {
  return files.filter((file) => pattern.test(file.text)).map((file) => file.path);
}

describe('security review (Phase 6 §11)', () => {
  it('scans the shipped source', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((file) => file.path.startsWith('integrations/n01/'))).toBe(true);
  });

  it('no unsafe HTML or dynamic code', () => {
    expect(offenders(/dangerouslySetInnerHTML|\.innerHTML\s*=|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/)).toEqual([]);
  });

  it('no credentials or secrets: no auth headers, keys or tokens in the source', () => {
    expect(offenders(/authorization|bearer\s|api[_-]?key|client[_-]?secret|access[_-]?token|x-api-key/i)).toEqual([]);
  });

  it('read-only n01: only read operations exist, and the only HTTP method used is GET', () => {
    for (const operation of N01_OPERATIONS) expect(operation).toMatch(/(search|list|get|stats)$/);
    const methods = files.flatMap((file) => [...file.text.matchAll(/method:\s*'([A-Z]+)'/g)].map((match) => match[1]));
    expect(new Set(methods)).toEqual(new Set(['GET']));
    // The network is reached through one transport only.
    // (`sync.fetch(…)` is the app's own method, not the network.)
    const networkFetch = /(?:await|return|=|\(|,)\s*fetch\(|(?:globalThis|window|self)\.fetch\b/;
    expect(offenders(networkFetch).filter((path) => path !== 'integrations/n01/client.ts')).toEqual([]);
    expect(offenders(networkFetch)).toEqual(['integrations/n01/client.ts']);
    expect(offenders(/XMLHttpRequest|navigator\.sendBeacon|new WebSocket/)).toEqual([]);
  });

  it('sends no cookies and keeps nothing in the HTTP cache', async () => {
    const seen: RequestInit[] = [];
    const transport = createFetchTransport({
      fetchImpl: async (_url, init) => {
        seen.push(init ?? {});
        return new Response(JSON.stringify({ list: [] }), { status: 200 });
      },
    });
    await new N01Client(transport).leagueTournaments('lg_l3hI_3397');
    expect(seen[0]).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store' });
    expect(seen[0].headers === undefined || Object.keys(seen[0].headers as object).every((key) => !/auth|cookie/i.test(key))).toBe(true);
  });

  it('URL validation: https on an n01 host only, no look-alikes, no embedded credentials', () => {
    expect(N01_ALLOWED_HOSTS).toEqual(['push.n01darts.com', 'n01darts.com', 'www.n01darts.com']);
    expect(isAllowedN01Url('https://push.n01darts.com/api/v1')).toBe(true);
    expect(isAllowedN01Url('https://n01darts.com/n01/league/?lgid=lg_l3hI_3397')).toBe(true);
    for (const url of [
      'http://n01darts.com/n01/api',
      'https://n01darts.com.example.com/n01/api',
      'https://push.n01darts.com.example.com/api/v1',
      'http://push.n01darts.com/api/v1',
      'https://example.com/n01darts.com',
      'https://user:pass@n01darts.com/n01/api',
      'https://n01darts.co/n01/api',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      '//n01darts.com/n01/api',
      'not a url',
    ]) {
      expect(isAllowedN01Url(url), url).toBe(false);
    }
  });
});
