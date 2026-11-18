import assert from 'node:assert/strict'
import test from 'node:test'
import { isAllowedOrigin, parseAllowedOrigins, tokenMatches } from '../src/security.ts'

test('loopback API accepts only exact configured web origins', () => {
  const origins = parseAllowedOrigins('https://crm.example.com,http://localhost:5173')
  assert.equal(isAllowedOrigin('https://crm.example.com', origins), true)
  assert.equal(isAllowedOrigin('https://crm.example.com.attacker.invalid', origins), false)
  assert.equal(isAllowedOrigin(undefined, origins), false)
  assert.throws(() => parseAllowedOrigins('http://crm.example.com'))
})

test('pairing-token check requires an exact constant-length match', () => {
  assert.equal(tokenMatches('local-development-token-123456', 'local-development-token-123456'), true)
  assert.equal(tokenMatches('local-development-token-12345', 'local-development-token-123456'), false)
  assert.equal(tokenMatches(undefined, 'local-development-token-123456'), false)
})
