(function () {
  'use strict';

  if (window.top === window || document.getElementById('cx-mv3-material-scanner')) return;

  const PANEL_ID = 'cx-mv3-material-scanner';
  const STYLE_ID = `${PANEL_ID}-style`;
  const REQUEST_DELAY_MS = 260;
  const REQUEST_TIMEOUT_MS = 30000;
  const MAX_RETRIES = 2;

  const state = {
    running: false,
    startedAt: null,
    finishedAt: null,
    currentDirectory: '',
    scannedDirectories: 0,
    totalDirectories: 0,
    folderCount: 0,
    fileCount: 0,
    failedCount: 0,
    specialCount: 0,
    duplicateDataIdCount: 0,
    maxDepth: 0,
    failures: [],
    specials: [],
    folders: [],
    files: [],
    seenFolders: new Set(),
    seenFiles: new Set(),
    seenDataIds: new Set(),
    duplicateDataIds: new Set(),
    queuedFolders: new Set(),
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const text = (value) => String(value == null ? '' : value).trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function getContext() {
    const params = new URL(location.href).searchParams;
    const valueFrom = (...names) => names.map((name) => params.get(name)).find((value) => value) || '';
    return {
      courseId: valueFrom('courseid', 'courseId'),
      clazzId: valueFrom('clazzid', 'classId', 'clazzId'),
      cpi: valueFrom('cpi'),
      ut: valueFrom('ut') || 's',
    };
  }

  const context = getContext();

  const STATUS_LABELS = {
    complete: '已完成',
    skipped: '已存在，已跳过',
    downloading: '下载中',
    triggering: '准备下载',
    queued: '排队中',
    awaiting_user_approval: '等待安全确认',
    safety_blocked: '被浏览器安全策略阻止',
    failed: '下载失败',
    removed: '下载记录已移除',
  };

  function courseLabel() {
    try {
      const title = text(window.top?.document?.title);
      if (title) return title.replace(/\s*[—-]\s*超星学习通.*$/u, '').trim();
    } catch (_) {
      // 跨上下文读取失败时回退到课程 ID。
    }
    return context.courseId ? `课程 ${context.courseId}` : '当前课程';
  }

  function addStyle() {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} { position:fixed; right:14px; bottom:220px; z-index:2147483647; width:380px; color:#203040; background:#fff; border:1px solid #9eb7cc; border-radius:8px; box-shadow:0 3px 15px #0003; font:12px/1.45 Arial,"Microsoft YaHei",sans-serif; }
      #${PANEL_ID} .head { padding:9px 11px; color:#fff; background:#3978b9; border-radius:8px 8px 0 0; font-weight:600; font-size:13px; }
      #${PANEL_ID} .body { padding:10px 11px 11px; }
      #${PANEL_ID} .course { color:#234; font-weight:600; margin-bottom:6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      #${PANEL_ID} .buttons { display:flex; gap:5px; flex-wrap:wrap; margin-bottom:7px; }
      #${PANEL_ID} button { padding:5px 8px; border:1px solid #7da4c5; border-radius:4px; background:#f4f9fd; color:#174d7b; cursor:pointer; }
      #${PANEL_ID} button.primary { color:#fff; background:#3978b9; border-color:#3978b9; }
      #${PANEL_ID} button.warn { color:#754500; background:#fff0c2; border-color:#d69a35; }
      #${PANEL_ID} button:disabled { color:#888; cursor:not-allowed; }
      #${PANEL_ID} .line { margin:3px 0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      #${PANEL_ID} .progress { height:6px; margin:7px 0; background:#e8eef3; border-radius:5px; overflow:hidden; }
      #${PANEL_ID} .progress > i { display:block; width:0; height:100%; background:#3978b9; transition:width .2s; }
      #${PANEL_ID} .notice { margin:7px 0; padding:6px 7px; color:#754500; background:#fff7e6; border:1px solid #edc36d; border-radius:4px; }
      #${PANEL_ID} details { margin-top:7px; border-top:1px solid #e5edf3; padding-top:5px; }
      #${PANEL_ID} summary { cursor:pointer; color:#456; }
      #${PANEL_ID} .issue, #${PANEL_ID} .path-item { margin:5px 0; padding:5px 6px; background:#f7fafc; border-left:3px solid #9eb7cc; word-break:break-all; }
      #${PANEL_ID} .issue.error { border-left-color:#c64b4b; }
      #${PANEL_ID} .path-label { color:#687b8b; }
      #${PANEL_ID} pre { max-height:240px; overflow:auto; white-space:pre-wrap; }
    `;
    document.documentElement.appendChild(style);
  }

  function createPanel() {
    addStyle();
    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="head">超星课程资料</div>
      <div class="body">
        <div class="course" data-field="course">课程：${courseLabel()}</div>
        <div class="buttons">
          <button class="primary" data-action="scan">扫描全部资料</button>
          <button class="primary" data-action="download" disabled>下载全部</button>
          <button class="warn" data-action="approval" hidden>处理安全确认</button>
          <button data-action="view" disabled>查看结果</button>
          <button data-action="export" disabled>导出 Manifest</button>
        </div>
        <div class="line" data-field="status">等待开始</div>
        <div class="line" data-field="progress">资料文件：尚未扫描</div>
        <div class="progress"><i data-field="progress-bar"></i></div>
        <div class="line" data-field="downloads">下载状态：尚未开始</div>
        <div class="line" data-field="current">当前目录：-</div>
        <div class="notice" data-field="approval-notice" hidden></div>
        <details data-section="issues" hidden><summary>异常项</summary><div data-field="issues"></div></details>
        <details data-section="paths" hidden><summary>路径详情</summary><div data-field="paths"></div></details>
        <details data-section="technical"><summary>技术详情</summary><div class="line" data-field="extra">特殊行 0 · 重复 dataId 0 · 最大深度 0</div><pre data-field="output"></pre></details>
      </div>`;
    document.body.appendChild(panel);
    panel.querySelector('[data-action="scan"]').addEventListener('click', scanAll);
    panel.querySelector('[data-action="download"]').addEventListener('click', downloadAll);
    panel.querySelector('[data-action="approval"]').addEventListener('click', openApprovalPage);
    panel.querySelector('[data-action="view"]').addEventListener('click', () => {
      panel.querySelector('[data-section="technical"]').open = true;
      panel.querySelector('[data-field="output"]').textContent = JSON.stringify(buildManifest(), null, 2);
    });
    panel.querySelector('[data-action="export"]').addEventListener('click', exportManifest);
    return panel;
  }

  const panel = createPanel();

  function setField(name, value) {
    const node = panel.querySelector(`[data-field="${name}"]`);
    if (node) node.textContent = value;
  }

  function setHidden(selector, hidden) {
    const node = panel.querySelector(selector);
    if (node) node.hidden = hidden;
  }

  function taskStatus(task) {
    return task?.outcome || task?.state || '';
  }

  function statusLabel(status) {
    return STATUS_LABELS[status] || status || '未开始';
  }

  function latestTasksForManifest(manifest, storedState) {
    const ids = new Set((manifest?.files || []).map((file) => String(file.dataId)));
    const latest = new Map();
    for (const task of Object.values(storedState?.tasks || {})) {
      if (!ids.has(String(task.manifestItemId || task.dataId))) continue;
      const key = String(task.manifestItemId || task.dataId);
      const previous = latest.get(key);
      if (!previous || String(task.createdAt || '') > String(previous.createdAt || '')) latest.set(key, task);
    }
    return latest;
  }

  function clearAndAppend(container, nodes) {
    container.replaceChildren();
    if (!nodes.length) {
      container.textContent = '暂无异常。';
      return;
    }
    container.append(...nodes);
  }

  function taskDetailNode(task, kind = 'issue') {
    const node = document.createElement('div');
    node.className = kind === 'issue' ? 'issue error' : 'path-item';
    const logical = task.relativePath || task.requestedFilename || task.manifestName || task.name || '';
    if (kind === 'issue') {
      node.textContent = `${logical} · ${statusLabel(taskStatus(task))}${task.error ? ` · ${task.error}` : ''}`;
    } else {
      const actual = task.actualFilename || task.actualPath || '尚未生成';
      node.innerHTML = '';
      const title = document.createElement('div');
      title.textContent = task.manifestName || task.name || logical;
      const logicalLine = document.createElement('div');
      logicalLine.innerHTML = `<span class="path-label">课程路径：</span>`;
      logicalLine.append(document.createTextNode(logical));
      const requestedLine = document.createElement('div');
      requestedLine.innerHTML = `<span class="path-label">请求路径：</span>`;
      requestedLine.append(document.createTextNode(task.requestedFilename || '未记录'));
      const actualLine = document.createElement('div');
      actualLine.innerHTML = `<span class="path-label">实际路径：</span>`;
      actualLine.append(document.createTextNode(actual));
      node.append(title, logicalLine, requestedLine, actualLine);
    }
    return node;
  }

  function renderDownloadSummary(storedState) {
    const manifest = state.files.length ? buildManifest() : null;
    if (!manifest) {
      setField('downloads', '下载状态：扫描后可开始下载');
      setHidden('[data-action="download"]', true);
      setHidden('[data-action="approval"]', true);
      setHidden('[data-section="issues"]', true);
      setHidden('[data-section="paths"]', true);
      return;
    }

    if (state.running) {
      const scanPercent = state.totalDirectories
        ? Math.min(99, Math.round((state.scannedDirectories / state.totalDirectories) * 100))
        : 0;
      setField('progress', `正在扫描资料：已发现 ${state.fileCount} 个文件 · ${state.scannedDirectories} 个目录`);
      const bar = panel.querySelector('[data-field="progress-bar"]');
      if (bar) bar.style.width = `${scanPercent}%`;
      setField('downloads', '下载状态：扫描完成后更新');
      setHidden('[data-action="download"]', false);
      const downloadButton = panel.querySelector('[data-action="download"]');
      if (downloadButton) downloadButton.disabled = true;
      setHidden('[data-action="approval"]', true);
      setHidden('[data-section="issues"]', true);
      setHidden('[data-section="paths"]', true);
      return;
    }

    const latest = latestTasksForManifest(manifest, storedState);
    const counts = {};
    for (const task of latest.values()) {
      const status = taskStatus(task) || 'queued';
      counts[status] = (counts[status] || 0) + 1;
    }
    const total = manifest.files.length;
    const finished = (counts.complete || 0) + (counts.skipped || 0);
    const percent = total ? Math.round((finished / total) * 100) : 0;
    setField('progress', `资料文件：${total} · 已处理 ${finished}（${percent}%）`);
    const bar = panel.querySelector('[data-field="progress-bar"]');
    if (bar) bar.style.width = `${percent}%`;
    setField('downloads', [
      `下载：${finished}/${total}`,
      `已完成 ${counts.complete || 0}`,
      `已跳过 ${counts.skipped || 0}`,
      `下载中 ${counts.downloading || 0}`,
      `待处理 ${counts.queued || 0}`,
      `安全确认 ${counts.awaiting_user_approval || 0}`,
      `失败 ${counts.failed || 0}`,
    ].join(' · '));

    const waiting = counts.awaiting_user_approval || 0;
    const approvalButton = panel.querySelector('[data-action="approval"]');
    if (approvalButton) approvalButton.hidden = waiting === 0;
    const notice = panel.querySelector('[data-field="approval-notice"]');
    if (notice) {
      notice.hidden = waiting === 0;
      notice.textContent = waiting ? `${waiting} 个文件等待 Chrome 安全确认。点击“处理安全确认”打开现有确认页面。` : '';
    }

    const active = (counts.queued || 0) + (counts.triggering || 0) + (counts.downloading || 0) + waiting;
    const downloadButton = panel.querySelector('[data-action="download"]');
    if (downloadButton) {
      downloadButton.hidden = false;
      downloadButton.disabled = state.running || active > 0;
      downloadButton.title = active > 0 ? '已有下载任务在处理，请等待当前队列完成' : '';
    }

    const issues = [...latest.values()].filter((task) => ['failed', 'safety_blocked', 'removed'].includes(taskStatus(task)));
    const issueSection = panel.querySelector('[data-section="issues"]');
    if (issueSection) issueSection.hidden = issues.length === 0;
    clearAndAppend(panel.querySelector('[data-field="issues"]'), issues.map((task) => taskDetailNode(task)));

    const pathItems = [...latest.values()].filter((task) => {
      const actual = String(task.actualFilename || task.actualPath || '').replaceAll('\\', '/').toLowerCase();
      const requested = String(task.requestedFilename || task.targetPath || '').replaceAll('\\', '/').toLowerCase();
      return actual && requested && !actual.endsWith(requested);
    }).slice(0, 20);
    const pathSection = panel.querySelector('[data-section="paths"]');
    if (pathSection) pathSection.hidden = pathItems.length === 0;
    clearAndAppend(panel.querySelector('[data-field="paths"]'), pathItems.map((task) => taskDetailNode(task, 'path')));
  }

  function requestStoredState() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'cx-mv3-skeleton-get-state' }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) resolve(null);
        else resolve(response.state);
      });
    });
  }

  async function refreshDownloadSummary() {
    const storedState = await requestStoredState();
    if (storedState) renderDownloadSummary(storedState);
  }

  function openApprovalPage() {
    console.info('[CX MV3 UI] approval click: runtime.sendMessage start');
    chrome.runtime.sendMessage({ type: 'cx-mv3-skeleton-open-approval' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[CX MV3 UI] approval runtime.sendMessage error', chrome.runtime.lastError.message);
        setField('status', `打开安全确认失败：${chrome.runtime.lastError.message}`);
        return;
      }
      console.info('[CX MV3 UI] approval runtime.sendMessage callback', response);
      if (!response?.ok) {
        setField('status', `打开安全确认失败：${response?.error || '未知错误'}`);
      }
    });
  }

  function buildDownloadItems(manifest) {
    const links = [...document.links];
    const origin = links.find((link) => link.href.includes('/coursedata/downloadData'))
      ? new URL(links.find((link) => link.href.includes('/coursedata/downloadData')).href).origin
      : 'https://mooc1.chaoxing.com';
    return manifest.files.map((file) => {
      const url = new URL(`${origin}/coursedata/downloadData`);
      url.searchParams.set('dataId', file.dataId);
      url.searchParams.set('classId', manifest.clazzId);
      url.searchParams.set('cpi', manifest.cpi);
      url.searchParams.set('courseId', manifest.courseId);
      url.searchParams.set('ut', context.ut || 's');
      return {
        manifestItemId: file.dataId,
        dataId: file.dataId,
        name: file.name,
        manifestName: file.name,
        requestedFilename: file.relativePath,
        url: url.toString(),
        relativePath: file.relativePath,
        pageUrl: location.href,
        objectid: file.objectid,
        type: file.type,
        parentIds: file.parentIds,
      };
    });
  }

  async function downloadAll() {
    if (state.running || !state.files.length) return;
    const stored = await requestStoredState();
    const manifest = buildManifest();
    const latest = latestTasksForManifest(manifest, stored);
    if ([...latest.values()].some((task) => ['queued', 'triggering', 'downloading', 'awaiting_user_approval'].includes(taskStatus(task)))) {
      setField('status', '已有下载任务在处理，请先完成当前队列');
      return;
    }
    const items = buildDownloadItems(manifest);
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'cx-mv3-skeleton-enqueue-batch', items }, (value) => {
        resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : value);
      });
    });
    setField('status', response?.ok ? '已加入下载队列' : `加入队列失败：${response?.error || '未知错误'}`);
    await refreshDownloadSummary();
  }

  function updateUI() {
    setField('current', `当前目录：${state.currentDirectory || '-'}`);
    setField('progress', `资料文件：${state.fileCount} · 已扫描目录 ${state.scannedDirectories}`);
    setField('extra', `特殊行 ${state.specialCount} · 重复 dataId ${state.duplicateDataIdCount} · 最大深度 ${state.maxDepth}`);
    if (state.running) setField('status', `正在扫描（${state.scannedDirectories} 个目录）…`);
    refreshDownloadSummary();
  }

  function requestUrl(directory, pageNumber) {
    const url = new URL(location.href);
    const params = url.searchParams;
    params.set('dataName', directory.name || '');
    params.set('dataId', directory.dataId || '0');
    params.set('type', '1');
    params.set('parent', (directory.parentIds || []).join(','));
    params.set('isAjax', 'isAjax');
    params.set('pages', String(pageNumber));
    params.delete('page');
    return url.toString();
  }

  async function fetchHtml(url) {
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'text/html,*/*' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
      } catch (error) {
        lastError = error;
        if (attempt < MAX_RETRIES) await sleep(700 * (attempt + 1));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError || new Error('请求失败');
  }

  function noteDataId(dataId) {
    if (!dataId) return;
    if (state.seenDataIds.has(dataId)) state.duplicateDataIds.add(dataId);
    else state.seenDataIds.add(dataId);
    state.duplicateDataIdCount = state.duplicateDataIds.size;
  }

  function parsePage(html, directory, pageNumber) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = $$('ul.dataBody_td', doc);
    const folders = [];
    const files = [];
    const specials = [];
    const pageValue = (selector) => text($(selector, doc)?.value || $(selector, doc)?.textContent);
    const totalPage = Math.max(1, Number(pageValue('#totalPage') || pageValue('#totalPages') || '1') || 1);

    for (const row of rows) {
      const type = text(row.getAttribute('type'));
      const dataId = text(row.getAttribute('dataId') || row.getAttribute('dataid') || row.getAttribute('id'));
      const name = text(row.getAttribute('dataname')) || text($('a.rename_title', row)?.getAttribute('title')) || text($('a.rename_title', row)?.textContent);
      const objectid = text(row.getAttribute('objectid'));
      const parentIds = [...(directory.parentIds || []), ...(directory.dataId && directory.dataId !== '0' ? [directory.dataId] : [])];
      const pathSegments = [...(directory.pathSegments || []), name].filter(Boolean);
      const rowData = { name, dataId, objectid, type, parentIds, pathSegments };
      noteDataId(dataId);
      const depth = type === 'afolder' ? pathSegments.length : Math.max(0, pathSegments.length - 1);
      state.maxDepth = Math.max(state.maxDepth, depth);
      if (type === 'afolder') folders.push(rowData);
      else if (dataId && name && type && type !== 'book') files.push(rowData);
      else specials.push({ name, dataId, objectid, type, page: pageNumber, directory: directory.name || '(根目录)' });
    }
    return { folders, files, specials, totalPage };
  }

  function recordFailure(directory, pageNumber, error) {
    state.failedCount += 1;
    state.failures.push({
      dataId: directory.dataId,
      name: directory.name,
      parentIds: [...(directory.parentIds || [])],
      page: pageNumber,
      error: text(error?.message || error),
    });
  }

  async function scanDirectory(directory) {
    state.currentDirectory = directory.pathSegments?.join(' / ') || '(根目录)';
    updateUI();
    let firstPage;
    try {
      firstPage = parsePage(await fetchHtml(requestUrl(directory, 1)), directory, 1);
    } catch (error) {
      recordFailure(directory, 1, error);
      return [];
    }
    const pages = [firstPage];
    for (let pageNumber = 2; pageNumber <= firstPage.totalPage; pageNumber += 1) {
      await sleep(REQUEST_DELAY_MS);
      try {
        pages.push(parsePage(await fetchHtml(requestUrl(directory, pageNumber)), directory, pageNumber));
      } catch (error) {
        recordFailure(directory, pageNumber, error);
      }
    }

    const childFolders = [];
    for (const parsed of pages) {
      for (const folder of parsed.folders) {
        if (!folder.dataId || state.seenFolders.has(folder.dataId)) continue;
        state.seenFolders.add(folder.dataId);
        state.folderCount += 1;
        state.folders.push({ ...folder, parentIds: [...(directory.parentIds || []), ...(directory.dataId !== '0' ? [directory.dataId] : [])] });
        if (!state.queuedFolders.has(folder.dataId)) {
          state.queuedFolders.add(folder.dataId);
          childFolders.push(folder);
        }
      }
      for (const file of parsed.files) {
        if (!file.dataId || state.seenFiles.has(file.dataId)) continue;
        state.seenFiles.add(file.dataId);
        state.fileCount += 1;
        state.files.push({
          ...file,
          parentIds: [...(directory.parentIds || []), ...(directory.dataId !== '0' ? [directory.dataId] : [])],
          pathSegments: [...(directory.pathSegments || []), file.name].filter(Boolean),
          relativePath: [...(directory.pathSegments || []), file.name].filter(Boolean).join('/'),
        });
      }
      state.specials.push(...parsed.specials);
      state.specialCount += parsed.specials.length;
    }
    return childFolders;
  }

  function resetState() {
    for (const key of ['scannedDirectories', 'totalDirectories', 'folderCount', 'fileCount', 'failedCount', 'specialCount', 'duplicateDataIdCount', 'maxDepth']) state[key] = 0;
    state.startedAt = new Date().toISOString();
    state.finishedAt = null;
    state.currentDirectory = '';
    state.failures = [];
    state.specials = [];
    state.folders = [];
    state.files = [];
    state.seenFolders = new Set();
    state.seenFiles = new Set();
    state.seenDataIds = new Set();
    state.duplicateDataIds = new Set();
    state.queuedFolders = new Set(['0']);
  }

  function recordLiveSpecialRows() {
    for (const row of $$('ul.dataBody_td')) {
      const type = text(row.getAttribute('type'));
      if (!type.startsWith('tch-')) continue;
      const special = {
        name: text(row.getAttribute('dataname')) || text(row.textContent).split('\n')[0],
        dataId: text(row.getAttribute('dataId') || row.getAttribute('dataid') || row.getAttribute('id')),
        objectid: text(row.getAttribute('objectid')),
        type,
        page: 1,
        directory: '(当前页面特殊行)',
      };
      state.specials.push(special);
      state.specialCount += 1;
    }
  }

  function buildManifest() {
    return {
      schemaVersion: 1,
      scanner: 'mv3-scanner',
      scannedAt: state.finishedAt || new Date().toISOString(),
      courseId: context.courseId,
      clazzId: context.clazzId,
      cpi: context.cpi,
      folders: state.folders.map((item) => ({
        name: item.name, relativePath: item.pathSegments.join('/'), pathSegments: item.pathSegments,
        dataId: item.dataId, objectid: item.objectid, type: item.type, parentIds: item.parentIds,
      })),
      files: state.files.map((item) => ({
        name: item.name, relativePath: item.relativePath, pathSegments: item.pathSegments,
        dataId: item.dataId, objectid: item.objectid, type: item.type, parentIds: item.parentIds,
      })),
      failures: state.failures,
      specials: state.specials,
      stats: {
        folders: state.folderCount, files: state.fileCount, failures: state.failedCount,
        specials: state.specialCount, duplicateDataIds: state.duplicateDataIdCount, maxDepth: state.maxDepth,
      },
    };
  }

  function exportManifest() {
    const blob = new Blob([JSON.stringify(buildManifest(), null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `chaoxing-material-manifest-${context.courseId || 'course'}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function scanAll() {
    if (state.running) return;
    state.running = true;
    resetState();
    recordLiveSpecialRows();
    const scanButton = panel.querySelector('[data-action="scan"]');
    scanButton.disabled = true;
    panel.querySelector('[data-action="view"]').disabled = true;
    panel.querySelector('[data-action="export"]').disabled = true;
    setField('status', '扫描中…');
    const queue = [{ dataId: '0', name: '', parentIds: [], pathSegments: [] }];
    while (queue.length) {
      const directory = queue.shift();
      state.totalDirectories = Math.max(state.totalDirectories, state.scannedDirectories + queue.length + 1);
      const children = await scanDirectory(directory);
      queue.push(...children);
      state.scannedDirectories += 1;
      updateUI();
      await sleep(REQUEST_DELAY_MS);
    }
    state.currentDirectory = '';
    state.running = false;
    state.finishedAt = new Date().toISOString();
    setField('status', state.failedCount ? '扫描完成（有失败项）' : '扫描完成');
    scanButton.disabled = false;
    panel.querySelector('[data-action="view"]').disabled = false;
    panel.querySelector('[data-action="export"]').disabled = false;
    updateUI();
    window.__cxMv3MaterialScanner.manifest = buildManifest();
    console.info('[CX MV3 资料扫描器] manifest', window.__cxMv3MaterialScanner.manifest);
    await refreshDownloadSummary();
  }

  window.__cxMv3MaterialScanner = {
    version: '1.0.0-mv3',
    state,
    manifest: null,
    getManifest: buildManifest,
    getStats: () => ({ folders: state.folderCount, files: state.fileCount, failures: state.failedCount, specials: state.specialCount, duplicateDataIds: state.duplicateDataIdCount, maxDepth: state.maxDepth, running: state.running }),
    refreshDownloadSummary,
  };

  refreshDownloadSummary();
  setInterval(refreshDownloadSummary, 2000);
})();
