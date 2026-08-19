import { classifyCrawlError, crawlNoteFor } from '../crawlErrors';

// Message strings below are the real ones produced by playwright / node /
// crawlee, not invented text — that is the whole point of the classifier.
describe('classifyCrawlError', () => {
  it('classifies a non-existent domain as terminal', () => {
    const info = classifyCrawlError(
      new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://zabolekarite.info/'),
    );
    expect(info.code).toBe('DNS_NOT_FOUND');
    expect(info.retryable).toBe(false);
  });

  it('reads the code off a node ErrnoException', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND example.invalid'), { code: 'ENOTFOUND' });
    expect(classifyCrawlError(err).code).toBe('DNS_NOT_FOUND');
  });

  it('keeps a transient resolver failure retryable', () => {
    const err = Object.assign(new Error('getaddrinfo EAI_AGAIN example.com'), { code: 'EAI_AGAIN' });
    const info = classifyCrawlError(err);
    expect(info.code).toBe('DNS_NOT_FOUND');
    expect(info.retryable).toBe(true);
  });

  it('classifies certificate failures', () => {
    expect(classifyCrawlError(new Error('page.goto: net::ERR_CERT_DATE_INVALID')).code).toBe('TLS_ERROR');
    expect(classifyCrawlError(new Error('unable to verify the first certificate')).code).toBe('TLS_ERROR');
  });

  it('classifies refused / reset connections as retryable', () => {
    const info = classifyCrawlError(new Error('connect ECONNREFUSED 127.0.0.1:443'));
    expect(info.code).toBe('CONNECTION_REFUSED');
    expect(info.retryable).toBe(true);
  });

  it('classifies navigation timeouts as retryable', () => {
    const info = classifyCrawlError(new Error('page.goto: Timeout 20000ms exceeded.'));
    expect(info.code).toBe('TIMEOUT');
    expect(info.retryable).toBe(true);
  });

  it('classifies a missing browser binary', () => {
    const info = classifyCrawlError(
      new Error("browserType.launch: Executable doesn't exist at /Users/x/ms-playwright/chromium-1148/chrome-mac/Chromium"),
    );
    expect(info.code).toBe('BROWSER_LAUNCH');
    expect(info.retryable).toBe(false);
  });

  it('classifies a null document body, and does not mistake it for a network error', () => {
    const info = classifyCrawlError(new TypeError("Cannot read properties of null (reading 'innerText')"));
    expect(info.code).toBe('EMPTY_DOCUMENT');
    expect(info.retryable).toBe(false);
  });

  it('classifies a root URL that does not serve a web page', () => {
    const info = classifyCrawlError(new Error(
      'Resource https://x.bg/ served Content-Type application/octet-stream, but only text/html, ' +
      'text/xml, application/xhtml+xml, application/xml, application/json are allowed. Skipping resource.',
    ));
    expect(info.code).toBe('UNSUPPORTED_CONTENT_TYPE');
    expect(info.retryable).toBe(false);
  });

  it('falls back to UNKNOWN, staying retryable', () => {
    const info = classifyCrawlError(new Error('something nobody has seen before'));
    expect(info.code).toBe('UNKNOWN');
    expect(info.retryable).toBe(true);
    expect(info.message).toContain('something nobody');
  });

  it('handles non-Error throws', () => {
    expect(classifyCrawlError('net::ERR_CONNECTION_RESET').code).toBe('CONNECTION_REFUSED');
    expect(classifyCrawlError(undefined).code).toBe('UNKNOWN');
  });
});

describe('crawlNoteFor', () => {
  it('explains a dead domain in words a user can act on', () => {
    const note = crawlNoteFor(classifyCrawlError(new Error('net::ERR_NAME_NOT_RESOLVED')));
    expect(note).toMatch(/does not resolve/i);
  });

  it('returns undefined for causes with no useful explanation', () => {
    expect(crawlNoteFor(classifyCrawlError(new Error('mystery')))).toBeUndefined();
  });
});
