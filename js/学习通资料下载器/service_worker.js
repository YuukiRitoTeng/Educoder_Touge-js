const STORAGE_KEY = 'cxMv3SkeletonState';
const SCHEMA_VERSION = 2;
const MAX_CONCURRENCY = 2;
const ACTIVE_STATES = new Set(['triggering', 'downloading']);
const FINAL_STATUSES = new Set([
  'complete',
  'skipped',
  'awaiting_user_approval',
  'safety_blocked',
  'failed',
  'removed',
]);
const STATUS_ALIASES = {
  download_removed: 'removed',
};
let state = null;
let statePromise = null;
let pumpPromise = null;

function now() {
  return new Date().toISOString();
}

function emptyState() {
  return { version: SCHEMA_VERSION, updatedAt: now(), tasks: {}, queue: [] };
}

function canonicalStatus(value) {
  return STATUS_ALIASES[value] || value;
}

function finalStatusFor(value) {
  const status = canonicalStatus(value);
  return FINAL_STATUSES.has(status) ? status : '';
}

function isSuccessfulTask(task) {
  return task?.state === 'complete'
    || task?.state === 'skipped'
    || task?.outcome === 'complete'
    || task?.outcome === 'skipped';
}

function syncTaskFileNames(task, item = null) {
  task.manifestName ||= task.name || '';
  task.requestedFilename ||= task.targetPath || task.relativePath || task.name || '';
  if (item?.filename) {
    task.actualFilename = item.filename;
    // 保留旧字段，供历史审计和兼容读取；新逻辑以 actualFilename 为准。
    task.actualPath = task.actualFilename;
  } else {
    task.actualFilename ||= task.actualPath || '';
    task.actualPath ||= task.actualFilename;
  }
}

function normalizeTask(task) {
  const before = JSON.stringify({
    state: task.state,
    outcome: task.outcome,
    manifestName: task.manifestName,
    requestedFilename: task.requestedFilename,
    actualFilename: task.actualFilename,
    actualPath: task.actualPath,
  });

  const stateStatus = finalStatusFor(task.state);
  const outcomeStatus = finalStatusFor(task.outcome);
  if (stateStatus) task.state = stateStatus;
  if (outcomeStatus) task.outcome = outcomeStatus;

  // 旧版 skipped 使用 state=complete、outcome=skipped；收口为明确的 skipped。
  if (task.outcome === 'skipped') task.state = 'skipped';
  if (FINAL_STATUSES.has(task.state)) task.outcome = task.state;
  else if (!FINAL_STATUSES.has(task.outcome)) task.outcome = '';

  syncTaskFileNames(task);
  return before !== JSON.stringify({
    state: task.state,
    outcome: task.outcome,
    manifestName: task.manifestName,
    requestedFilename: task.requestedFilename,
    actualFilename: task.actualFilename,
    actualPath: task.actualPath,
  });
}

function migrateState(saved) {
  if (!saved || typeof saved !== 'object') return { state: emptyState(), changed: false };
  const migrated = saved;
  migrated.tasks ||= {};
  migrated.queue ||= [];
  let changed = migrated.version !== SCHEMA_VERSION;
  for (const task of Object.values(migrated.tasks)) {
    changed = normalizeTask(task) || changed;
  }
  if (migrated.version !== SCHEMA_VERSION) {
    migrated.version = SCHEMA_VERSION;
    changed = true;
  }
  return { state: migrated, changed };
}

function newTaskId() {
  return `cx-task-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

async function ensureState() {
  if (state) return state;
  if (!statePromise) {
    statePromise = chrome.storage.local.get(STORAGE_KEY).then(async (stored) => {
      const migrated = migrateState(stored[STORAGE_KEY]);
      state = migrated.state;
      if (migrated.changed) await saveState();
      await recoverInterruptedState();
      return state;
    });
  }
  return statePromise;
}

async function saveState() {
  state.updatedAt = now();
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

function appendLog(task, event, extra = {}) {
  const entry = { time: now(), event, ...extra };
  task.log ||= [];
  task.log.push(entry);
}

async function itemFor(downloadId) {
  const items = await chrome.downloads.search({ id: downloadId });
  return items[0] || null;
}

function itemFields(item) {
  if (!item) return null;
  return {
    id: item.id,
    url: item.url || '',
    finalUrl: item.finalUrl || '',
    referrer: item.referrer || '',
    filename: item.filename || '',
    mime: item.mime || '',
    totalBytes: item.totalBytes,
    bytesReceived: item.bytesReceived,
    state: item.state,
    error: item.error || '',
    danger: item.danger || 'safe',
    paused: item.paused === true,
    canResume: item.canResume === true,
    exists: item.exists,
    startTime: item.startTime || '',
    endTime: item.endTime || '',
    estimatedEndTime: item.estimatedEndTime || '',
    tabId: item.tabId,
  };
}

function isDangerous(item) {
  return Boolean(item && item.danger && item.danger !== 'safe');
}

function recordDangerChange(task, previousItem, item) {
  const from = previousItem?.danger || task.dangerLast || task.dangerInitial || 'safe';
  const to = item?.danger || 'safe';
  if (from === to) return;
  task.dangerChanges ||= [];
  const change = { from, to, time: now() };
  task.dangerChanges.push(change);
  task.dangerLast = to;
  if (from === 'host' && to === 'accepted') task.dangerHostToAccepted = true;
  appendLog(task, 'danger.changed', change);
}

function syncDangerApproval(task, item = null, terminalState = task.state) {
  const danger = item?.danger || task.dangerLast || task.dangerInitial || 'safe';
  if (item?.danger === 'accepted' || task.dangerHostToAccepted || task.dangerLast === 'accepted') {
    task.dangerApproval = 'accepted';
    task.dangerApprovalAcceptedAt ||= now();
    return;
  }
  if (terminalState === 'complete'
    && task.dangerApproval === 'pending'
    && (task.dangerInitial !== 'safe' || task.dangerChanges?.some((change) => change.to !== 'safe'))) {
    task.dangerApproval = 'accepted';
    task.dangerApprovalAcceptedAt ||= now();
    return;
  }
  if (terminalState === 'removed') {
    if (task.dangerApproval !== 'accepted') task.dangerApproval = 'removed';
    return;
  }
  if ((terminalState === 'failed' || terminalState === 'safety_blocked')
    && danger !== 'safe' && task.dangerApproval !== 'accepted') {
    task.dangerApproval = 'rejected';
    return;
  }
  if (danger !== 'safe' && task.dangerApproval !== 'accepted') task.dangerApproval = 'pending';
}

function taskView(task) {
  return task ? { ...task } : null;
}

function taskMatchesItem(task, item) {
  if (!task || !item || task.initialUrl !== item.url) return false;
  if (task.tabId != null && item.tabId != null && item.tabId >= 0 && task.tabId !== item.tabId) return false;
  return true;
}

function findTask(taskId) {
  return state?.tasks?.[taskId] || null;
}

function findTaskForItem(item) {
  const tasks = Object.values(state?.tasks || {});
  return tasks.find((task) => task.downloadId === item.id)
    || tasks.find((task) => ACTIVE_STATES.has(task.state) && taskMatchesItem(task, item))
    || null;
}

async function sendToTask(task, payload) {
  if (!Number.isInteger(task.frameId)) {
    return chrome.tabs.sendMessage(task.tabId, payload);
  }
  try {
    return await chrome.tabs.sendMessage(task.tabId, payload, { frameId: task.frameId });
  } catch (error) {
    // 页面重载或 iframe 重建后 frameId 会变化；回退到当前 tab 中的匹配 content script。
    const response = await chrome.tabs.sendMessage(task.tabId, payload);
    task.frameId = null;
    appendLog(task, 'message.frame-fallback', { reason: error.message || String(error) });
    await saveState();
    return response;
  }
}

async function notify(task, type, extra = {}) {
  if (!task) return;
  const item = task.downloadId == null ? null : await itemFor(task.downloadId);
  const payload = {
    type,
    task: taskView(task),
    item: itemFields(item) || task.item || null,
    ...extra,
  };
  try {
    await sendToTask(task, payload);
  } catch (error) {
    console.warn('[学习通资料归档助手] 页面状态通知失败', error.message);
  }
}

async function transition(task, nextState, event, extra = {}) {
  task.state = nextState;
  task.outcome = finalStatusFor(nextState);
  task.updatedAt = now();
  Object.assign(task, extra);
  syncTaskFileNames(task, task.item);
  appendLog(task, event, { state: nextState, ...extra });
  await saveState();
  await notify(task, 'task-state');
}

async function failTask(task, error, event = 'task.failed', finalState = 'failed') {
  task.error = String(error || 'UNKNOWN_ERROR');
  syncDangerApproval(task, task.item, finalState);
  await transition(task, finalState, event, { error: task.error });
}

async function recoverInterruptedState() {
  let changed = false;
  for (const task of Object.values(state.tasks)) {
    if ((task.state === 'downloading' || task.state === 'awaiting_user_approval')
      && task.downloadId != null) {
      const item = await itemFor(task.downloadId);
      if (item) {
        const previousItem = task.item;
        recordDangerChange(task, previousItem, item);
        task.item = itemFields(item);
        task.dangerInitial ||= item.danger || 'safe';
        task.dangerLast = item.danger || 'safe';
        syncDangerApproval(task, item);
        syncTaskFileNames(task, item);
        if (item.state === 'complete') {
          task.state = 'complete';
          task.outcome = 'complete';
          syncDangerApproval(task, item, 'complete');
        }
        if (item.state === 'interrupted') {
          task.state = isDangerous(item) && task.dangerApproval !== 'accepted'
            ? 'safety_blocked'
            : 'failed';
          task.outcome = task.state;
          task.error = item.error || 'DOWNLOAD_INTERRUPTED';
          syncDangerApproval(task, item, task.state);
        } else if (isDangerous(item) && task.dangerApproval !== 'accepted') {
          task.state = 'awaiting_user_approval';
          task.error = '';
        } else if (item.state === 'in_progress') {
          task.state = 'downloading';
        }
        task.outcome = finalStatusFor(task.state);
        appendLog(task, isDangerous(item) && task.dangerApproval !== 'accepted'
          ? 'worker.recovered-dangerous-download'
          : 'worker.recovered-download', { item: task.item });
        changed = true;
      } else {
        task.item = null;
        task.actualFilename = '';
        task.actualPath = '';
        task.error = 'DOWNLOAD_ITEM_ERASED';
        task.dangerRemoval = 'download-item-missing';
        task.state = 'removed';
        task.outcome = 'removed';
        appendLog(task, 'worker.recovered-erased-download', {
          downloadId: task.downloadId,
          previousDanger: task.dangerLast || task.dangerInitial || 'unknown',
          error: task.error,
        });
        changed = true;
      }
    } else if (task.state === 'triggering' && task.downloadId == null) {
      const recent = await chrome.downloads.search({ query: [task.initialUrl], limit: 20 });
      const match = recent.find((item) => taskMatchesItem(task, item));
      if (match) {
        task.downloadId = match.id;
        task.item = itemFields(match);
        task.state = match.state === 'complete'
          ? 'complete'
          : match.state === 'interrupted'
            ? (isDangerous(match) && match.danger !== 'accepted' ? 'safety_blocked' : 'failed')
            : isDangerous(match)
              ? 'awaiting_user_approval'
              : 'downloading';
        task.outcome = finalStatusFor(task.state);
        task.error = match.error || '';
        task.dangerInitial = match.danger || 'safe';
        task.dangerLast = match.danger || 'safe';
        syncDangerApproval(task, match, task.state);
        appendLog(task, 'worker.recovered-created', { item: task.item });
      } else {
        task.state = 'queued';
        if (!state.queue.includes(task.taskId)) state.queue.push(task.taskId);
        appendLog(task, 'worker.requeued-triggering');
      }
      changed = true;
    } else if (task.state === 'complete') {
      const previousApproval = task.dangerApproval;
      syncDangerApproval(task, task.item, 'complete');
      if (task.dangerApproval !== previousApproval) {
        appendLog(task, 'worker.synced-danger-approval', {
          dangerApproval: task.dangerApproval,
        });
        changed = true;
      }
    } else if (task.state === 'removed') {
      const previousApproval = task.dangerApproval;
      syncDangerApproval(task, task.item, 'removed');
      if (task.dangerApproval !== previousApproval) {
        appendLog(task, 'worker.synced-danger-removal', {
          dangerApproval: task.dangerApproval,
        });
        changed = true;
      }
    }
  }
  if (changed) await saveState();
}

async function dispatchTask(task) {
  try {
    const response = await sendToTask(task, {
      type: 'cx-mv3-skeleton-trigger',
      taskId: task.taskId,
      url: task.initialUrl,
      filename: task.requestedFilename,
    });
    if (!response?.ok) throw new Error(response?.error || 'PAGE_TRIGGER_REJECTED');
    if (Number.isInteger(response.frameId)) task.frameId = response.frameId;
    appendLog(task, 'page.trigger-ack', { response });
    await saveState();
    await waitForDownloadBinding(task);
  } catch (error) {
    await failTask(task, error.message || error, 'page.trigger-failed');
  }
}

async function waitForDownloadBinding(task, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (task.downloadId != null || task.state === 'downloading' || task.state === 'complete') return;
    if (task.state === 'failed') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (task.state === 'triggering' && task.downloadId == null) {
    await failTask(task, 'DOWNLOAD_ITEM_NOT_CREATED_TIMEOUT', 'downloads.binding-timeout');
  }
}

async function pumpQueue() {
  if (pumpPromise) return pumpPromise;
  pumpPromise = (async () => {
    const current = await ensureState();
    while (true) {
      const activeCount = Object.values(current.tasks)
        .filter((task) => ACTIVE_STATES.has(task.state)).length;
      const slots = MAX_CONCURRENCY - activeCount;
      if (slots <= 0) return;

      let dispatched = false;
      for (let index = 0; index < slots; index += 1) {
        const task = current.queue
          .map((taskId) => current.tasks[taskId])
          .find((candidate) => candidate?.state === 'queued');
        if (!task) break;
        current.queue = current.queue.filter((taskId) => taskId !== task.taskId);
        await transition(task, 'triggering', 'queue.dispatch', { concurrency: MAX_CONCURRENCY });
        dispatched = true;
        // 先确认这个页面原生点击已经产生 DownloadItem，再触发下一个。
        // 这样仍允许两个真实 DownloadItem 并行下载，但避免同一页面瞬时多次 click 被浏览器 abort。
        await dispatchTask(task);
      }
      if (!dispatched) return;
    }
  })().finally(() => {
    pumpPromise = null;
  });
  return pumpPromise;
}

function taskForManifestItem(current, manifestItemId, stateFilter = null) {
  return Object.values(current.tasks)
    .find((task) => task.manifestItemId === String(manifestItemId)
      && (!stateFilter || (stateFilter === 'complete'
        ? isSuccessfulTask(task)
        : task.state === stateFilter)));
}

function createTask(message, sender, tabId) {
  const manifestName = message.manifestName || message.name || '';
  const requestedFilename = message.requestedFilename || message.relativePath || manifestName;
  return {
    taskId: newTaskId(),
    manifestItemId: String(message.manifestItemId || message.dataId || ''),
    name: manifestName,
    manifestName,
    relativePath: message.relativePath,
    targetPath: requestedFilename,
    requestedFilename,
    actualFilename: '',
    actualPath: '',
    initialUrl: message.url,
    pageUrl: message.pageUrl || '',
    dataId: String(message.dataId || ''),
    tabId,
    frameId: sender.frameId,
    downloadId: null,
    state: 'queued',
    outcome: '',
    skipReason: '',
    existingTaskId: '',
    dangerApproval: '',
    dangerApprovalAcceptedAt: '',
    dangerInitial: '',
    dangerLast: '',
    dangerChanges: [],
    dangerHostToAccepted: false,
    dangerRemoval: '',
    error: '',
    item: null,
    log: [],
    createdAt: now(),
    updatedAt: now(),
  };
}

async function enqueueItems(current, items, sender, tabId) {
  const results = [];
  for (const message of items) {
    const prior = taskForManifestItem(
      current,
      message.manifestItemId || message.dataId,
      'complete',
    );
    if (prior && isSuccessfulTask(prior)) {
      const skipped = createTask(message, sender, tabId);
      skipped.state = 'complete';
      skipped.outcome = 'skipped';
      skipped.skipReason = 'already-complete';
      skipped.existingTaskId = prior.taskId;
      skipped.downloadId = prior.downloadId ?? null;
      skipped.manifestName = message.manifestName || message.name || '';
      skipped.requestedFilename = message.requestedFilename || message.relativePath || skipped.name;
      skipped.actualFilename = prior.actualFilename || prior.actualPath || prior.item?.filename || '';
      skipped.actualPath = prior.actualPath || prior.item?.filename || '';
      appendLog(skipped, 'queue.skipped-complete', {
        existingTaskId: prior.taskId,
        existingDownloadId: prior.downloadId ?? null,
      });
      current.tasks[skipped.taskId] = skipped;
      results.push({ ok: true, skipped: true, task: taskView(skipped) });
      continue;
    }

    const task = createTask(message, sender, tabId);
    current.tasks[task.taskId] = task;
    current.queue.push(task.taskId);
    appendLog(task, 'queue.enqueued', {
      manifestItemId: task.manifestItemId,
      initialUrl: task.initialUrl,
      targetPath: task.targetPath,
    });
    results.push({ ok: true, skipped: false, task: taskView(task) });
  }
  await saveState();
  for (const result of results) await notify(result.task, 'task-state');
  return results;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;
  const tabId = sender.tab?.id;
  if (tabId == null) {
    sendResponse({ ok: false, error: 'NO_SENDER_TAB' });
    return false;
  }

  if (message.type === 'cx-mv3-skeleton-open-approval') {
    console.info('[CX MV3 SW] open-approval message received', {
      tabId,
      frameId: sender.frameId,
    });
    (async () => {
      try {
        console.info('[CX MV3 SW] chrome.action.openPopup called');
        await chrome.action.openPopup();
        console.info('[CX MV3 SW] chrome.action.openPopup resolved');
        sendResponse({ ok: true });
      } catch (error) {
        console.error('[CX MV3 SW] chrome.action.openPopup rejected', error?.message || String(error));
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();
    return true;
  }

  if (message.type === 'cx-mv3-skeleton-enqueue' || message.type === 'cx-mv3-skeleton-enqueue-batch') {
    ensureState().then(async (current) => {
      const items = message.type === 'cx-mv3-skeleton-enqueue-batch'
        ? (Array.isArray(message.items) ? message.items : [])
        : [message];
      if (!items.length) throw new Error('EMPTY_BATCH');
      const results = await enqueueItems(current, items, sender, tabId);
      sendResponse({ ok: true, results, task: results.length === 1 ? results[0].task : undefined });
      await pumpQueue();
    }).catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === 'cx-mv3-skeleton-get-state') {
    ensureState().then((current) => {
      sendResponse({ ok: true, state: current });
    }).catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  return false;
});

chrome.downloads.onCreated.addListener((item) => {
  ensureState().then(async (current) => {
    const task = findTaskForItem(item);
    if (!task) return;
    task.downloadId = item.id;
    task.item = itemFields(item);
    task.dangerInitial = item.danger || 'safe';
    task.dangerLast = task.dangerInitial;
    syncTaskFileNames(task, item);
    syncDangerApproval(task, item);
    if (isDangerous(item)) {
      await transition(task, 'awaiting_user_approval', 'downloads.danger-detected', {
        downloadId: item.id,
        item: task.item,
      });
      // 危险下载等待用户时不占用并发槽，继续调度队列中的其他任务。
      await pumpQueue();
      return;
    }
    await transition(task, 'downloading', 'downloads.onCreated', { downloadId: item.id, item: task.item });
  });
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // 对已由 Queue 建立关联的任务，必须在回调当前调用栈内 suggest，
  // 不能先等待 storage/search，否则 Chrome 可能退回默认文件名和目录。
  const task = findTaskForItem(item);
  if (task) {
    recordDangerChange(task, task.item, item);
    task.downloadId = item.id;
    task.item = itemFields(item);
    task.dangerInitial ||= item.danger || 'safe';
    task.dangerLast = item.danger || 'safe';
    syncDangerApproval(task, item);
    task.determiningFilenameHit = true;
    appendLog(task, 'downloads.onDeterminingFilename', {
      suggestedFilename: task.relativePath,
      item: task.item,
    });
    suggest({ filename: task.requestedFilename, conflictAction: 'uniquify' });
    saveState().then(() => notify(task, 'task-state', { determiningFilenameHit: true }));
    return;
  }

  // 仅作为 Service Worker 冷启动兜底；正常 Queue 任务会走上面的同步路径。
  ensureState().then(async () => {
    const recoveredTask = findTaskForItem(item);
    if (!recoveredTask) return;
    recordDangerChange(recoveredTask, recoveredTask.item, item);
    recoveredTask.downloadId = item.id;
    recoveredTask.item = itemFields(item);
    recoveredTask.dangerInitial ||= item.danger || 'safe';
    recoveredTask.dangerLast = item.danger || 'safe';
    syncDangerApproval(recoveredTask, item);
    recoveredTask.determiningFilenameHit = true;
    appendLog(recoveredTask, 'downloads.onDeterminingFilename.async-fallback', {
      suggestedFilename: recoveredTask.relativePath,
      item: recoveredTask.item,
    });
    suggest({ filename: recoveredTask.requestedFilename, conflictAction: 'uniquify' });
    await saveState();
    await notify(recoveredTask, 'task-state', { determiningFilenameHit: true });
  });
});

chrome.downloads.onChanged.addListener((delta) => {
  ensureState().then(async () => {
    const task = Object.values(state.tasks).find((candidate) => candidate.downloadId === delta.id);
    if (!task) return;
    const item = await itemFor(delta.id);
    if (!item) {
      appendLog(task, 'downloads.changed-item-missing', { downloadId: delta.id });
      await saveState();
      await notify(task, 'task-state');
      return;
    }
    recordDangerChange(task, task.item, item);
    task.item = itemFields(item);
    task.dangerInitial ||= item.danger || 'safe';
    task.dangerLast = item.danger || 'safe';
    syncDangerApproval(task, item);
    syncTaskFileNames(task, item);
    if (item?.state === 'complete') {
      await transition(task, 'complete', 'downloads.complete', { item: task.item, error: '' });
      await pumpQueue();
      return;
    }
    if (item?.state === 'interrupted') {
      const finalState = isDangerous(item) && task.dangerApproval !== 'accepted'
        ? 'safety_blocked'
        : 'failed';
      await failTask(task, item.error || 'DOWNLOAD_INTERRUPTED', 'downloads.interrupted', finalState);
      return;
    }
    if (isDangerous(item) && task.dangerApproval !== 'accepted') {
      if (task.state !== 'awaiting_user_approval') {
        await transition(task, 'awaiting_user_approval', 'downloads.danger-detected', { item: task.item });
      } else {
        appendLog(task, 'downloads.danger-changed', { item: task.item });
        await saveState();
        await notify(task, 'task-state');
      }
      await pumpQueue();
      return;
    }
    appendLog(task, 'downloads.changed', { item: task.item });
    await saveState();
    await notify(task, 'task-state');
  });
});

chrome.downloads.onErased.addListener((downloadId) => {
  ensureState().then(async () => {
    const task = Object.values(state.tasks).find((candidate) => candidate.downloadId === downloadId
      && (ACTIVE_STATES.has(candidate.state)
        || candidate.state === 'awaiting_user_approval'
        || candidate.state === 'safety_blocked'));
    if (!task) return;
    const previousDanger = task.dangerLast || task.dangerInitial || 'unknown';
    task.item = null;
    task.actualFilename = '';
    task.actualPath = '';
    task.error = 'DOWNLOAD_ITEM_ERASED';
    task.dangerRemoval = 'onErased';
    syncDangerApproval(task, null, 'removed');
    await transition(task, 'removed', 'downloads.onErased', {
      downloadId,
      previousDanger,
      error: task.error,
    });
  });
});

ensureState().then(() => pumpQueue());
