import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dryRunSchema, scriptCreateSchema, scriptPatchSchema, validateSchema, versionCreateSchema } from './schemas';

test('REST schemas accept only supported script languages and keep language immutable', () => {
  const code = 'def move(state):\n    return "right"\n';
  for (const language of ['javascript', 'python']) {
    assert.equal(scriptCreateSchema.safeParse({ name: 'snake', code, language }).success, true);
    assert.equal(validateSchema.safeParse({ code, language }).success, true);
    assert.equal(dryRunSchema.safeParse({ code, language }).success, true);
  }
  for (const language of ['Python', 'ruby', '', null, 1]) {
    assert.equal(scriptCreateSchema.safeParse({ name: 'snake', code, language }).success, false);
    assert.equal(validateSchema.safeParse({ code, language }).success, false);
    assert.equal(dryRunSchema.safeParse({ code, language }).success, false);
  }
  assert.equal(scriptCreateSchema.safeParse({ name: 'legacy', code }).success, true);
  assert.equal(validateSchema.safeParse({ code }).success, true);
  assert.equal(scriptPatchSchema.safeParse({ language: 'python' }).success, false);
  assert.equal(versionCreateSchema.safeParse({ code, language: 'python' }).success, false);
});
