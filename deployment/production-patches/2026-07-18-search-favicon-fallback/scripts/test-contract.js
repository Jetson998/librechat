'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'client', 'search-favicon-fallback.js');
const contract = require(sourcePath);

assert.equal(contract.version, '2026-07-18-search-favicon-v1');
assert.equal(contract.normalizeDomain('https://www.BBC.com/path'), 'bbc.com');
assert.equal(contract.normalizeDomain('bbc.com:443'), 'bbc.com');
assert.equal(contract.normalizeDomain('bad domain'), '');
assert.equal(
  contract.parseGoogleFaviconDomain(
    'https://www.google.com/s2/favicons?domain=bbc.com&sz=32',
  ),
  'bbc.com',
);
assert.equal(contract.parseGoogleFaviconDomain('https://example.com/favicon.ico'), '');
assert.equal(contract.hashDomain('bbc.com'), contract.hashDomain('bbc.com'));

const dataUri = contract.createFallbackDataUri('bbc.com');
assert.ok(dataUri.startsWith('data:image/svg+xml;charset=UTF-8,'));
const decoded = decodeURIComponent(dataUri.split(',', 2)[1]);
assert.ok(decoded.includes('>B</text>'));
assert.ok(decoded.includes('<rect'));

const attributes = new Map([
  ['src', 'https://www.google.com/s2/favicons?domain=bbc.com&sz=32'],
  ['alt', 'bbc.com'],
  ['srcset', 'ignored'],
]);
const image = {
  dataset: {},
  getAttribute: (name) => attributes.get(name) ?? null,
  setAttribute: (name, value) => attributes.set(name, value),
  removeAttribute: (name) => attributes.delete(name),
};
assert.equal(contract.replaceImage(image), true);
assert.equal(image.dataset.lcSearchFaviconFallback, 'bbc.com');
assert.ok(attributes.get('src').startsWith('data:image/svg+xml'));
assert.equal(attributes.get('srcset'), undefined);
assert.equal(contract.replaceImage(image), false);

const source = fs.readFileSync(sourcePath, 'utf8');
for (const marker of [
  'https://www.google.com',
  '/s2/favicons',
  'MutationObserver',
  'data-lc-search-favicon-fallback',
  'referrerpolicy',
  'createFallbackDataUri',
]) {
  assert.ok(source.includes(marker), `missing source marker: ${marker}`);
}

console.log('search_favicon_fallback_contract: ok');
