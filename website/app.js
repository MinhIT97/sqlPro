'use strict';

(function setupWebsite() {
  const core = globalThis.SqlProWebsite;
  if (!core) return;
  const language = document.documentElement?.lang === 'en' ? 'en' : 'vi';
  const text = core.MESSAGES[language];
  const { RELEASES_URL, FORMATS: DOWNLOAD_FORMATS } = core;
  const RELEASE_TIMEOUT_MS = 8000;

  async function loadReleaseData(endpoint) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RELEASE_TIMEOUT_MS);
    try {
      const response = await fetch(`${core.API_URL}${endpoint}`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: controller.signal
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`GitHub API ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  function initCopyrightYear() {
    const year = document.querySelector('#year');
    if (year) year.textContent = String(new Date().getFullYear());
  }

  function initStickyHeader() {
    const header = document.querySelector('#siteHeader');
    if (!header) return;

    const updateHeader = () => header.classList.toggle('scrolled', window.scrollY > 8);
    updateHeader();
    window.addEventListener('scroll', updateHeader, { passive: true });
  }

  function initMobileNavigation() {
    const nav = document.querySelector('#siteNav');
    const toggle = document.querySelector('#navToggle');
    if (!nav || !toggle) return;

    const label = toggle.querySelector('.sr-only');
    const mobile = window.matchMedia('(max-width: 900px)');
    let lastFocusedElement = document.activeElement;
    const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
    const setOpen = (open, restoreFocus = nav.contains(document.activeElement)) => {
      open = open && mobile.matches;
      nav.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
      if (label) label.textContent = open ? text.closeMenu : text.openMenu;
      if (!open && mobile.matches && restoreFocus) {
        toggle.focus({ preventScroll: true });
      }
    };

    toggle.hidden = false;
    nav.setAttribute('data-collapsible', '');
    setOpen(false);
    // CSS may hide the focused link before the media-query change fires.
    mobile.addEventListener('change', () => setOpen(false, nav.contains(lastFocusedElement)));
    toggle.addEventListener('click', () => setOpen(!isOpen()));
    nav.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => setOpen(false));
    });
    document.addEventListener('click', (event) => {
      if (isOpen() && !nav.contains(event.target) && !toggle.contains(event.target)) {
        setOpen(false);
      }
    });
    document.addEventListener('focusin', (event) => {
      lastFocusedElement = event.target;
      if (isOpen() && !nav.contains(event.target) && !toggle.contains(event.target)) {
        setOpen(false);
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !isOpen()) return;
      setOpen(false);
      toggle.focus();
    });
  }

  async function copyText(value) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch {
        // Clipboard permission can be denied even in a secure context.
      }
    }

    const activeElement = document.activeElement;
    const selection = window.getSelection();
    const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange());
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.className = 'clipboard-buffer';
    document.body.appendChild(area);
    try {
      area.select();
      if (!document.execCommand('copy')) throw new Error('copy failed');
    } finally {
      area.remove();
      activeElement?.focus({ preventScroll: true });
      selection.removeAllRanges();
      ranges.forEach((range) => selection.addRange(range));
    }
  }

  function initCopyButtons() {
    const timers = new WeakMap();
    const versions = new WeakMap();
    document.querySelectorAll('[data-copy-target]').forEach((button) => {
      button.hidden = false;
      button.addEventListener('click', async () => {
        const target = document.getElementById(button.dataset.copyTarget);
        const label = button.querySelector('span');
        if (!target || !label) return;

        const version = (versions.get(button) || 0) + 1;
        versions.set(button, version);
        const pendingTimer = timers.get(button);
        if (pendingTimer) clearTimeout(pendingTimer);
        try {
          await copyText(target.textContent.trim());
          if (versions.get(button) !== version) return;
          button.classList.add('copied');
          label.textContent = text.copied;
        } catch {
          if (versions.get(button) !== version) return;
          button.classList.remove('copied');
          label.textContent = text.copyFailed;
        }

        timers.set(button, setTimeout(() => {
          button.classList.remove('copied');
          label.textContent = text.copy;
          timers.delete(button);
        }, 2200));
      });
    });
  }

  async function initDownloads() {
    const links = new Map(DOWNLOAD_FORMATS.map(({ id }) => [id, document.querySelector(`#${id}`)]));
    const alternatives = document.querySelector('#downloadAlternatives');
    const status = document.querySelector('#downloadStatus');
    if (!status || DOWNLOAD_FORMATS.some(({ id, primary }) => primary && !links.get(id))) return;
    const renderDownloads = (downloads, release) => {
      downloads.forEach(({ id, primary, asset, label }) => {
        const link = links.get(id);
        if (!link) return;
        link.href = asset ? asset.browser_download_url : RELEASES_URL;
        const heading = link.querySelector('strong');
        if (heading) heading.textContent = asset ? label : text.releasePage;
        if (!primary) {
          link.hidden = !asset;
          const card = document.querySelector(`[data-download-card="${id}"]`);
          if (card) card.hidden = !asset;
        }
        const metadata = document.querySelector(`[data-release-meta="${id}"]`);
        const digest = core.releaseDigest(asset);
        const date = core.formatDate(release?.published_at, language);
        if (metadata) metadata.textContent = asset
          ? [asset.name, core.formatBytes(asset.size, language), date && `${text.published}: ${date}`, !digest && text.noDigest].filter(Boolean).join(' · ')
          : text.unavailable;
        const checksum = document.querySelector(`[data-checksum="${id}"]`);
        const code = document.querySelector(`#digest-${id}`);
        if (checksum) checksum.hidden = !digest;
        if (code) code.textContent = digest;
      });
      if (alternatives) alternatives.hidden = !downloads.some(({ primary, asset }) => !primary && asset);
    };

    status.textContent = text.checking;
    try {
      const release = await loadReleaseData('/latest');
      const downloads = core.selectReleaseDownloads(release, language);
      renderDownloads(downloads, release);
      const version = typeof release?.tag_name === 'string' ? `${text.version} ${release.tag_name}. ` : '';
      status.textContent = downloads.some(({ asset }) => asset)
        ? version + text.releaseReady : text.noAssets;
    } catch {
      renderDownloads(core.selectReleaseDownloads(null, language));
      status.textContent = text.releaseFailed;
    }
  }

  function initLanguageLink() {
    const link = document.querySelector('.language-link');
    if (link && window.location.hash) link.hash = window.location.hash;
    window.addEventListener('hashchange', () => {
      if (link) link.hash = window.location.hash;
    });
  }

  function initDocumentationSearch() {
    const input = document.querySelector('#docsSearch');
    const status = document.querySelector('#docsSearchStatus');
    const empty = document.querySelector('#docsEmpty');
    if (!input || !status || !empty) return;
    const topics = Array.from(document.querySelectorAll('[data-doc-topic]')).map((article) => ({
      article, text: `${article.textContent} ${article.dataset.keywords || ''}`,
      link: document.querySelector(`[data-doc-link="${article.id}"]`)
    }));
    const filter = () => {
      let count = 0;
      topics.forEach(({ article, text: content, link }) => {
        const visible = core.matchesSearch(content, input.value);
        article.hidden = !visible;
        if (link) link.hidden = !visible;
        if (visible) count += 1;
      });
      empty.hidden = count > 0;
      status.textContent = count ? `${count} ${text.docsFound}` : text.docsEmpty;
    };
    input.disabled = false;
    input.addEventListener('input', filter);
    window.addEventListener('hashchange', () => {
      if (input.value) { input.value = ''; filter(); }
    });
    filter();
  }

  function initHostGenerator() {
    const form = document.querySelector('#hostForm');
    if (!form) return;
    const inputs = document.querySelector('#hostInputs');
    const mode = document.querySelector('#hostMode');
    const port = document.querySelector('#hostPort');
    const domain = document.querySelector('#hostDomain');
    const domainField = document.querySelector('#hostDomainField');
    const registration = document.querySelector('#hostRegistration');
    const status = document.querySelector('#hostStatus');
    const result = document.querySelector('#hostResult');
    const fileTargets = { '.env': 'host-env', 'compose.yaml': 'host-compose', Caddyfile: 'host-caddy' };
    let configuration = null;
    const generate = () => {
      result.hidden = true;
      configuration = null;
      domain.removeAttribute('aria-invalid');
      port.removeAttribute('aria-invalid');
      try {
        configuration = core.buildHostConfiguration({ mode: mode.value, port: port.value, domain: domain.value, registration: registration.checked });
        Object.entries(fileTargets).forEach(([name, id]) => {
          document.querySelector(`[data-config-file="${name}"]`).hidden = !configuration.files[name];
          document.getElementById(id).textContent = configuration.files[name] || '';
        });
        document.querySelector('#hostAddress').textContent = configuration.url;
        document.querySelector('#hostRequirements').textContent = mode.value === 'https' ? text.hostHttps : text.hostLocal;
        result.hidden = false;
        status.textContent = text.configReady;
      } catch (error) {
        status.textContent = text[error.message] || text.configError;
        if (error.message === 'invalidDomain') { domain.setAttribute('aria-invalid', 'true'); domain.focus(); }
        if (error.message === 'invalidPort') { port.setAttribute('aria-invalid', 'true'); port.focus(); }
      }
    };
    const invalidate = () => {
      domainField.hidden = mode.value !== 'https';
      domain.required = mode.value === 'https';
      configuration = null;
      result.hidden = true;
      status.textContent = text.configChanged;
    };
    form.addEventListener('input', invalidate);
    form.addEventListener('change', invalidate);
    form.addEventListener('submit', (event) => { event.preventDefault(); generate(); });
    document.querySelectorAll('[data-download-file]').forEach((button) => {
      button.addEventListener('click', () => {
        const name = button.dataset.downloadFile;
        if (!configuration || !Object.hasOwn(configuration.files, name)) return;
        const url = URL.createObjectURL(new Blob([configuration.files[name]], { type: 'text/plain;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        status.textContent = text.fileSaved;
      });
    });
    inputs.disabled = false;
    generate();
  }

  function appendNoteText(element, value) {
    // Only repository links become clickable; release HTML is always treated as text.
    const pattern = /\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g;
    let offset = 0;
    for (const match of value.matchAll(pattern)) {
      element.appendChild(document.createTextNode(value.slice(offset, match.index)));
      if (core.isRepositoryUrl(match[2], '')) {
        const link = document.createElement('a');
        link.textContent = match[1]; link.href = match[2]; link.rel = 'noopener';
        element.appendChild(link);
      } else element.appendChild(document.createTextNode(match[1]));
      offset = match.index + match[0].length;
    }
    element.appendChild(document.createTextNode(value.slice(offset)));
  }

  function renderReleaseNotes(container, body) {
    const lines = typeof body === 'string' ? body.slice(0, 16000).split(/\r?\n/).slice(0, 150) : [];
    let list = null;
    if (!lines.some((line) => line.trim())) lines.push(text.noNotes);
    lines.forEach((line) => {
      if (!line.trim()) { list = null; return; }
      const bullet = /^\s*[-*]\s+/.test(line);
      const heading = /^#{1,6}\s+/.test(line);
      if (bullet && !list) { list = document.createElement('ul'); container.appendChild(list); }
      if (!bullet) list = null;
      const element = document.createElement(bullet ? 'li' : heading ? 'h4' : 'p');
      appendNoteText(element, line.replace(/^\s*(?:[-*]|#{1,6})\s+/, ''));
      (list || container).appendChild(element);
    });
  }

  async function initReleaseHistory() {
    const container = document.querySelector('#releaseHistory');
    const status = document.querySelector('#releaseHistoryStatus');
    if (!container || !status) return;
    status.textContent = text.historyLoading;
    try {
      const response = await loadReleaseData('?per_page=10');
      const releases = Array.isArray(response) ? response.filter((release) => release && !release.draft
        && typeof release.tag_name === 'string' && core.isRepositoryUrl(release.html_url, 'releases/tag/')).slice(0, 10) : [];
      releases.forEach((release) => {
        const article = document.createElement('article'); article.className = 'release-entry';
        const heading = document.createElement('h2'); heading.textContent = release.name || release.tag_name;
        const meta = document.createElement('p'); meta.className = 'release-meta';
        meta.textContent = [release.tag_name, core.formatDate(release.published_at, language), release.prerelease && text.prerelease].filter(Boolean).join(' · ');
        const notes = document.createElement('div'); notes.className = 'release-notes'; renderReleaseNotes(notes, release.body);
        const link = document.createElement('a'); link.className = 'text-link'; link.href = release.html_url; link.textContent = `${text.fullNotes} →`; link.rel = 'noopener';
        article.append(heading, meta, notes, link); container.appendChild(article);
      });
      status.textContent = releases.length ? '' : text.historyEmpty;
    } catch { status.textContent = text.historyFailed; }
  }

  initCopyrightYear();
  initStickyHeader();
  initMobileNavigation();
  initCopyButtons();
  initLanguageLink();
  initDocumentationSearch();
  initHostGenerator();
  initDownloads();
  initReleaseHistory();
}());
