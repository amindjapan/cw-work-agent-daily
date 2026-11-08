"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const {classifyAccessStop,extractJobDescription,fetchJobDetail} = require('../src/scraper');
const url='https://crowdworks.jp/public/jobs/123';
const phrase='reCAPTCHA（「私はロボットではありません」）等の回避対策ができるとなお良いです。';
const page=(body,extra='')=>`<!doctype html><html><head><link rel="canonical" href="${url}"></head><body><div id="job_offer_detail"><table class="job_offer_detail_table"><tr><td class="confirm_outside_link">${body}</td></tr></table></div>${extra}</body></html>`;

test('HTML detail is parsed only as a bounded identity-matched fallback',()=>{
  assert.equal(extractJobDescription(page('Python CSV整理<br>報酬10,000円'),url),'Python CSV整理 報酬10,000円');
  assert.equal(extractJobDescription(page('Python'),url.replace('123','124')),'');
  assert.equal(extractJobDescription(page('Python')),'');
  assert.equal(extractJobDescription(page('Python','<script type="application/ld+json">invalid</script>'),url),'');
  assert.equal(extractJobDescription(page('Python',`<script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',url:url.replace('123','124'),description:'wrong job'})}</script>`),url),'');
});

test('only the quoted development label inside verified job prose is exempted',()=>{
  assert.equal(classifyAccessStop(200,page(phrase),url),null);
  for(const html of [phrase,page(phrase).replace('123','124'),page('text',phrase),page('私はロボットではありません'),page('reCAPTCHA（「私はロボットではありません」）を確認してください')]) {
    assert.equal(classifyAccessStop(200,html,url),'captcha_required');
  }
});

test('real challenge and access signals still stop with a quoted development label present',()=>{
  for(const extra of ['<div class="g-recaptcha" data-sitekey="synthetic"></div>','<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>','<p>私はロボットではありません</p>','<p>CAPTCHA required</p>','<p>Verify that you are human</p>']) {
    assert.equal(classifyAccessStop(200,page(phrase,extra),url),'captcha_required');
  }
  for(const [status,reason] of [[401,'authentication_required'],[403,'access_denied'],[429,'rate_limited']]) assert.equal(classifyAccessStop(status,page(phrase),url),reason);
  assert.equal(classifyAccessStop(200,page(phrase,'<p>ログインしてください</p>'),url),'authentication_required');
  assert.equal(classifyAccessStop(200,page(phrase,'<p>Access denied</p>'),url),'protection_warning');
  assert.equal(classifyAccessStop(200,page(phrase+' CAPTCHA required'),url),'captcha_required');
});

test('HTML fallback establishes description without inventing employer evidence',async(t)=>{
  t.mock.method(global,'fetch',async()=>({ok:true,status:200,url,headers:{get:()=>null},text:async()=>page('Python CSV整理<br>報酬10,000円')}));
  const result=await fetchJobDetail({id:'123',url,description:'search only'});
  assert.equal(result.detailFetch.outcome,'success');
  assert.equal(result.description,'Python CSV整理 報酬10,000円');
  assert.equal(result.publicClient,null);
});


test('hidden or inert quote evidence cannot grant a bare-label exemption',()=>{
  for (const body of [
    `<span hidden>${phrase}</span> Visible text`,
    `${phrase}<span hidden>${phrase}</span>`,
    `<template>${phrase}</template> Visible text`,
    `<span style="display:none">${phrase}</span> Visible text`
  ]) assert.equal(classifyAccessStop(200,page(body),url),'captcha_required');
});


test('quoted greater-than attributes cannot hide actual CAPTCHA widgets',()=>{
  for(const tag of [
    '<div title=">" class="g-recaptcha" data-sitekey="synthetic"></div>',
    '<iframe title=">" src="https://www.google.com/recaptcha/api2/anchor"></iframe>',
    '<section title=">" class="h-captcha" data-sitekey="synthetic"></section>',
    '<div title=">" class="g&#45;recaptcha" data-sitekey="synthetic"></div>'
  ]) {
    assert.equal(classifyAccessStop(200,page(phrase,tag),url),'captcha_required');
    assert.equal(classifyAccessStop(200,tag,url),'captcha_required');
  }
});
