import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanookImages } from '../scrape.mjs';

test('keeps article tip-sheet images, drops thumbnail and other articles', () => {
  const html = `<img src="https://s.isanook.com/ns/0/ud/1982/9911954/794403.jpg?ip/resize/w728">
  <img src="https://s.isanook.com/ns/0/ud/1982/9911954/new-thumbnail1200x720_v2.jpg">
  <img src="https://s.isanook.com/ns/0/ud/1982/9911111/other.jpg">`;
  assert.deepEqual(sanookImages(html, 'https://www.sanook.com/news/9911954/'),
    ['https://s.isanook.com/ns/0/ud/1982/9911954/794403.jpg']);
});
