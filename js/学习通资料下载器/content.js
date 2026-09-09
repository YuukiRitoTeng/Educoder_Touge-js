(function () {
  'use strict';

  // 页面原生下载触发器：只响应当前资料 iframe 的下载任务，不维护队列或持久化状态。
  if (window.top === window) return;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'cx-mv3-skeleton-trigger') return false;

    // 只由当前学习通资料 iframe 发起原生链接下载；不使用 fetch/XHR。
    const anchor = document.createElement('a');
    anchor.href = message.url;
    anchor.textContent = message.filename || message.url;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    sendResponse({
      ok: true,
      taskId: message.taskId,
      url: message.url,
      frameId: sender.frameId,
    });
    return false;
  });
})();
