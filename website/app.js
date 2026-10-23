'use strict';

(function setupWebsite() {
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
    const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
    const setOpen = (open) => {
      nav.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
      if (label) label.textContent = open ? 'Đóng menu' : 'Mở menu';
    };

    toggle.addEventListener('click', () => setOpen(!isOpen()));
    nav.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => setOpen(false));
    });
    document.addEventListener('click', (event) => {
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
      await navigator.clipboard.writeText(value);
      return;
    }

    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    try {
      area.select();
      if (!document.execCommand('copy')) throw new Error('copy failed');
    } finally {
      area.remove();
    }
  }

  function initCopyButtons() {
    const timers = new WeakMap();
    const versions = new WeakMap();
    document.querySelectorAll('[data-copy-target]').forEach((button) => {
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
          label.textContent = 'Đã sao chép';
        } catch {
          if (versions.get(button) !== version) return;
          button.classList.remove('copied');
          label.textContent = 'Không sao chép được';
        }

        timers.set(button, setTimeout(() => {
          button.classList.remove('copied');
          label.textContent = 'Sao chép';
          timers.delete(button);
        }, 2200));
      });
    });
  }

  function initDownloads() {
    const linux = document.querySelector('#downloadLinux');
    const windows = document.querySelector('#downloadWindows');
    const appImage = document.querySelector('#downloadAppImage');
    const portable = document.querySelector('#downloadPortable');
    const alternatives = document.querySelector('#downloadAlternatives');
    const status = document.querySelector('#downloadStatus');
    if (!linux || !windows || !status) return;

    const releasePage = 'https://github.com/MinhIT97/sqlPro/releases';
    const setPrimary = (link, asset, label) => {
      link.href = asset ? asset.browser_download_url : releasePage;
      link.querySelector('strong').textContent = asset ? label : 'Xem GitHub Releases';
    };
    const validAsset = (asset) => {
      if (typeof asset?.name !== 'string' || typeof asset.browser_download_url !== 'string') return false;
      try {
        const url = new URL(asset.browser_download_url);
        return url.origin === 'https://github.com'
          && url.pathname.startsWith('/MinhIT97/sqlPro/releases/download/');
      } catch {
        return false;
      }
    };
    const findAsset = (assets, prefix, suffix) => assets.find((asset) =>
      validAsset(asset) && asset.name.startsWith(prefix) && asset.name.endsWith(suffix));

    fetch('https://api.github.com/repos/MinhIT97/sqlPro/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' }
    }).then(async (response) => {
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`GitHub API ${response.status}`);
      return response.json();
    }).then((release) => {
      const assets = Array.isArray(release?.assets) ? release.assets : [];
      const deb = findAsset(assets, 'SqlPro-', '-amd64.deb');
      const installer = findAsset(assets, 'SqlPro-Setup-', '-x64.exe');
      const image = findAsset(assets, 'SqlPro-', '-x86_64.AppImage');
      const portableAsset = findAsset(assets, 'SqlPro-Portable-', '-x64.exe');

      setPrimary(linux, deb, 'Tải .deb trực tiếp');
      setPrimary(windows, installer, 'Tải .exe trực tiếp');
      if (image && appImage) {
        appImage.href = image.browser_download_url;
        appImage.hidden = false;
      }
      if (portableAsset && portable) {
        portable.href = portableAsset.browser_download_url;
        portable.hidden = false;
      }
      if (alternatives) alternatives.hidden = !image && !portableAsset;
      status.textContent = deb || installer || image || portableAsset
        ? `Bản ${release.tag_name} tải trực tiếp từ GitHub Releases. Không cần cài Node.js.`
        : 'Chưa có bộ cài công khai trên GitHub Releases. Hãy quay lại sau khi bản phát hành đầu tiên được đăng.';
    }).catch(() => {
      setPrimary(linux, null);
      setPrimary(windows, null);
      status.textContent = 'Không kiểm tra được bộ cài. Bạn có thể xem trực tiếp trang GitHub Releases.';
    });
  }

  initCopyrightYear();
  initStickyHeader();
  initMobileNavigation();
  initCopyButtons();
  initDownloads();
}());
