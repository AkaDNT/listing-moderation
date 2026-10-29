import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

test('T11 production Compose database volume carries exact invocation ownership label', async () => {
  const compose = parse(await readFile(resolve('compose.yaml'), 'utf8')) as {
    volumes: { 'db-data': { labels: Record<string, string> } };
  };
  assert.equal(compose.volumes['db-data'].labels['com.listing-moderation.invocation'],
    '${LM_INVOCATION:?invocation is required}');
});
