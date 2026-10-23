'use strict';

// Exercise the served website in Chromium without network or clipboard access.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-website-')));
app.commandLine.appendSwitch('disable-gpu');
let win;
let noScript;
let checks = 0;
const evaluate = (source) => win.webContents.executeJavaScript(source, true);
// Hidden windows may suspend animation frames; allow media-query events to settle.
const settleLayout = () => evaluate('new Promise(resolve => setTimeout(resolve, 100))');
async function captureWebsite(name) {
  if (!process.env.WEBSITE_SCREENSHOT_DIR) return;
  fs.mkdirSync(process.env.WEBSITE_SCREENSHOT_DIR, { recursive: true });
  const [width, height] = win.getContentSize();
  win.setContentSize(width + 2, height);
  await settleLayout();
  win.setContentSize(width, height);
  await settleLayout();
  fs.writeFileSync(path.join(process.env.WEBSITE_SCREENSHOT_DIR, `${name}.png`), (await win.webContents.capturePage()).toPNG());
}
async function loadPage(page) {
  assert.deepEqual(await evaluate('websiteTest.errors'), []);
  await win.loadURL(`${process.env.WEBSITE_TEST_URL}/${page}`);
  win.webContents.focus();
  await settleLayout();
  assert.deepEqual(await evaluate('websiteTest.errors'), []);
}
async function until(source) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (await evaluate(source)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${source}`);
}
async function check(name, callback) {
  await callback();
  checks += 1;
  console.log(`PASS ${name}`);
}
function key(keyCode) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
}

app.whenReady().then(async () => {
  console.log('Website smoke: starting Chromium');
  win = new BrowserWindow({
    show: false, width: 390, height: 844, useContentSize: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  await win.loadURL('about:blank');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Page.enable');
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.websiteTest = { errors: [], copied: [], mode: 'fallback' };
    addEventListener('error', event => websiteTest.errors.push(event.message));
    addEventListener('unhandledrejection', event => websiteTest.errors.push(String(event.reason)));
    const release = {
      tag_name: 'v0.3.5', name: 'SqlPro 0.3.5', published_at: '2026-10-23T12:00:00Z',
      html_url: 'https://github.com/MinhIT97/sqlPro/releases/tag/v0.3.5',
      body: '## Improvements\\n- Streaming transfer\\n- [Details](https://github.com/MinhIT97/sqlPro/pull/1)\\n<img src=x onerror="window.unexpected=true">',
      assets: ['SqlPro-0.3.5-amd64.deb', 'SqlPro-Setup-0.3.5-x64.exe', 'SqlPro-0.3.5-x86_64.AppImage', 'SqlPro-Portable-0.3.5-x64.exe'].map(name => ({
        name, state: 'uploaded', size: 2097152, digest: 'sha256:' + 'a'.repeat(64),
        browser_download_url: 'https://github.com/MinhIT97/sqlPro/releases/download/v0.3.5/' + name
      }))
    };
    window.fetch = async url => {
      if (location.search.includes('offline')) throw new Error('offline');
      if (location.search.includes('empty')) return { ok: false, status: 404 };
      return { ok: true, json: async () => url.includes('/latest') ? release : [release,
        { ...release, draft: true, name: 'Hidden draft' },
        { ...release, html_url: 'https://evil.example/release', name: 'External release' }
      ] };
    };
    Object.defineProperty(navigator, 'clipboard', { value: {
      writeText: async value => {
        if (websiteTest.mode !== 'modern') throw new Error('permission denied');
        websiteTest.copied.push(value);
      }
    }});
    document.execCommand = command => {
      if (command !== 'copy' || websiteTest.mode !== 'fallback') return false;
      websiteTest.copied.push(document.querySelector('.clipboard-buffer').value);
      return true;
    };
  ` });
  console.log('Website smoke: loading local website');
  await win.loadURL(process.env.WEBSITE_TEST_URL);
  win.webContents.focus();
  assert.equal(await evaluate('typeof websiteTest'), 'object');
  console.log('Website smoke: website loaded');

  await check('mobile navigation supports keyboard, Escape and focus leaving the menu', async () => {
    await evaluate("document.querySelector('#navToggle').focus()");
    key('Space');
    await until("document.querySelector('#navToggle').getAttribute('aria-expanded') === 'true'");
    key('Tab');
    await until("document.activeElement === document.querySelector('#siteNav a')");
    key('Escape');
    await until("document.activeElement.id === 'navToggle' && !document.querySelector('#siteNav').classList.contains('open')");
    await evaluate("document.querySelector('#navToggle').click(); document.querySelector('.hero-actions a').focus()");
    assert.equal(await evaluate("document.querySelector('#navToggle').getAttribute('aria-expanded')"), 'false');
  });

  await check('closing a navigation link does not leave focus in a hidden menu', async () => {
    await evaluate("document.querySelector('#navToggle').click(); document.querySelector('#siteNav a').focus(); document.querySelector('#siteNav a').click()");
    assert.equal(await evaluate("document.querySelector('#siteNav').contains(document.activeElement)"), false);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#siteNav')).display"), 'none');
  });

  await check('crossing the desktop breakpoint resets menu state and preserves usable focus', async () => {
    await evaluate("document.querySelector('#navToggle').click()");
    win.setContentSize(1280, 900);
    await until("matchMedia('(min-width: 901px)').matches && document.querySelector('#navToggle').getAttribute('aria-expanded') === 'false'");
    await evaluate("document.querySelector('#siteNav a').focus()");
    win.setContentSize(390, 844);
    await settleLayout();
    await until("matchMedia('(max-width: 900px)').matches && document.activeElement.id === 'navToggle'");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#siteNav')).display"), 'none');
  });

  await check('navigation remains reachable in a short landscape viewport', async () => {
    win.setContentSize(680, 320);
    await until('innerWidth === 680 && innerHeight === 320');
    await settleLayout();
    await evaluate("document.querySelector('#navToggle').click()");
    assert.equal(await evaluate("document.querySelector('#siteNav').getBoundingClientRect().bottom < innerHeight"), true);
    assert.equal(await evaluate("document.querySelector('#siteNav').scrollHeight > document.querySelector('#siteNav').clientHeight"), true);
    await evaluate("document.querySelector('#siteNav a:last-child').focus()");
    assert.equal(await evaluate("document.querySelector('#siteNav a:last-child').getBoundingClientRect().bottom <= document.querySelector('#siteNav').getBoundingClientRect().bottom"), true);
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
    win.setContentSize(390, 844);
    await until('innerWidth === 390 && innerHeight === 844');
    await settleLayout();
  });

  await check('clipboard permission failure falls back and restores focus and selection', async () => {
    await evaluate(`
      const button = document.querySelector('[data-copy-target=composeCommand]');
      button.focus();
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#composeCommand'));
      getSelection().removeAllRanges(); getSelection().addRange(range);
      button.click();
    `);
    await until("document.querySelector('[data-copy-target=composeCommand]').classList.contains('copied')");
    assert.equal(await evaluate('websiteTest.copied.at(-1)'), await evaluate("document.querySelector('#composeCommand').textContent.trim()"));
    assert.equal(await evaluate("document.activeElement.matches('[data-copy-target=composeCommand]')"), true);
    assert.equal(await evaluate('getSelection().toString().trim()'), await evaluate("document.querySelector('#composeCommand').textContent.trim()"));
    assert.equal(await evaluate("document.querySelector('.clipboard-buffer')"), null);
    await evaluate('getSelection().removeAllRanges()');
  });

  await check('clipboard failure is announced; modern clipboard succeeds and feedback resets', async () => {
    await evaluate("websiteTest.mode = 'failure'; document.querySelector('[data-copy-target=composeCommand]').click()");
    await until("document.querySelector('[data-copy-target=composeCommand] span').textContent === 'Không sao chép được'");
    assert.equal(await evaluate("document.querySelector('.clipboard-buffer')"), null);
    await evaluate("websiteTest.mode = 'modern'; document.querySelector('[data-copy-target=composeCommand]').click()");
    await until("document.querySelector('[data-copy-target=composeCommand] span').textContent === 'Đã sao chép'");
    await until("document.querySelector('[data-copy-target=composeCommand] span').textContent === 'Sao chép'");
  });

  await check('responsive layout, focus indicators and reduced motion work', async () => {
    for (const width of [320, 390, 680, 900, 901, 1280]) {
      win.setContentSize(width, 900);
      await until(`innerWidth === ${width}`);
      await settleLayout();
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `overflow at ${width}px`);
      assert.equal(await evaluate("document.querySelector('#downloadWindows').getBoundingClientRect().width > 0"), true);
    }
    await evaluate("document.querySelector('.skip-link').focus()");
    assert.equal(await evaluate("document.querySelector('.skip-link').getBoundingClientRect().top >= 0"), true);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.skip-link')).outlineStyle"), 'solid');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await evaluate("getComputedStyle(document.documentElement).scrollBehavior"), 'auto');
    assert.ok(parseFloat(await evaluate("getComputedStyle(document.querySelector('.hero-copy')).animationDuration")) < 0.001);
    if (process.env.WEBSITE_SCREENSHOT_DIR) {
      await evaluate("document.activeElement.blur(); scrollTo({ top: 0, behavior: 'instant' })");
      await until('scrollY === 0');
      await captureWebsite('desktop');
      win.setContentSize(390, 844);
      await until('innerWidth === 390');
      await settleLayout();
      await evaluate("document.querySelector('#navToggle').click()");
      await until("document.querySelector('#navToggle').getAttribute('aria-expanded') === 'true'");
      await captureWebsite('mobile');
    }
  });

  await check('downloads show real response metadata and copy the provided checksum', async () => {
    await loadPage('index.html');
    await until("!document.querySelector('[data-checksum=downloadWindows]').hidden");
    assert.match(await evaluate("document.querySelector('[data-release-meta=downloadWindows]').textContent"), /2 MiB/);
    await evaluate("document.querySelector('[data-checksum=downloadWindows]').open=true; websiteTest.mode='modern'; document.querySelector('[data-copy-target=digest-downloadWindows]').click()");
    await until('websiteTest.copied.length > 0');
    assert.equal(await evaluate('websiteTest.copied.at(-1)'), 'a'.repeat(64));
    win.setContentSize(1280, 900);
    await settleLayout();
    await evaluate("document.querySelector('#download').scrollIntoView({behavior:'instant'})");
    await captureWebsite('downloads');
  });

  await check('overview video decodes, plays and provides localized captions', async () => {
    await evaluate("document.querySelector('video').load()");
    await until("document.querySelector('video').readyState>=1 && Number.isFinite(document.querySelector('video').duration)");
    assert.ok(await evaluate("document.querySelector('video').duration") >= 8);
    assert.equal(await evaluate("document.querySelector('video').videoWidth"), 1344);
    await evaluate("document.querySelector('video').play()");
    await until("document.querySelector('video').currentTime>0");
    await evaluate("document.querySelector('video').pause()");
    assert.equal(await evaluate("document.querySelector('track').srclang"), 'vi');
  });

  await check('hosting form validates, invalidates stale results, copies and downloads configuration', async () => {
    await evaluate("document.querySelector('#hostMode').value='https'; document.querySelector('#hostMode').dispatchEvent(new Event('change', {bubbles:true}))");
    assert.equal(await evaluate("document.querySelector('#hostResult').hidden"), true);
    await evaluate("document.querySelector('#hostDomain').value='sync.example.com'; document.querySelector('#hostPort').value='3030'; document.querySelector('#hostRegistration').checked=false; document.querySelector('#hostForm').requestSubmit()");
    await until("!document.querySelector('#hostResult').hidden");
    assert.equal(await evaluate("document.querySelector('#hostAddress').textContent"), 'https://sync.example.com');
    assert.match(await evaluate("document.querySelector('#host-caddy').textContent"), /reverse_proxy sqlpro:3030/);
    assert.match(await evaluate("document.querySelector('#host-env').textContent"), /ALLOW_REGISTRATION=false/);
    const download = new Promise((resolve) => {
      win.webContents.session.once('will-download', (event, item) => { event.preventDefault(); resolve(item.getFilename()); });
    });
    await evaluate("document.querySelector('[data-download-file=\"compose.yaml\"]').click()");
    assert.equal(await download, 'compose.yaml');
    await evaluate("websiteTest.mode='modern'; document.querySelector('[data-copy-target=host-env]').click()");
    assert.match(await evaluate('websiteTest.copied.at(-1)'), /PORT=3030/);
    await evaluate("document.querySelector('#selfhost').scrollIntoView({behavior:'instant'})");
    await captureWebsite('selfhost');
    await evaluate("document.querySelector('#hostDomain').value='example.com}'; document.querySelector('#hostDomain').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#hostForm').requestSubmit()");
    assert.equal(await evaluate("document.querySelector('#hostResult').hidden"), true);
    assert.equal(await evaluate("document.querySelector('#hostDomain').getAttribute('aria-invalid')"), 'true');
    await evaluate("document.querySelector('#hostMode').value='local'; document.querySelector('#hostMode').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#hostForm').requestSubmit()");
    assert.equal(await evaluate("document.querySelector('[data-config-file=Caddyfile]').hidden"), true);
  });

  await check('documentation search supports accents, error codes, no results and language switching', async () => {
    await loadPage('docs.html#ssh');
    await evaluate("document.querySelector('#docsSearch').value='SSH_HOST_KEY_CHANGED'; document.querySelector('#docsSearch').dispatchEvent(new Event('input'))");
    assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-doc-topic]')].filter(el=>!el.hidden).map(el=>el.id)"), ['ssh']);
    await evaluate("document.querySelector('#docsSearch').value='dong bo'; document.querySelector('#docsSearch').dispatchEvent(new Event('input'))");
    assert.equal(await evaluate("document.querySelector('#sync').hidden"), false);
    await evaluate("document.querySelector('#docsSearch').value='no-result-12345'; document.querySelector('#docsSearch').dispatchEvent(new Event('input'))");
    assert.equal(await evaluate("document.querySelector('#docsEmpty').hidden"), false);
    await evaluate("document.querySelector('.language-link').click()");
    await until("document.documentElement.lang==='en' && Boolean(document.querySelector('#docsSearch')) && !document.querySelector('#docsSearch').disabled");
    assert.equal(await evaluate('location.hash'), '#ssh');
    assert.match(await evaluate("document.querySelector('#ssh h2').textContent"), /SSH tunnels/);
    assert.equal(await evaluate("document.querySelectorAll('[data-doc-topic]').length"), 11);
    await evaluate("scrollTo({top:0,behavior:'instant'})");
    await captureWebsite('docs-en');
  });

  await check('changelog renders safe notes and excludes draft and external releases', async () => {
    await loadPage('changelog.html');
    await until("document.querySelectorAll('.release-entry').length===1");
    assert.match(await evaluate("document.querySelector('.release-notes').textContent"), /<img/);
    assert.equal(await evaluate("document.querySelector('.release-notes img')"), null);
    assert.equal(await evaluate('typeof window.unexpected'), 'undefined');
    assert.equal(await evaluate("document.querySelectorAll('.release-notes a').length"), 1);
    await captureWebsite('changelog');
    await loadPage('changelog.en.html?offline');
    assert.match(await evaluate("document.querySelector('#releaseHistoryStatus').textContent"), /Could not load/);
    await loadPage('changelog.html?empty');
    assert.match(await evaluate("document.querySelector('#releaseHistoryStatus').textContent"), /Chưa có bản phát hành/);
    await loadPage('index.en.html?offline');
    assert.match(await evaluate("document.querySelector('#downloadStatus').textContent"), /Could not check/);
    assert.equal(await evaluate("document.querySelector('#downloadWindows').href"), 'https://github.com/MinhIT97/sqlPro/releases');
  });

  await check('all six localized pages fit mobile and desktop with no broken loaded images', async () => {
    for (const page of ['index.html', 'index.en.html', 'docs.html', 'docs.en.html', 'changelog.html', 'changelog.en.html']) {
      await loadPage(page);
      for (const width of [320, 901, 1280]) {
        win.setContentSize(width, 900);
        await until(`innerWidth===${width}`);
        await settleLayout();
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${page} overflow at ${width}px`);
      }
      assert.equal(await evaluate('[...document.images].some(image=>image.complete && image.naturalWidth===0)'), false, page);
    }
  });

  await check('mobile navigation and download fallbacks remain usable without JavaScript', async () => {
    noScript = new BrowserWindow({ show: false, width: 390, height: 844, useContentSize: true, webPreferences: { javascript: false } });
    await noScript.loadURL('about:blank');
    noScript.webContents.debugger.attach('1.3');
    await noScript.loadURL(process.env.WEBSITE_TEST_URL);
    const { result, exceptionDetails } = await noScript.webContents.debugger.sendCommand('Runtime.evaluate', { expression: `({
      nav: getComputedStyle(document.querySelector('#siteNav')).display,
      toggle: getComputedStyle(document.querySelector('#navToggle')).display,
      copy: getComputedStyle(document.querySelector('[data-copy-target=composeCommand]')).display,
      label: document.querySelector('#downloadWindows strong').textContent,
      href: document.querySelector('#downloadWindows').href,
      overflow: document.documentElement.scrollWidth > innerWidth
    })`, returnByValue: true });
    assert.equal(exceptionDetails, undefined);
    const state = result.value;
    assert.equal(state.nav, 'flex');
    assert.equal(state.toggle, 'none');
    assert.equal(state.copy, 'none');
    assert.equal(state.label, 'Xem GitHub Releases');
    assert.match(state.href, /github\.com\/MinhIT97\/sqlPro\/releases$/);
    assert.equal(state.overflow, false);
    await noScript.loadURL(`${process.env.WEBSITE_TEST_URL}/docs.en.html`);
    const inspection = await noScript.webContents.debugger.sendCommand('Runtime.evaluate', { expression: `({ language: document.documentElement.lang, topics: document.querySelectorAll('[data-doc-topic]').length, disabled: document.querySelector('#docsSearch').disabled })`, returnByValue: true });
    assert.deepEqual(inspection.result.value, { language: 'en', topics: 11, disabled: true });
  });

  assert.deepEqual(await evaluate('websiteTest.errors'), []);
  console.log(`Website smoke: ${checks}/${checks} passed`);
  noScript.destroy();
  win.destroy();
  app.exit(0);
}).catch(async (error) => {
  console.error(error.stack || error);
  noScript?.destroy();
  win?.destroy();
  app.exit(1);
});
