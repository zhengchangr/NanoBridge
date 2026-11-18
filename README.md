# NanoBridge

Windows 10/11 64 位版位于 [`windows`](windows/README.md)。在该目录运行 `npm run package:win` 可生成包含 `NanoBridge.exe` 和转码工具的免安装压缩包；Windows 版通过 TunesReloaded 入口导入 iPod，不依赖 Apple“音乐”App。

给 macOS 和 iPod nano 做的本地音乐准备工具。原生 SwiftUI 应用，不需要安装 Python、Node、FFmpeg 或其他运行时。

当前版本完成：网易云歌曲/歌单链接读取、扫码登录、按账号权限下载、NCM 解码、AAC 转换，以及添加至“音乐”App 的 `NanoBridge` 播放列表。**当前实现的最后一步仍需在 Finder 中同步，尚未实现全程一键传输。这是本版实现的限制；通过 libgpod 直接维护设备数据库可以移除“音乐”和 Finder 同步的依赖，见[原理分析](docs/direct-ipod-sync.md)。**

## 打开

本机已构建的应用：`build/NanoBridge.app`，双击运行。

重新构建需要 Xcode 或 Command Line Tools：

```sh
zsh build.sh
open build/NanoBridge.app
```

支持 macOS 15 及以上；生成与构建机器架构一致的应用，本机为 Apple Silicon。应用使用本机临时签名，尚未公证或打包分发。

## 使用

1. 在线音乐：点击“网易云登录”，在手机网易云 App 中扫码。将完整的歌曲或歌单链接粘贴进输入框，每行一条，点击“加入队列”。支持 `music.163.com`、`y.music.163.com` 的常见链接；短链接请先在浏览器打开，再复制完整地址。
2. 本地音乐：选择文件/文件夹，或拖入窗口。支持 NCM、MP3、FLAC、M4A、AAC、WAV、AIFF。添加文件夹时递归读取支持的音频，跳过隐藏文件和软件包。
3. 点击“转换并导入音乐”。默认输出 AAC-LC / M4A、256 kbps、44.1 kHz、立体声，可改为 128 或 192 kbps。保留标题、歌手、专辑和封面。输出默认位于 `~/Music/NanoBridge`。
4. 首次导入时，macOS 可能询问是否允许控制“音乐”，请允许。关闭“自动导入”可只生成音频文件。
5. 用数据线连接 iPod nano，在 Finder 选择设备 → 音乐 → 同步所选播放列表 → 勾选 `NanoBridge` → 应用/同步。等待 Finder 完成后弹出设备。

如果设备与其他资料库关联，Finder 可能提示“抹掉并同步”，请先确认备份。应用不会确认此提示，也不直接改写 iPod 数据库。

## 行为和限制

- 下载使用网易云返回的完整下载地址；没有下载权限、空地址或标记为试听时明确失败，不自动改用试听链接。会员、地区和单曲购买权限由账号决定。在线下载请求最高使用 `exhigh`，随后转换为所选 AAC 码率。
- 网易云接口不是本项目控制的稳定服务，上游变动可能导致在线功能失效。登录凭证仅存入 macOS 钥匙串，音频 CDN 请求不携带登录凭证，没有外部 API 中转服务。
- NCM 只支持内部音频为 MP3 / FLAC 的常见格式，不支持其他平台加密文件或所有可能的网易云格式变种。
- AAC 是有损格式；将有损音源重新转换不会提高音质。
- 保留源文件。任务临时文件在结束时清理。内容指纹和码率用于复用同名输出，避免重复转码；“音乐”导入按路径检查是否已经在目标播放列表中。
- 清空/移出队列不删除任何源文件或输出文件。队列不跨应用重启保存；登录状态和输出设置会保存。
- 停止会取消网络请求，在当前系统转码/资料库导入结束后退出，不强制中断正在写入的文件。
- 现代“音乐”App 的脚本字典没有 iPod 同步命令，因此本版将同步交给 Finder；未连接设备时不会声称已传输至 iPod。

## 验证

```sh
zsh check.sh          # 使用合成音频，无需账号
zsh check.sh --live   # 访问网易云实际接口，不读取钥匙串凭证
```

本地检查使用独立 Python/OpenSSL 编码器生成 NCM 测试文件，再验证解码音频逐字节一致、损坏输入拒绝、链接解析、试听/无权限下载拒绝、AAC 编码参数和时长，以及中文标签和封面保留；另外检查导入 AppleScript 的编译。

真实接口已验证二维码生成/轮询、歌曲详情和下载接口返回。测试歌曲需要账号下载权限，因此**登录后完整下载、真实“音乐”资料库导入、iPod nano 硬件同步尚未完成端到端验证**。

## 参考

- [网易云接口协议及端点参考](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)
- [NCM 格式参考](https://github.com/taurusxin/ncmdump)
- [Apple：与电脑同步 iPod](https://support.apple.com/en-ie/108311)

代码独立使用系统 CommonCrypto、CryptoKit、AVFoundation 和 `afconvert` 实现，不捆绑上述第三方项目。
