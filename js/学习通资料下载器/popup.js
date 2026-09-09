(function () {
  'use strict';

  const STATE_KEY = 'cxMv3SkeletonState';
  const AUDIT_KEY = 'cxMv3A1PopupAudit';
  const tasksBox = document.getElementById('tasks');
  const statusBox = document.getElementById('status');
  const auditBox = document.getElementById('audit');

  function now() {
    return new Date().toISOString();
  }

  function itemView(item) {
    if (!item) return null;
    return {
      id: item.id,
      state: item.state,
      danger: item.danger,
      error: item.error || '',
      filename: item.filename || '',
      totalBytes: item.totalBytes,
      bytesReceived: item.bytesReceived,
    };
  }

  async function appendAudit(event, extra = {}) {
    const stored = await chrome.storage.local.get(AUDIT_KEY);
    const audit = Array.isArray(stored[AUDIT_KEY]) ? stored[AUDIT_KEY] : [];
    audit.push({ time: now(), event, ...extra });
    await chrome.storage.local.set({ [AUDIT_KEY]: audit.slice(-100) });
  }

  async function acceptDanger(task, button) {
    button.disabled = true;
    const before = task.item?.danger || task.dangerLast || task.dangerInitial || 'unknown';
    try {
      await appendAudit('popup.acceptDanger-called', {
        taskId: task.taskId,
        downloadId: task.downloadId,
        dangerBefore: before,
      });
      statusBox.textContent = `已调用 acceptDanger(${task.downloadId})，等待 Chrome 原生确认…`;

      // 本调用必须直接发生在 Popup 的用户点击处理流程中。
      await chrome.downloads.acceptDanger(task.downloadId);
      const items = await chrome.downloads.search({ id: task.downloadId });
      await appendAudit('popup.acceptDanger-resolved', {
        taskId: task.taskId,
        downloadId: task.downloadId,
        item: itemView(items[0]),
      });
      statusBox.textContent = `acceptDanger Promise resolved：downloadId=${task.downloadId}\n请在 Chrome 原生提示中选择“保留/仍然下载”。`;
    } catch (error) {
      const message = error?.message || String(error);
      await appendAudit('popup.acceptDanger-rejected', {
        taskId: task.taskId,
        downloadId: task.downloadId,
        error: message,
      });
      statusBox.textContent = `acceptDanger Promise rejected：${message}`;
      button.disabled = false;
    }
    await load();
  }

  async function load() {
    const stored = await chrome.storage.local.get([STATE_KEY, AUDIT_KEY]);
    const state = stored[STATE_KEY] || { tasks: {} };
    const tasks = Object.values(state.tasks || {}).filter((task) =>
      task.state === 'awaiting_user_approval' && task.downloadId != null);
    tasksBox.replaceChildren();
    if (!tasks.length) {
      tasksBox.textContent = '当前没有 awaiting_user_approval 任务。';
    } else {
      for (const task of tasks) {
        const box = document.createElement('section');
        box.className = 'task';
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = [
          `manifestName：${task.manifestName || task.name || task.taskId}`,
          `requestedFilename：${task.requestedFilename || task.targetPath || ''}`,
          `actualFilename：${task.actualFilename || task.actualPath || ''}`,
          `downloadId：${task.downloadId}`,
          `danger：${task.item?.danger || task.dangerLast || task.dangerInitial || 'unknown'}`,
        ].join('\n');
        const button = document.createElement('button');
        button.textContent = '处理危险下载';
        button.addEventListener('click', () => acceptDanger(task, button));
        box.append(meta, button);
        tasksBox.append(box);
      }
    }
    const audit = Array.isArray(stored[AUDIT_KEY]) ? stored[AUDIT_KEY] : [];
    auditBox.textContent = audit.length ? JSON.stringify(audit.slice(-8), null, 2) : '';
  }

  load().catch((error) => {
    statusBox.textContent = `Popup 读取失败：${error?.message || String(error)}`;
  });
})();
