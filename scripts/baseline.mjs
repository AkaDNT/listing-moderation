import { isDeepStrictEqual } from 'node:util';

function invalid(code, message) {
  return Object.assign(new Error(message), { code });
}

// OpenAPI required/enum/parameter order is immaterial. Descriptions/examples
// remain manually reviewed prose; they are not machine-readable constraints.
function normalize(value, key = '') {
  if (Array.isArray(value)) {
    const items = value.map(item => normalize(item));
    return ['required', 'enum', 'parameters'].includes(key)
      ? items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .filter(name => key === 'properties' || !['description', 'example', 'examples'].includes(name))
      .map(name => [name, normalize(value[name], name)]));
  }
  return value;
}

function check(actual, expected, path) {
  if (!isDeepStrictEqual(normalize(actual), normalize(expected))) {
    throw invalid('CONTRACT_INVALID', `Contract mismatch at ${path}`);
  }
}

export function validateContract(doc, inventory) {
  for (const { path, method, statuses } of inventory.endpoints) {
    const operation = doc.paths?.[path]?.[method];
    if (!operation) throw invalid('CONTRACT_INVALID', `Contract missing ${method.toUpperCase()} ${path}`);
    for (const status of statuses) {
      if (!operation.responses?.[status]) throw invalid('CONTRACT_INVALID', `Contract missing ${method} ${path} response ${status}`);
    }
  }
  for (const [name, schema] of Object.entries(inventory.schemas)) check(doc.components?.schemas?.[name], schema, `schemas.${name}`);
  check(normalize(doc.paths?.['/v1/listings']?.get?.parameters, 'parameters'), normalize(inventory.list_parameters, 'parameters'), 'list.parameters');
  for (const [path, method] of [['/v1/listings/{id}', 'get'], ['/v1/listings/{id}/decision', 'post']]) {
    check(normalize(doc.paths?.[path]?.[method]?.parameters, 'parameters'), normalize(inventory.path_parameters, 'parameters'), `${path}.parameters`);
  }
  for (const path of ['/v1/listings', '/v1/listings/{id}/decision']) {
    check(doc.paths?.[path]?.post?.requestBody?.required, true, `${path}.requestBody.required`);
  }
  check(doc.paths?.['/v1/listings']?.post?.requestBody?.content?.['application/json']?.schema, inventory.submission_request, 'submission.request');
  check(doc.paths?.['/v1/listings/{id}/decision']?.post?.requestBody?.content?.['application/json']?.schema, inventory.human_request, 'human.request');
  for (const [key, schema] of Object.entries(inventory.response_schemas)) {
    const [method, path, status] = key.split(' ');
    check(doc.paths?.[path]?.[method.toLowerCase()]?.responses?.[status]?.content?.['application/json']?.schema, schema, key);
  }
}

export function validateSeeds(data) {
  const fail = message => { throw invalid('SEED_INVALID', `Seed invalid: ${message}`); };
  const text = value => typeof value === 'string' && value.trim().length > 0;
  for (const name of ['sellers', 'categories', 'banned_keywords']) {
    if (!Array.isArray(data[name]) || data[name].length === 0) fail(`${name} must be a nonempty array`);
    const ids = new Set();
    for (const row of data[name]) {
      if (name === 'banned_keywords') {
        if (!text(row)) fail('empty or non-string banned term');
        const key = row.normalize('NFC').toLowerCase();
        if (ids.has(key)) fail('duplicate banned term');
        ids.add(key);
        continue;
      }
      if (!row || !text(row.id) || !text(row.name)) fail(`${name} requires string id/name`);
      if (ids.has(row.id)) fail(`duplicate ${name} id ${row.id}`);
      ids.add(row.id);
      if (name === 'sellers') {
        if (!Number.isInteger(row.trust_score) || row.trust_score < 0 || row.trust_score > 100 || typeof row.verified !== 'boolean' || typeof row.note !== 'string') fail('seller field types/ranges');
      } else if (!Number.isSafeInteger(row.median_price_vnd) || row.median_price_vnd <= 0) fail('category median must be a positive safe integer');
    }
  }
  return Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, rows.length]));
}
