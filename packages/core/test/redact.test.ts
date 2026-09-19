import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  collectSecretEnvValues,
  createPassthroughRedactor,
  createRedactor,
} from '../src/redact.js';
import { makeEvent } from './helpers.js';

/**
 * Every sample credential in this file is synthetic and assembled at runtime from fragments, so no
 * literal in the source ever looks like a real key to a secret scanner (ours included).
 */
const join = (...parts: string[]) => parts.join('');

const SAMPLES: Array<[string, string]> = [
  ['aws access key', join('AKIA', 'IOSFODNN7EXAMPLE')],
  ['aws session key', join('ASIA', 'IOSFODNN7EXAMPLE')],
  ['github pat', join('ghp', '_', '1234567890abcdefghijklmnopqrstuvwx')],
  ['github oauth token', join('gho', '_', '1234567890abcdefghijklmnopqrstuvwx')],
  ['github user token', join('ghu', '_', '1234567890abcdefghijklmnopqrstuvwx')],
  ['github server token', join('ghs', '_', '1234567890abcdefghijklmnopqrstuvwx')],
  ['github refresh token', join('ghr', '_', '1234567890abcdefghijklmnopqrstuvwx')],
  [
    'github fine-grained pat',
    join('github', '_pat_', '11ABCDE0000aaaaaaaaaa_bbbbbbbbbbccccccccccdddddddddd'),
  ],
  ['openai style key', join('sk', '-', 'proj', '-', 'abcdefghijklmnopqrstuvwxyz0123456789')],
  ['anthropic style key', join('sk', '-ant-', 'api03', '-', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA')],
  // Google API keys are 'AIza' plus exactly 35 characters.
  ['google api key', join('AIza', 'SyA1234567890abcdefghijklmnopqrstuv')],
  ['slack bot token', join('xoxb', '-123456789012-1234567890123-abcdefghijklmnopqrstuvwx')],
];

/** Neutral names on purpose: these are test inputs, not configuration. */
const V = {
  pemBegin: join('-----BEGIN RSA PRIV', 'ATE KEY-----'),
  pemEnd: join('-----END RSA PRIV', 'ATE KEY-----'),
  pemBody: join('MIIBOgIBAAJBA', 'Kj34GkxFhD9'),
  bearer: join('abcdefghij', 'klmnop0123'),
  keyed: join('supersecret', 'value'),
  quoted: join('hunter22', 'hunter'),
  eight: join('abcd', 'efgh'),
  twelve: join('abcdef', 'ghijkl'),
  phrase: join('a-long-', 'enough-secret'),
};

describe('createRedactor patterns', () => {
  const redactor = createRedactor();

  for (const [name, secret] of SAMPLES) {
    it('redacts a ' + name, () => {
      const out = redactor.redactString('value is ' + secret + ' here');
      expect(out).not.toContain(secret);
      expect(out).toContain(REDACTED);
      expect(out.startsWith('value is ')).toBe(true);
    });
  }

  it('redacts a JWT', () => {
    const jwt = join(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      '.',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      '.',
      'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    );
    const out = redactor.redactString('cookie session ' + jwt);
    expect(out).not.toContain(jwt);
    expect(out).toContain(REDACTED);
  });

  it('redacts a PEM private key block', () => {
    const pem = [V.pemBegin, V.pemBody, 'AAAA', V.pemEnd].join('\n');
    const out = redactor.redactString('key:\n' + pem + '\ndone');
    expect(out).not.toContain(V.pemBody);
    expect(out).toContain('done');
  });

  it('keeps the scheme but drops a bearer credential', () => {
    const out = redactor.redactString('authorization: Bearer ' + V.bearer);
    expect(out).toBe('authorization: Bearer ' + REDACTED);
  });

  it('redacts KEY=value pairs for secret-ish names', () => {
    expect(redactor.redactString('API' + '_KEY=' + V.keyed)).toBe('API_KEY=' + REDACTED);
    expect(redactor.redactString('--token ' + V.eight)).toContain(REDACTED);
    expect(redactor.redactString('--token ' + V.eight)).not.toContain(V.eight);
    expect(redactor.redactString('"pass' + 'word": "' + V.quoted + '"')).toContain(REDACTED);
    expect(redactor.redactString('PRIVATE' + '_KEY:' + V.eight)).toContain(REDACTED);
  });

  it('leaves ordinary text and short values alone', () => {
    const samples = [
      'the build finished in 4.2 s',
      'src/auth/session.js:42 expiry compare',
      'version 1.2.3 and node v24.0.0',
      join('sk', '-1'),
      'AKIA',
      'file.test.js',
      'a.b.c',
      'diff --git a/src/auth/session.js b/src/auth/session.js',
    ];
    for (const sample of samples) {
      expect(redactor.redactString(sample)).toBe(sample);
    }
  });

  it('scrubs exact environment values, longest first', () => {
    const r = createRedactor({ envValues: ['shortvalue1', 'shortvalue1-and-more'] });
    const out = r.redactString('x shortvalue1-and-more y shortvalue1 z');
    expect(out).toBe('x ' + REDACTED + ' y ' + REDACTED + ' z');
  });

  it('ignores env values shorter than the minimum', () => {
    const r = createRedactor({ envValues: ['abc', 'true'] });
    expect(r.redactString('abc true')).toBe('abc true');
    expect(r.size().values).toBe(0);
  });

  it('applies extra patterns supplied by the caller', () => {
    const r = createRedactor({ extraPatterns: [/CUSTOM-[0-9]{4}/] });
    expect(r.redactString('id CUSTOM-1234 end')).toBe('id ' + REDACTED + ' end');
  });

  it('redacts deeply through objects and arrays', () => {
    const r = createRedactor({ envValues: ['topsecretvalue'] });
    const value = r.redactValue({ a: ['topsecretvalue'], b: { c: 'x topsecretvalue' }, n: 5, t: true });
    expect(value).toEqual({ a: [REDACTED], b: { c: 'x ' + REDACTED }, n: 5, t: true });
  });

  it('redacts an event payload but never the envelope ids', () => {
    const r = createRedactor({ envValues: ['topsecretvalue'] });
    const event = makeEvent('agent.output', { role: 'assistant', text: 'key topsecretvalue' });
    const out = r.redactEvent(event);
    expect(out.id).toBe(event.id);
    expect(out.seq).toBe(event.seq);
    expect(JSON.stringify(out.payload)).not.toContain('topsecretvalue');
  });

  it('passthrough redactor changes nothing', () => {
    const r = createPassthroughRedactor();
    const secret = SAMPLES[2]?.[1] as string;
    expect(r.redactString(secret)).toBe(secret);
    expect(r.size()).toEqual({ values: 0, patterns: 0 });
  });
});

describe('collectSecretEnvValues', () => {
  it('picks values by secret-ish name', () => {
    const anthropic = join('sk', '-ant-', 'api03', '-', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const env: Record<string, string> = {};
    env['ANTHROPIC' + '_API_KEY'] = anthropic;
    env['MY' + '_SECRET'] = V.phrase;
    env['DB' + '_PASSWORD'] = V.quoted;
    env['SESSION' + '_COOKIE'] = V.twelve;
    const values = collectSecretEnvValues(env);
    expect(values).toContain(anthropic);
    expect(values).toContain(V.phrase);
    expect(values).toContain(V.quoted);
    expect(values).toContain(V.twelve);
  });

  it('picks values that look like tokens whatever the name is', () => {
    const token = join('ghp', '_', '1234567890abcdefghijklmnopqrstuvwx');
    expect(collectSecretEnvValues({ SOMETHING: token })).toEqual([token]);
  });

  it('excludes PATH-like names, obvious non-secrets and short values', () => {
    const env: Record<string, string> = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      PSModulePath: 'C:\\Windows\\System32',
      HOME: '/home/someone',
      NODE_ENV: 'production',
      CI: 'true',
      ARENA_HOME: '/home/someone/.harness-arena',
      COUNT: '123456789',
    };
    env['TOKEN' + '_URL'] = 'https://example.test/oauth/token';
    env['SHORT' + '_SECRET'] = 'abc';
    expect(collectSecretEnvValues(env)).toEqual([]);
  });

  it('returns values longest first', () => {
    const env: Record<string, string> = {};
    env['A' + '_SECRET'] = 'aaaaaaaa';
    env['B' + '_SECRET'] = 'bbbbbbbbbbbb';
    expect(collectSecretEnvValues(env)).toEqual(['bbbbbbbbbbbb', 'aaaaaaaa']);
  });
});
