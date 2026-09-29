import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisFailureCode, failureMessage } from './provider-error.js';

test('repository failures expose actionable categories without upstream details', () => {
  for (const [raw, code] of [
    ['github_api_404', 'github_repository_unavailable'],
    ['fetching: github_archive_404', 'github_repository_unavailable'],
    ['github_api_401', 'github_access_denied'],
    ['github_api_403', 'github_access_denied'],
    ['github_api_503', 'github_upstream_unavailable'],
    ['github_gateway_unavailable', 'github_upstream_unavailable'],
    ['github_rate_limited', 'github_rate_limited'],
    ['analysis_configuration_changed', 'analysis_configuration_changed'],
  ]) {
    assert.equal(analysisFailureCode(raw!), code);
    assert.equal(analysisFailureCode(code!), code);
  }
  const message = failureMessage(analysisFailureCode('github_api_404 unsafe-secret-sentinel'));
  assert.match(message, /地址.*公开仓库/);
  assert.doesNotMatch(message, /unsafe-secret|稍后重试/);
});
