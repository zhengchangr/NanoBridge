# TunesReloaded 直接写入 iPod 的原理

研究版本：`rish1p/tunesreloaded@66bc2af156ff64573f16147c9433b650e9dfcce2`。

## 结论

可以不依赖 Apple“音乐”App 或 Finder 的资料库同步。设备必须能以可写磁盘形式访问；程序同时写入音频文件和设备音乐数据库，iPod 才能在原厂播放器中显示新音乐。NanoBridge 当前的 MusicLibrary/AppleScript 路径是第一版实现的限制，并非 iPod 的技术限制。

## 代码路径

1. `modules/firewireSetup.js`：WebUSB 读取 USB product ID 和设备序列标识，确定型号、ModelNumStr、FirewireGuid；必要时准备 SysInfo / SysInfoExtended。浏览器的 USB 权限用于设备识别，实际音频写入走文件系统。
2. `modules/fsSync.js` 的 `syncIpodToVirtualFS`：把设备数据库、设备描述和必要的辅助数据库载入 Emscripten 的虚拟文件系统。
3. `ipod_manager.c` 的 `ipod_parse_db`：调用 `itdb_parse` 读取现有数据库。`ipod_add_track` 创建曲目，设置标题、歌手、专辑、时长、码率等，并加入设备主播放列表。
4. `modules/syncPipeline.js:58` 的 `uploadSingleTrack`：通过 libgpod 分配目标路径，调用 `fsSync.writeFileToIpodRelativePath` 流式写入设备，再完成数据库曲目的路径关联。数据库路径与实际文件路径必须一致。
5. `modules/syncPipeline.js:140` 的 `saveDatabase`：批量处理上传，调用 `ipod_write_db`，后者最终调用 `itdb_write`；随后 `fsSync.syncDbToIpod` 写回生成的数据库文件。
6. 新式数据库布局还要一致地写回 iTunesCDB 和 `iTunes Library.itlp` 内的辅助 SQLite 数据库。第 6/7 代 nano 另外使用 `hashAB.js` 重新签名；不能只写一个 iTunesDB。

## 用户设备：nano 第 1～5 代

项目 `firewireSetup.js` 的设备表将 nano 第 1/2 代标为不需要数据库校验设置，第 3/4/5 代标为需要 FirewireGuid；第 5 代还提供 SysInfoExtended 模板。因此“带转盘”仍不足以确定全部写入细节，应在连接后读取实际设备型号和数据库布局。

原生 Mac 版本可以采用同一个 libgpod 核心，直接访问挂载卷。WASM、WebUSB 和 File System Access API 是网页实现选择，并非协议要求。现有下载、NCM 解码和 AAC 转码可以保留，替换最后一段传输路径。

预期流水线：网易云下载或本地文件 → NCM 解码 → AAC/M4A → libgpod 添加曲目并复制音频 → 写回设备数据库。

## 接入时需要处理的具体问题

- 保留现有曲目和播放列表，写入前备份实际会修改的数据库；在临时目录准备数据库更新，并验证生成结果。
- 不直接照搬上游 `ipod_write_db` 的全部逻辑：它为了规避验证问题，会将现有智能播放列表的 `is_spl` 清零；这会改变用户已有列表的类型。
- 不能假定复制网页项目的 C 文件就能编译原生版本：其构建脚本依赖作者本机的 libgpod-wasm 静态库。当前 Homebrew 官方仓库也没有可直接安装的 `libgpod` formula，需要单独解决可复现的原生库构建和打包。
- 数据库写入成功、回读成功和实际设备能播放是不同验证层次。当前未连接 iPod，本次只完成原理和代码路径核对，未验证真实设备写入。

## 源码

- [项目说明](https://github.com/rish1p/tunesreloaded/blob/66bc2af156ff64573f16147c9433b650e9dfcce2/README.md)
- [上传及同步流水线](https://github.com/rish1p/tunesreloaded/blob/66bc2af156ff64573f16147c9433b650e9dfcce2/modules/syncPipeline.js#L58)
- [设备文件系统读写](https://github.com/rish1p/tunesreloaded/blob/66bc2af156ff64573f16147c9433b650e9dfcce2/modules/fsSync.js#L321)
- [libgpod 包装层](https://github.com/rish1p/tunesreloaded/blob/66bc2af156ff64573f16147c9433b650e9dfcce2/ipod_manager.c#L403)
- [设备识别及代际设置](https://github.com/rish1p/tunesreloaded/blob/66bc2af156ff64573f16147c9433b650e9dfcce2/modules/firewireSetup.js#L1)
