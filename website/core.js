'use strict';

(function exposeWebsiteCore(root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.SqlProWebsite = core;
}(typeof globalThis === 'object' ? globalThis : this, () => {
  const RELEASES_URL = 'https://github.com/MinhIT97/sqlPro/releases';
  const API_URL = 'https://api.github.com/repos/MinhIT97/sqlPro/releases';
  const FORMATS = [
    { id: 'downloadLinux', prefix: 'SqlPro-', suffix: '-amd64.deb', primary: true, label: ['Tải .deb trực tiếp', 'Download .deb'] },
    { id: 'downloadWindows', prefix: 'SqlPro-Setup-', suffix: '-x64.exe', primary: true, label: ['Tải .exe trực tiếp', 'Download installer'] },
    { id: 'downloadAppImage', prefix: 'SqlPro-', suffix: '-x86_64.AppImage', label: ['Tải AppImage', 'Download AppImage'] },
    { id: 'downloadPortable', prefix: 'SqlPro-Portable-', suffix: '-x64.exe', label: ['Tải Windows Portable', 'Download Windows Portable'] }
  ];
  const MESSAGES = {
    vi: {
      openMenu: 'Mở menu', closeMenu: 'Đóng menu', copy: 'Sao chép', copied: 'Đã sao chép', copyFailed: 'Không sao chép được',
      releasePage: 'Xem GitHub Releases', checking: 'Đang kiểm tra bộ cài trên GitHub Releases…',
      noAssets: 'Chưa có bộ cài phù hợp trên GitHub Releases. Bạn có thể xem các bản phát hành khác tại đó.',
      releaseFailed: 'Không kiểm tra được bộ cài. Bạn có thể xem trực tiếp trang GitHub Releases.',
      releaseReady: 'Tải trực tiếp từ GitHub Releases. Không cần cài Node.js.', unavailable: 'Chưa có tệp phù hợp cho định dạng này.',
      noDigest: 'Bản phát hành chưa cung cấp SHA-256 cho tệp này.', published: 'Phát hành', version: 'Phiên bản',
      historyLoading: 'Đang tải lịch sử phát hành…', historyEmpty: 'Chưa có bản phát hành công khai.',
      historyFailed: 'Không tải được lịch sử. Hãy xem GitHub Releases để kiểm tra bản mới nhất.',
      fullNotes: 'Xem bản phát hành trên GitHub', noNotes: 'Bản phát hành này chưa có ghi chú.', prerelease: 'Bản thử nghiệm',
      docsFound: 'chủ đề phù hợp', docsEmpty: 'Không tìm thấy chủ đề. Thử “SSH”, “SSL”, “backup” hoặc mã lỗi.',
      invalidPort: 'Cổng phải là số nguyên từ 1 đến 65535.', invalidDomain: 'Nhập domain DNS hợp lệ, ví dụ sync.example.com; không nhập giao thức hoặc đường dẫn.',
      invalidMode: 'Chọn chế độ localhost hoặc HTTPS.', configReady: 'Đã tạo cấu hình. Lưu các tệp vào cùng một thư mục rồi làm theo hướng dẫn.',
      configChanged: 'Thông số đã thay đổi. Hãy tạo lại cấu hình trước khi sao chép hoặc tải tệp.', configError: 'Không tạo được cấu hình.',
      hostLocal: 'Server chỉ mở trên localhost của máy chạy Docker.', hostHttps: 'Trỏ DNS của domain về máy chủ và mở TCP 80/443; Caddy sẽ yêu cầu chứng chỉ HTTPS.',
      fileSaved: 'Đã tạo tệp tải xuống.', unknownSize: 'Chưa có thông tin dung lượng'
    },
    en: {
      openMenu: 'Open menu', closeMenu: 'Close menu', copy: 'Copy', copied: 'Copied', copyFailed: 'Could not copy',
      releasePage: 'View GitHub Releases', checking: 'Checking installers on GitHub Releases…',
      noAssets: 'No matching installers are available yet. You can check other releases on GitHub.',
      releaseFailed: 'Could not check installers. You can visit GitHub Releases directly.',
      releaseReady: 'Download directly from GitHub Releases. No Node.js installation needed.', unavailable: 'No matching file is available for this format.',
      noDigest: 'This release does not provide a SHA-256 digest for this file.', published: 'Published', version: 'Version',
      historyLoading: 'Loading release history…', historyEmpty: 'No public releases are available yet.',
      historyFailed: 'Could not load release history. Check GitHub Releases for the latest version.',
      fullNotes: 'View release on GitHub', noNotes: 'This release has no notes yet.', prerelease: 'Pre-release',
      docsFound: 'matching topics', docsEmpty: 'No matching topics. Try “SSH”, “SSL”, “backup” or an error code.',
      invalidPort: 'Port must be a whole number from 1 to 65535.', invalidDomain: 'Enter a valid DNS domain such as sync.example.com, without a protocol or path.',
      invalidMode: 'Select localhost or HTTPS mode.', configReady: 'Configuration ready. Save the files in one directory, then follow the instructions.',
      configChanged: 'Settings changed. Generate the configuration again before copying or downloading files.', configError: 'Could not generate configuration.',
      hostLocal: 'The server is only exposed on localhost of the Docker host.', hostHttps: 'Point the domain’s DNS at the server and open TCP ports 80/443; Caddy will request an HTTPS certificate.',
      fileSaved: 'Download prepared.', unknownSize: 'File size not available'
    }
  };

  function isRepositoryUrl(value, section = 'releases/') {
    if (typeof value !== 'string') return false;
    try {
      const url = new URL(value);
      return url.origin === 'https://github.com' && !url.username && !url.password
        && url.pathname.startsWith(`/MinhIT97/sqlPro/${section}`);
    } catch {
      return false;
    }
  }

  function selectReleaseDownloads(release, language = 'vi') {
    const assets = Array.isArray(release?.assets) ? release.assets.filter((asset) =>
      typeof asset?.name === 'string' && (asset.state === undefined || asset.state === 'uploaded')
      && isRepositoryUrl(asset.browser_download_url, 'releases/download/')) : [];
    return FORMATS.map((format) => ({
      ...format, label: format.label[language === 'en' ? 1 : 0],
      asset: assets.find((asset) => asset.name.startsWith(format.prefix) && asset.name.endsWith(format.suffix))
    }));
  }

  function formatBytes(value, language = 'vi') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return MESSAGES[language].unknownSize;
    const index = value ? Math.min(3, Math.floor(Math.log(value) / Math.log(1024))) : 0;
    const safeIndex = Math.max(0, index);
    return `${new Intl.NumberFormat(language === 'en' ? 'en-US' : 'vi-VN', { maximumFractionDigits: 1 }).format(value / (1024 ** safeIndex))} ${['B', 'KiB', 'MiB', 'GiB'][safeIndex]}`;
  }

  function formatDate(value, language = 'vi') {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '';
    return new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : 'vi-VN', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value));
  }

  function releaseDigest(asset) {
    return typeof asset?.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest) ? asset.digest.slice(7).toLowerCase() : '';
  }

  function normalizeSearch(value) {
    return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
  }

  function matchesSearch(text, query) {
    const normalized = normalizeSearch(text);
    return normalizeSearch(query).trim().split(/\s+/).every((word) => normalized.includes(word));
  }

  function buildHostConfiguration({ mode, port, domain = '', registration = false }) {
    if (!['local', 'https'].includes(mode)) throw new Error('invalidMode');
    const portText = String(port);
    const number = Number(portText);
    if (!/^\d{1,5}$/.test(portText) || !Number.isInteger(number) || number < 1 || number > 65535) throw new Error('invalidPort');
    const hostname = String(domain).trim().toLowerCase();
    if (mode === 'https' && (hostname.length > 253 || !hostname.includes('.') || /^\d+(\.\d+){3}$/.test(hostname)
      || !hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      || !/[a-z]/.test(hostname.split('.').at(-1)))) throw new Error('invalidDomain');
    const https = mode === 'https';
    const env = `PORT=${number}\nSQLPRO_DB=/data/sqlpro.db\nWEBSITE_DIR=/app/website\nALLOW_REGISTRATION=${registration === true}\nTRUST_PROXY=${https ? 1 : 0}\nSESSION_TTL_DAYS=30\nMAX_VAULT_BYTES=5242880\n`;
    const compose = [
      'services:', '  sqlpro:', '    image: ghcr.io/minhit97/sqlpro-server:latest', '    restart: unless-stopped', '    env_file: .env',
      ...(https ? ['    expose:', '      - "${PORT}"'] : ['    ports:', '      - "127.0.0.1:${PORT}:${PORT}"']),
      '    volumes:', '      - sqlpro-data:/data',
      ...(https ? ['  caddy:', '    image: caddy:2', '    restart: unless-stopped', '    depends_on:', '      - sqlpro', '    ports:', '      - "80:80"', '      - "443:443"', '    volumes:', '      - ./Caddyfile:/etc/caddy/Caddyfile:ro', '      - caddy-data:/data', '      - caddy-config:/config'] : []),
      'volumes:', '  sqlpro-data:', ...(https ? ['  caddy-data:', '  caddy-config:'] : []), ''
    ].join('\n');
    const files = { '.env': env, 'compose.yaml': compose };
    if (https) files.Caddyfile = `${hostname} {\n  reverse_proxy sqlpro:${number}\n}\n`;
    return { files, url: https ? `https://${hostname}` : `http://localhost:${number}`, mode };
  }

  return Object.freeze({ RELEASES_URL, API_URL, FORMATS, MESSAGES, isRepositoryUrl, selectReleaseDownloads, formatBytes, formatDate, releaseDigest, matchesSearch, buildHostConfiguration });
}));
