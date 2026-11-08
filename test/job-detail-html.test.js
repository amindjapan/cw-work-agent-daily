"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { extractHtmlJobDescription: extract, inspectHtmlJobDetail: inspect } = require("../src/job-detail-html");
const URL = "https://crowdworks.jp/public/jobs/123";
const canonical = `<link rel="canonical" href="${URL}">`;
const content = body => `<div id="job_offer_detail"><table class="job_offer_detail_table"><tr><td class="confirm_outside_link">${body}</td></tr></table></div>`;
const page = body => `<!DOCTYPE html><html><head>${canonical}</head><body>${content(body)}</body></html>`;
test("verified description and exact inner span, no requests", t => {
 t.mock.method(global, "fetch", () => { throw new Error("network forbidden"); });
 const body = 'Python &amp; CSV<br><strong>作業</strong> &#x1f600;';
 const html = page(body); const result = inspect(html, URL);
 assert.equal(result.description, 'Python & CSV 作業 😀');
 assert.equal(html.slice(result.start,result.end),body); assert.equal(result.html,body);
});
test("missing, conflicting and duplicate identity or structural markers fail closed", () => {
 for (const html of [page('x').replace(canonical,''),page('x').replace('/jobs/123','/jobs/456'),
  page('x').replace(canonical,canonical+canonical), page('x')+content('y'),
  canonical+content('x').replace('job_offer_detail"','other"'),canonical+'<table class="job_offer_detail_table"><td class="confirm_outside_link">x</td></table>',
  page('x').replace('</tr>','<td class="confirm_outside_link">y</td></tr>'),
  page('x').replace('id="job_offer_detail"','id="job_offer_detail" id="other"'),
  page('x').replace('</td>','</th>'),page('x').replace('<table ', '<table/><table '),
  page('x').replace(canonical, '<base href="https://example.com">'+canonical)]) assert.equal(extract(html,URL),'');
 for (const url of [undefined,'http://crowdworks.jp/public/jobs/123','https://evil.example/public/jobs/123',URL+'/../123',URL.replace('crowdworks.jp','crowdworks.jp@evil.example')]) assert.equal(extract(page('x'),url),'');
});
test("comments, attributes, raw text and inert nodes cannot establish identity", () => {
 for (const wrap of [s=>`<!--${s}-->`,s=>`<div data-example='${s}'></div>`,...['script','style','textarea','title','xmp','iframe','noembed','noframes','template','noscript','svg','math'].map(tag=>s=>`<${tag}>${s}</${tag}>`)]) {
  assert.equal(extract(wrap(canonical+content('fake')),URL),'');
  assert.equal(extract(page('real')+wrap(canonical+content('fake')),URL),'real');
 }
});
test("hidden, inert and executable description content is excluded", () => {
 const bad = ['script','style','template','noscript','textarea','iframe'].map(t=>`<${t}>bad</${t}>`).join('')
  + ['hidden','inert','aria-hidden="true"','style="display: none"','style="visibility:hidden"','style="content-visibility:hidden"'].map(a=>`<span ${a}>bad</span>`).join('');
 assert.equal(extract(page('before '+bad+' after'),URL),'before after');
 assert.equal(extract(page(bad),URL),'');
 assert.equal(extract(page('x').replace('id="job_offer_detail"','id="job_offer_detail" hidden'),URL),'');
});
test("bounded size and nesting; malformed HTML and unsupported declarations rejected", () => {
 for(const html of [page('x'.repeat(1024*1024)),page('<div>'.repeat(129)+'x'+'</div>'.repeat(129)),page('x')+'<!--',page('x')+'<!ENTITY x>',page('<script>unterminated'),page('<div>x'),page('x').replace(canonical,'<link rel="canonical" href="'+URL+'" href="'+URL+'">')]) assert.equal(extract(html,URL),'');
});
test("entities decode once without interpreting decoded text as markup", () => {
 assert.equal(extract(page('&lt;script&gt;literal&lt;/script&gt; &amp;lt; &#x110000;'),URL),'<script>literal</script> &lt;');
});

test("unsupported browser reparenting and plaintext contexts fail closed", () => {
 for (const html of [
  '<plaintext hidden></plaintext>'+page('fake'),
  '<plaintext inert></plaintext>'+page('fake'),
  '<select>'+page('fake')+'</select>',
  '<select hidden>'+page('fake')+'</select>',
  canonical+content('fake').replace('<div id=', '<p id=').replace('</div>', '</p>'),
  canonical+'<p>'+content('fake')+'</p>',
  canonical+'<table><tr><td>'+content('fake')+'</td></tr></table>'
 ]) assert.equal(extract(html,URL),'');
});
test("CSS comments do not defeat inline hidden-content exclusion", () => {
 for (const style of ['display:/**/none', 'dis/**/play: no/**/ne', 'visibility:/**/hidden', 'content-visibility:/**/hidden']) {
  assert.equal(extract(page('before <span style="'+style+'">secret</span> after'),URL),'before after');
 }
});

test("structured, encoded and unsupported script types disable HTML fallback", () => {
 for(const type of ['application/ld+json','application&#x2f;ld+json','application&#47;ld+json','application&sol;ld+json','application/ld+json; charset=utf-8','application/json','application/ld+json ']) {
  assert.equal(extract(page('real')+'<script type="'+type+'">{malformed}</script>',URL),'');
 }
 for(const type of ['', 'text/javascript', 'application/javascript', 'module', 'MODULE']) {
  assert.equal(extract(page('real')+'<script type="'+type+'">ignored</script>',URL),'real');
 }
});

test("table structural tokens cannot escape the validated description cell", () => {
 const phrase = 'reCAPTCHA（「私はロボットではありません」）等の回避対策ができるとなお良いです。';
 for(const body of [
  'before<td>'+phrase+'</td>after',
  'before<tr><td>'+phrase+'</td></tr>after',
  '<caption>'+phrase+'</caption>',
  '<tbody><tr><td>'+phrase+'</td></tr></tbody>',
  '<table><tr><td>'+phrase+'</td></tr></table>',
  ...['table','tr','td','th','thead','tbody','tfoot','caption','colgroup','col'].flatMap(tag => [
    '<'+tag+' hidden>'+phrase+'</'+tag+'>',
    '<template><'+tag+'>'+phrase+'</'+tag+'></template>'
  ])
 ]) assert.equal(inspect(page(body),URL),null);
});

test("escaped and double-escaped script bodies cannot expose fake HTML markers", () => {
 for(const prefix of ['<script><!--<script></script>', '<script><!--</script>', '<script><ScRiPt></script>']) {
  for(const suffix of ['', '</script>']) assert.equal(inspect(prefix+page('fake')+suffix,URL),null);
 }
});

test("frameset parsing contexts cannot establish a detail body", () => {
 assert.equal(inspect('<html><head>'+canonical+'</head><frameset>'+content('fake')+'</frameset></html>',URL),null);
 assert.equal(inspect('<frameset hidden>'+page('fake')+'</frameset>',URL),null);
});
