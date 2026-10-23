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

  initCopyrightYear();
  initStickyHeader();
  initMobileNavigation();
  initCopyButtons();
}());
