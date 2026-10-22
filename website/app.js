'use strict';

(function setupWebsite() {
  const header = document.querySelector('#siteHeader');
  const nav = document.querySelector('#siteNav');
  const navToggle = document.querySelector('#navToggle');
  const copyButtons = document.querySelectorAll('[data-copy-target]');
  const year = document.querySelector('#year');

  if (year) year.textContent = String(new Date().getFullYear());

  if (header) {
    const updateHeader = () => header.classList.toggle('scrolled', window.scrollY > 8);
    updateHeader();
    window.addEventListener('scroll', updateHeader, { passive: true });
  }

  if (navToggle && nav) {
    const setOpen = (open) => {
      nav.classList.toggle('open', open);
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      const label = navToggle.querySelector('.sr-only');
      if (label) label.textContent = open ? 'Đóng menu' : 'Mở menu';
    };
    navToggle.addEventListener('click', () => {
      setOpen(navToggle.getAttribute('aria-expanded') !== 'true');
    });
    nav.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => setOpen(false));
    });
    document.addEventListener('click', (event) => {
      if (navToggle.getAttribute('aria-expanded') !== 'true') return;
      if (nav.contains(event.target) || navToggle.contains(event.target)) return;
      setOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || navToggle.getAttribute('aria-expanded') !== 'true') return;
      setOpen(false);
      navToggle.focus();
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
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (!copied) throw new Error('copy failed');
  }

  copyButtons.forEach((button) => {
    button.addEventListener('click', async () => {
      const target = document.getElementById(button.dataset.copyTarget);
      const label = button.querySelector('span');
      if (!target || !label) return;
      try {
        await copyText(target.textContent.trim());
        button.classList.add('copied');
        label.textContent = 'Đã sao chép';
      } catch {
        label.textContent = 'Không sao chép được';
      }
      clearTimeout(button.__copyTimer);
      button.__copyTimer = setTimeout(() => {
        button.classList.remove('copied');
        label.textContent = 'Sao chép';
      }, 2200);
    });
  });
}());
