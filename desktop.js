(function setupDesktopBridge() {
  const desktop = window.sqlProDesktop;
  if (!desktop) return;

  document.body.classList.add('desktop-app');
  const runtimeBadge = document.querySelector('#runtimeBadge');

  function currentState() {
    return {
      connectionId: app.connection ? app.connection.id : null,
      workspaceId: app.activeWorkspaceId,
      database: app.database,
      table,
      mode,
      savedQuery: document.querySelector('#sql')?.value || sessionStorage.getItem('query') || '',
      queryTabs: queryTabs.map((tab) => ({ title: tab.title, sql: tab.sql ?? '' })),
      activeQuery,
      history: historyRows.slice(0, 100)
    };
  }

  function persistState() {
    return desktop.saveState(currentState()).catch(() => undefined);
  }

  desktop.onMenuCommand((command) => {
    const actions = {
      'new-connection': () => connection(),
      'import-navicat': () => importNavicat(),
      disconnect: () => disconnect(),
      'new-query': () => newQuery(),
      'save-query': () => saveQuery(),
      import: () => transfer('import'),
      export: () => transfer('export'),
      backup: () => backupDatabase(),
      restore: () => restoreDatabase(),
      'toggle-sidebar': () => document.body.classList.toggle('sidebar-hidden'),
      'run-query': async () => {
        if (mode !== 'query') await view('query');
        runQuery();
      },
      'cancel-query': () => cancelQuery(),
      'refresh-data': () => {
        if (mode === 'data') loadData();
        else view('data');
      }
    };
    actions[command]?.();
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      view('query').then(() => document.querySelector('#sql')?.focus());
    }
    if (event.key === 'Escape' && document.querySelector('#modal')?.open
      && !document.querySelector('.confirmation-dialog[open]')
      && !document.querySelector('#modal [data-transfer-running]')) closeModal();
  });

  window.addEventListener('beforeunload', () => {
    persistState();
  });

  desktop.getMetadata().then((metadata) => {
    if (!runtimeBadge) return;
    runtimeBadge.textContent = `DESKTOP · v${metadata.version}`;
    runtimeBadge.title = metadata.platform === 'win32'
      ? 'Windows'
      : metadata.platform === 'linux'
        ? 'Ubuntu / Linux'
        : metadata.platform;
  }).catch(() => {
    if (runtimeBadge) runtimeBadge.textContent = 'DESKTOP';
  });
}());
