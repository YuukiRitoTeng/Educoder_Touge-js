# 学习通资料归档助手 v0.4.0

用于学习通新版“资料”页面的课程资料扫描与归档。当前版本保持已验证的页面原生下载链、持久化 Queue、并发 2 和 Chrome 原生安全确认流程。

## 适用范围

- 学习通新版资料页：`https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu...`
- 需要在已经登录的 Chrome Profile 中运行。

## 安装

1. 打开 Chrome `chrome://extensions/`。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展”，选中本目录。
4. 以后扩展更新文件后，在扩展管理页点击“重新加载”，再刷新学习通资料页。

## 基本流程

1. 打开课程的“资料”页面。
2. 点击“扫描全部资料”，等待目录扫描完成。
3. 点击“下载全部”。
4. 扩展通过页面原生下载入口调度 Chrome 下载，并按课程逻辑目录保存到 Chrome Downloads 下的相对路径。

## 使用提示

- Chrome 必须允许 `https://mooc2-ans.chaoxing.com` 自动下载多个文件，否则批量任务可能被浏览器拦截。
- 遇到危险下载时，主面板的“处理安全确认”会打开扩展 Action Popup；在 Popup 中点击处理后，再按 Chrome 原生提示选择保留/继续下载。
- 默认保存到 Chrome Downloads 目录下的相对目录，不支持选择任意磁盘目录。
- 任务状态和下载映射保存在 `chrome.storage.local`，可在 Service Worker 休眠/恢复后继续读取。

## 已知限制

- Safe Browsing 的最终判断由 Chrome 决定，扩展不会绕过或弱化安全策略。
- `tch-courseware` 特殊行暂不处理。
- 不支持任意磁盘目录。
- 不使用 aria2 或本地后端服务。
- 不做特殊视频解析。
- Windows/Chrome 可能规范化部分文件名；课程逻辑路径、请求保存路径和最终磁盘路径在状态中分别记录。

## 回退

`stable-v0.4.0` 是本版本冻结副本。需要回退时，在 `chrome://extensions/` 中移除当前开发者加载的目录后，重新加载该备份目录即可。历史 `pre-*` 目录保持不变。
