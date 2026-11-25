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

import { articleLines } from '../scrape.mjs';
test('articleLines keeps สำนัก lines, drops byline + related-news teasers', () => {
  const html = `<p>16 พ.ย. 69 (06:47 น.) พิมพ์</p><ul><li>อ.น๊อตตี้ : 672, 674, 68</li>
  <li>เขาบอกว่า : 26 บน และ ล่าง 95</li></ul><p>เขตการปกครอง : ไกลมาก ประมาณ 9 อำเภอ ไม่เกี่ยวกับหวยเลยแต่ยาวเกินหกสิบตัวอักษรแน่นอนครับผม</p>
  <p>ข่าวหวย : เลขเด็ดอื่น</p><li>เลขสามตัว : 164, 194</li>`;
  assert.deepEqual(articleLines(html), [
    { label: 'อ.น๊อตตี้', text: '672, 674, 68' },
    { label: 'เขาบอกว่า', text: '26 บน และ ล่าง 95' },
  ]);
});
