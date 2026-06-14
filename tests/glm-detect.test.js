import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, getGlmBaseDomain } from '../dist/glm-detect.js';

describe('detectPlatform', () => {
  const originalEnv = process.env.ANTHROPIC_BASE_URL;

  beforeEach(() => {
    delete process.env.ANTHROPIC_BASE_URL;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ANTHROPIC_BASE_URL = originalEnv;
    } else {
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });

  it('detects api.z.ai as GLM', () => {
    assert.equal(detectPlatform('https://api.z.ai'), 'glm');
  });

  it('detects open.bigmodel.cn as GLM', () => {
    assert.equal(detectPlatform('https://open.bigmodel.cn/v4'), 'glm');
  });

  it('detects dev.bigmodel.cn as GLM', () => {
    assert.equal(detectPlatform('https://dev.bigmodel.cn'), 'glm');
  });

  it('detects subdomain of api.z.ai as GLM', () => {
    assert.equal(detectPlatform('https://custom.api.z.ai'), 'glm');
  });

  it('detects api.deepseek.com as DeepSeek', () => {
    assert.equal(detectPlatform('https://api.deepseek.com'), 'deepseek');
  });

  it('detects api.deepseek.com with path as DeepSeek', () => {
    assert.equal(detectPlatform('https://api.deepseek.com/v1'), 'deepseek');
  });

  it('detects api.anthropic.com as Anthropic', () => {
    assert.equal(detectPlatform('https://api.anthropic.com'), 'anthropic');
  });

  it('returns anthropic when env var is unset', () => {
    assert.equal(detectPlatform(), 'anthropic');
  });

  it('returns anthropic for empty string', () => {
    assert.equal(detectPlatform(''), 'anthropic');
  });

  it('handles trailing slashes', () => {
    assert.equal(detectPlatform('https://api.z.ai/'), 'glm');
  });

  it('handles uppercase URL', () => {
    assert.equal(detectPlatform('HTTPS://API.Z.AI'), 'glm');
  });

  it('handles invalid URL gracefully', () => {
    assert.equal(detectPlatform('not-a-valid-url'), 'anthropic');
  });

  it('reads from process.env when no argument passed', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai';
    assert.equal(detectPlatform(), 'glm');
  });
});

describe('getGlmBaseDomain', () => {
  it('extracts base domain from full URL', () => {
    assert.equal(getGlmBaseDomain('https://api.z.ai/v4/chat/completions'), 'https://api.z.ai');
  });

  it('extracts base domain without path', () => {
    assert.equal(getGlmBaseDomain('https://open.bigmodel.cn'), 'https://open.bigmodel.cn');
  });

  it('handles port in URL', () => {
    assert.equal(getGlmBaseDomain('https://api.z.ai:8443/v4'), 'https://api.z.ai:8443');
  });

  it('returns null for empty input', () => {
    assert.equal(getGlmBaseDomain(''), null);
  });

  it('returns null when env var is unset and no argument', () => {
    const saved = process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
    assert.equal(getGlmBaseDomain(), null);
    if (saved !== undefined) process.env.ANTHROPIC_BASE_URL = saved;
  });

  it('returns null for invalid URL', () => {
    assert.equal(getGlmBaseDomain('not-valid'), null);
  });
});
