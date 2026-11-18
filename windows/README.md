# NanoBridge · Windows

Windows 10 / 11 64 位免安装版。解压整个文件夹后双击 `NanoBridge.exe`，请保留同目录的 `resources` 和其他运行文件；单独复制 EXE 无法运行。不需要安装 Node、Python、网易云客户端或 Apple“音乐”App。内置 FFmpeg。

## 使用

1. 在线：点击“网易云登录”，用手机 App 扫码。粘贴完整歌曲或歌单链接，每行一条，点击“加入队列”。支持 `music.163.com` / `y.music.163.com` 常见完整链接；短链接先在浏览器打开再复制完整地址。
2. 本地：选择文件或文件夹，或将文件拖入窗口。支持 NCM、MP3、FLAC、M4A、AAC、WAV、AIFF。
3. 点击“转换为 AAC”。默认 AAC-LC / M4A、256 kbps、44.1 kHz、立体声；也可选 128 / 192 kbps。输出默认放在 Windows“音乐”文件夹下的 `NanoBridge` 子文件夹。
4. 点击“打开 iPod 导入工具”，在 Chrome / Edge 使用 TunesReloaded 将输出的 M4A 文件导入 iPod。应用内有具体步骤。

NCM 标签和封面在转换时写入 M4A；本地普通音频由 FFmpeg 读取和保留原标签及嵌入封面。AAC 有损转码不会提高原音质。源文件始终保留。

## 当前范围

- 已实现：链接/歌单解析、扫码登录、按账号权限下载完整音源、本地 NCM 解码、AAC 转换、任务队列、停止/失败重试、内容去重、输出文件定位。
- **未内置 iPod 数据库直接写入。**“已转换”表示音频文件已保存，不代表已传到 iPod。设备导入通过 TunesReloaded 完成。
- 完整下载取决于会员、地区和单曲权限。没有下载地址或标记为试听时明确失败，不用试听地址冒充完整下载。网易云上游接口变动可能影响在线功能。
- 登录凭证通过 Electron safeStorage 使用 Windows 系统加密；加密服务不可用时只在内存保留本次登录。凭证不会发送给转码工具、音频 CDN 或 TunesReloaded。
- 设置和加密登录文件位于 `%APPDATA%\NanoBridge`。队列不跨重启保存。清空队列不删除文件。
- 免安装包尚未购买代码签名证书。此版本在 Mac 上交叉打包；解码/转码核心已在构建机检查，Windows 原生界面、系统凭证存储和真实 iPod 传输仍需实机验证。

## 开发和重建

需要 Node.js 22.12+、npm，以及系统 `curl`（macOS 和新版 Windows 10/11 自带）：

```sh
npm ci
npm test
npm run test:live
npm start
npm run package:win
```

`package:win` 在 Mac 或 Windows 上下载官方 Electron Windows x64 发行包并核对 npm 包携带的 SHA-256，然后打包应用、图标、FFmpeg 和第三方声明。输出到 `dist`。首次打包需要联网。

本地检查使用由独立 Python/OpenSSL 编码器生成的合成 NCM，验证解码字节、中文标签、封面、坏文件、Windows 文件名、链接权限、实际 AAC 编码、输出时长和后台任务流程。

本次构建已通过上述检查；同一界面在 Mac 的 Electron 环境中实际完成“选择 NCM → 转换为 AAC”。Windows x64 的 FFmpeg 二进制已在兼容环境启动检查。最终 ZIP 已检查压缩数据完整性；这不替代 Windows 实机验收。

Electron 和 npm 依赖版本由 `package-lock.json` 固定；FFmpeg 6.1.1 的构建来源和许可证随包放在 `third-party-notices`，对应源代码地址可见该目录的说明。
