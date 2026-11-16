// What kind of profile a row is (lib/profiles.ts profileKind), on every combination of the columns that decide it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { profileKind, type ProfileRow } from '../src/lib/profiles';

const row = (o: Partial<ProfileRow>): ProfileRow => ({ password_login: true, local_open: false, sso: false, auth_kind: 'password', ...o });

test('every account before profiles is a password profile, whether it was made by setup, sign-up or the provider', () => {
  assert.equal(profileKind(row({})), 'password');
  assert.equal(profileKind(row({ auth_kind: 'oidc', sso: true })), 'password');
  // An account the provider made has an unusable hash; with password_login false it still has one credential, the provider.
  assert.equal(profileKind(row({ auth_kind: 'oidc', sso: true, password_login: false })), 'password');
});

test('open at home: without a credential it is open, with one it is hybrid', () => {
  assert.equal(profileKind(row({ password_login: false, local_open: true, auth_kind: 'none' })), 'open');
  assert.equal(profileKind(row({ local_open: true })), 'hybrid');
  assert.equal(profileKind(row({ password_login: false, local_open: true, sso: true })), 'hybrid');
});

test('no credential and not open at home is no way in, and is said as such', () => {
  assert.equal(profileKind(row({ password_login: false })), 'none');
});

