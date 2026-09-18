# Reader Sync 社区增强版

让本地剧集视频与 `aim-read.top` 阅读页自动对齐、双向跟随，并把媒体库、预处理、进度记忆和训练计划放进同一套浏览器工作流。

> 本仓库是基于 [生🐟 的 Reader Sync](https://github.com/LCYLYM/lqreadervideosync) 继续开发的社区版本，不是原作者发布的官方新版本。原始项目与署名均予以保留。

## 当前版本

- 扩展版本：`2.1.1.11`
- 浏览器：Chrome / Chromium 120+
- 目标站点：`https://aim-read.top/*`
- 发布状态：社区测试版

## 这次二开增加了什么

- 单页播放界面：页面识别、字幕匹配和媒体准备改为后台自动完成。
- Reader 稳定识别：定时重扫并跟随 Reader 切换剧集。
- 本地媒体库：选择一次总目录，自动识别双语、纯英、无字幕版本。
- 预处理与缓存：提前把浏览器不兼容的视频或音轨转换成可播放版本。
- 英文字幕版支持：兼容 MPEG-4 Part 2 + AAC 等素材。
- 音频切换修复：双语、无字幕 MKV 的 AC3 音轨会转换为 AAC，避免音量键变灰。
- 进度记忆：按剧集、版本和训练遍次分别保存播放位置。
- 训练计划：内置六遍、四遍和自定义方案，支持完成、撤销、重开与整季总览。
- 日志导出：便于社区反馈和定位问题。

完整变更见 [`docs/release-notes`](docs/release-notes)。

## 安装

1. 从 Releases 下载 `Reader-Sync-2.1.1.11.zip`。
2. 解压 ZIP，确认所选文件夹内直接存在 `manifest.json`。
3. 打开 `chrome://extensions`。
4. 开启“开发者模式”。
5. 点击“加载已解压的扩展程序”，选择刚才解压的整个文件夹。
6. 关闭其他 Reader Sync 版本，避免多个扩展同时响应。

## 使用

1. 在浏览器中登录并打开对应的 Reader 剧集页面。
2. 打开扩展，选择本地剧集总目录。
3. 选择默认视频版本；需要时启用预处理。
4. 播放视频。Reader 台本会跟随时间滚动，点击台本也可以反向跳转视频。
5. 如需训练计划，在播放器的训练卡片中选择六遍、四遍或自定义方案。

视频、目录索引、训练记录和播放书签只保存在本机浏览器中，不会上传到本仓库。

## 权限说明

- `storage`：保存本机设置、索引、训练记录和播放进度。
- `tabs` / `activeTab`：发现并连接用户已打开的 Reader 页面。
- `downloads`：导出诊断日志。
- 站点访问权限：与 `aim-read.top` 页面通信，并支持本地开发与兼容处理。

## 开发与验证

```bash
npm install
npm run check
npm run test:community
npm run build:community
```

仓库中的 `src/` 保留上游 TypeScript 工程；当前社区补丁以可读 JavaScript 形式保存在 `community-src/`，`npm run build:community` 会生成可安装的 `dist/`。后续维护应逐步把补丁回填到 TypeScript 源码。

本次回归测试位于 `tests/`，其中 MP4、MKV 探测脚本需要传入本机媒体文件路径。

## 反馈问题

提交 Issue 时请附上：

- 浏览器版本和扩展版本；
- 剧集编号与所选字幕版本；
- 可稳定复现的操作步骤；
- 插件导出的日志 ZIP；
- 不要上传视频、账号信息、Cookie、访问令牌或其他私密内容。

## 许可证与转载边界

上游代码采用 [PolyForm Noncommercial 1.0.0](LICENSE.md)，因此本仓库及其衍生版本只用于个人学习、研究、测试和其他许可证允许的非商业用途。不得把本项目或衍生版本直接用于收费产品、商业服务或其他商业场景；如有商业需求，应先向原作者取得单独授权。

二开、转载或再次分发时，必须：

1. 保留根目录的 `LICENSE.md`；
2. 保留原作者 Required Notice；
3. 明确标注原项目链接和本版本的修改范围；
4. 不把原作者、社区贡献者或第三方资源说成自己的原创；
5. 同时遵守 FFmpeg、ffmpeg.wasm 及字幕文件各自适用的许可或授权。

第三方组件和资源说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。这份说明是发布整理，不构成法律意见；对商业使用或字幕再分发有疑问时，应先向权利人确认。

## 致谢

- 原项目与第一版作者：[生🐟 / LCYLYM](https://github.com/LCYLYM/lqreadervideosync)
- 阅读环境：`aim-read.top`
- 媒体兼容组件：`ffmpeg.wasm` 与 FFmpeg
- 所有参与测试、反馈和复现问题的社区伙伴
