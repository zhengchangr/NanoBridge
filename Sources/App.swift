import SwiftUI
import AppKit
import UniformTypeIdentifiers
import CoreImage.CIFilterBuiltins
import AVFoundation

enum Stage: String {
    case waiting = "等待处理", downloading = "下载中", converting = "转换中", importing = "导入中"
    case ready = "等待导入", done = "已导入资料库", failed = "失败", cancelled = "已取消"
    var color: Color {
        switch self {
        case .done: return .green
        case .failed: return .red
        case .ready: return .orange
        default: return .secondary
        }
    }
}

struct QueueItem: Identifiable {
    let id = UUID()
    let title: String
    let subtitle: String
    var local: URL? = nil
    var song: Song? = nil
    var output: URL? = nil
    var stage = Stage.waiting
    var message = ""
}

@MainActor
final class BridgeModel: ObservableObject {
    @Published var items: [QueueItem] = []
    @Published var links = ""
    @Published var running = false
    @Published var resolving = false
    @Published var status = "把喜欢的音乐，带回口袋。"
    @Published var error: String?
    @Published var loggedIn = false
    @Published var accountStatus = "未登录 · 可尝试下载免费歌曲"
    @Published var qrImage: NSImage?
    @Published var loginMessage = "正在生成二维码…"
    @Published var bitrate = UserDefaults.standard.integer(forKey: "bitrate") == 0 ? 256 : UserDefaults.standard.integer(forKey: "bitrate") {
        didSet { UserDefaults.standard.set(bitrate, forKey: "bitrate") }
    }
    @Published var importMusic = UserDefaults.standard.object(forKey: "importMusic") as? Bool ?? true {
        didSet { UserDefaults.standard.set(importMusic, forKey: "importMusic") }
    }
    @Published var outputFolder: URL = {
        if let path = UserDefaults.standard.string(forKey: "outputFolder") { return URL(fileURLWithPath: path, isDirectory: true) }
        return FileManager.default.urls(for: .musicDirectory, in: .userDomainMask)[0].appendingPathComponent("NanoBridge", isDirectory: true)
    }() {
        didSet { UserDefaults.standard.set(outputFolder.path, forKey: "outputFolder") }
    }
    let api = NetEase()
    var task: Task<Void, Never>?
    var loginTask: Task<Void, Never>?
    let formats: Set<String> = ["ncm", "mp3", "flac", "m4a", "aac", "wav", "aiff", "aif", "alac"]

    init() {
        let token = Credential.load()
        loggedIn = !token.isEmpty
        if loggedIn { accountStatus = "已保存登录 · 下载时验证权限" }
        Task { await api.setToken(token) }
    }

    var pending: Int { items.filter { [.waiting, .failed, .cancelled, .ready].contains($0.stage) }.count }
    var completed: Int { items.filter { $0.stage == .done || $0.stage == .ready }.count }

    func chooseFiles() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.message = "选择网易云已下载文件，或包含音乐的文件夹"
        if panel.runModal() == .OK { addFiles(panel.urls) }
    }

    func addFiles(_ urls: [URL]) {
        guard !running, !resolving else { return }
        var files: [URL] = []
        for url in urls {
            let values = try? url.resourceValues(forKeys: [.isDirectoryKey])
            if values?.isDirectory == true {
                if let enumerator = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.isRegularFileKey], options: [.skipsHiddenFiles, .skipsPackageDescendants]) {
                    for case let child as URL in enumerator {
                        if (try? child.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true { files.append(child) }
                    }
                }
            } else { files.append(url) }
        }
        var known = Set(items.compactMap { $0.local?.standardizedFileURL.path })
        var count = 0
        for url in files.sorted(by: { $0.path < $1.path }) where formats.contains(url.pathExtension.lowercased()) {
            guard known.insert(url.standardizedFileURL.path).inserted else { continue }
            items.append(QueueItem(title: url.deletingPathExtension().lastPathComponent, subtitle: url.pathExtension.uppercased() + " · 本地文件", local: url))
            count += 1
        }
        status = count > 0 ? "已添加 \(count) 首音乐" : "没有新的支持文件；可添加 NCM、MP3、FLAC、M4A、WAV。"
    }

    func resolveLinks() {
        guard !running, !resolving, !links.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let input = links
        resolving = true
        status = "正在读取网易云歌曲信息…"
        Task {
            defer { resolving = false }
            var added = 0
            var failures: [String] = []
            for line in input.components(separatedBy: .newlines) where !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                do {
                    let songs = try await api.songs(MusicLink.parse(line))
                    guard !songs.isEmpty else { throw BridgeError("链接没有返回可读取的歌曲") }
                    var known = Set(items.compactMap { $0.song?.id })
                    for song in songs where known.insert(song.id).inserted {
                        items.append(QueueItem(title: song.title, subtitle: song.artist + " · 网易云", song: song))
                        added += 1
                    }
                } catch { failures.append(error.localizedDescription) }
            }
            if failures.isEmpty { links = "" } else { error = failures.joined(separator: "\n") }
            status = "已添加 \(added) 首音乐" + (failures.isEmpty ? "" : "，部分链接读取失败")
        }
    }

    func chooseOutput() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        if panel.runModal() == .OK, let url = panel.url { outputFolder = url }
    }

    func run() {
        guard !running, !resolving, pending > 0 else { return }
        running = true
        let shouldImport = importMusic
        let rate = bitrate
        let folder = outputFolder
        let ids = items.filter { [.waiting, .failed, .cancelled, .ready].contains($0.stage) }.map(\.id)
        task = Task {
            defer { running = false; task = nil }
            do { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
            catch { self.error = error.localizedDescription; return }
            for (number, id) in ids.enumerated() {
                if Task.isCancelled { break }
                guard let index = items.firstIndex(where: { $0.id == id }) else { continue }
                let item = items[index]
                status = "\(number + 1) / \(ids.count) · \(item.title)"
                items[index].message = ""
                do {
                    var result = item.output
                    if let existing = result, !FileManager.default.fileExists(atPath: existing.path) { result = nil }
                    if let existing = result, !existing.lastPathComponent.hasSuffix("-\(rate).m4a") { result = nil }
                    if result == nil {
                        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("NanoBridge-" + UUID().uuidString)
                        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
                        defer { try? FileManager.default.removeItem(at: temporary) }
                        let source: URL
                        let tags: Tags
                        if let song = item.song {
                            items[index].stage = .downloading
                            (source, tags) = try await api.download(song, into: temporary)
                        } else if let local = item.local {
                            items[index].stage = .converting
                            if local.pathExtension.lowercased() == "ncm" {
                                let worker = Task.detached { try NCM.decode(local, into: temporary) }
                                (source, tags) = try await withTaskCancellationHandler(operation: { try await worker.value }, onCancel: { worker.cancel() })
                            } else {
                                source = local
                                tags = try await Tags.load(local)
                            }
                        } else { throw BridgeError("找不到音乐来源") }
                        items[index].stage = .converting
                        let worker = Task.detached { () throws -> URL in
                            let hash = try Crypto.fingerprint(source)
                            let name = AAC.filename(tags.title) + "-" + hash.prefix(16) + "-\(rate).m4a"
                            return folder.appendingPathComponent(name)
                        }
                        let destination = try await withTaskCancellationHandler(operation: { try await worker.value }, onCancel: { worker.cancel() })
                        if !FileManager.default.fileExists(atPath: destination.path) {
                            let staging = temporary.appendingPathComponent("tagged.m4a")
                            let conversion = Task.detached { try await AAC.convert(source, tags: tags, destination: staging, bitrate: rate, temporary: temporary) }
                            try await withTaskCancellationHandler(operation: { try await conversion.value }, onCancel: { conversion.cancel() })
                            try Task.checkCancellation()
                            try FileManager.default.moveItem(at: staging, to: destination)
                        } else {
                            let asset = AVURLAsset(url: destination)
                            guard try await asset.load(.duration).seconds > 0 else { throw BridgeError("同名输出文件无效，请移走后重试") }
                        }
                        result = destination
                        items[index].output = destination
                    }
                    try Task.checkCancellation()
                    if shouldImport, let result {
                        items[index].stage = .importing
                        let importing = Task.detached { try MusicLibrary.add([result]) }
                        try await importing.value
                        items[index].stage = .done
                        items[index].message = "NanoBridge 播放列表 · 等待 Finder 同步至 iPod"
                    } else {
                        items[index].stage = .ready
                        items[index].message = "AAC 文件已保存，可开启导入后再次执行"
                    }
                } catch is CancellationError {
                    items[index].stage = .cancelled
                    items[index].message = "已保留原文件，可再次执行"
                    break
                } catch {
                    items[index].stage = Task.isCancelled ? .cancelled : .failed
                    items[index].message = error.localizedDescription
                }
            }
            let failed = items.filter { $0.stage == .failed }.count
            status = Task.isCancelled ? "已停止；已完成的文件仍然保留。" : "处理结束 · \(completed) 首已转换" + (failed > 0 ? " · \(failed) 首失败，可重试" : "")
        }
    }

    func beginLogin() {
        loginTask?.cancel()
        qrImage = nil
        loginMessage = "正在生成二维码…"
        loginTask = Task {
            do {
                let key = try await api.loginKey()
                try Task.checkCancellation()
                let filter = CIFilter.qrCodeGenerator()
                filter.message = Data("https://music.163.com/login?codekey=\(key)".utf8)
                filter.correctionLevel = "M"
                guard let image = filter.outputImage, let cg = CIContext().createCGImage(image.transformed(by: CGAffineTransform(scaleX: 8, y: 8)), from: image.extent.applying(CGAffineTransform(scaleX: 8, y: 8))) else { throw BridgeError("二维码生成失败") }
                qrImage = NSImage(cgImage: cg, size: NSSize(width: 240, height: 240))
                loginMessage = "使用网易云音乐 App 扫码登录"
                for _ in 0..<90 {
                    try await Task.sleep(for: .seconds(2))
                    let (code, token) = try await api.checkLogin(key)
                    try Task.checkCancellation()
                    switch code {
                    case 800: throw BridgeError("二维码已过期，请点击刷新")
                    case 802: loginMessage = "已扫码，请在手机上确认"
                    case 803:
                        guard let token, !token.isEmpty else { throw BridgeError("登录成功但没有取得凭证，请刷新重试") }
                        try Credential.save(token)
                        await api.setToken(token)
                        loggedIn = true
                        accountStatus = "已登录网易云"
                        loginMessage = "登录成功，可以关闭窗口"
                        return
                    default: break
                    }
                }
                loginMessage = "二维码已过期，请点击刷新"
            } catch is CancellationError { }
            catch { loginMessage = error.localizedDescription }
        }
    }

    func logout() {
        loginTask?.cancel()
        Credential.clear()
        loggedIn = false
        accountStatus = "未登录 · 可尝试下载免费歌曲"
        Task { await api.setToken("") }
    }
}

struct ContentView: View {
    @StateObject private var model = BridgeModel()
    @State private var showLogin = false
    @State private var showGuide = false
    private let accent = Color(red: 0.13, green: 0.43, blue: 0.37)

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Divider()
            VStack(alignment: .leading, spacing: 20) {
                header
                sourceCard
                queue
                footer
            }
            .padding(28)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 980, minHeight: 720)
        .background(Color(nsColor: .windowBackgroundColor))
        .tint(accent)
        .sheet(isPresented: $showLogin, onDismiss: { model.loginTask?.cancel() }) { login }
        .sheet(isPresented: $showGuide) { guide }
        .alert("处理提示", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("知道了") { model.error = nil }
        } message: { Text(model.error ?? "") }
        .dropDestination(for: URL.self) { urls, _ in
            guard !model.running, !model.resolving else { return false }
            model.addFiles(urls.filter(\.isFileURL))
            return true
        }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 7) {
                Image(systemName: "ipod").font(.system(size: 36, weight: .light)).foregroundStyle(accent)
                Text("NanoBridge").font(.system(size: 22, weight: .semibold, design: .rounded))
                Text("网易云 → iPod nano").font(.caption).foregroundStyle(.secondary)
            }
            Divider()
            VStack(alignment: .leading, spacing: 18) {
                Label("添加音乐", systemImage: "plus.circle")
                Label("解码 NCM", systemImage: "waveform")
                Label("转换为 AAC", systemImage: "arrow.trianglehead.2.clockwise.rotate.90")
                Label("导入音乐资料库", systemImage: "music.note.list")
                Label("Finder 同步至 iPod", systemImage: "cable.connector")
                    .foregroundStyle(.secondary)
            }.font(.system(size: 12))
            Spacer()
            VStack(alignment: .leading, spacing: 12) {
                Text("输出设置").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Picker("AAC", selection: $model.bitrate) {
                    Text("128 kbps").tag(128)
                    Text("192 kbps").tag(192)
                    Text("256 kbps").tag(256)
                }.pickerStyle(.menu)
                Text("AAC-LC · M4A\n44.1 kHz · 立体声").font(.caption).foregroundStyle(.secondary)
                Toggle("自动导入“音乐”", isOn: $model.importMusic).font(.caption)
                Button(action: model.chooseOutput) {
                    Label("更改输出文件夹", systemImage: "folder")
                }.buttonStyle(.link).font(.caption)
                Text(model.outputFolder.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                    .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(3).textSelection(.enabled)
            }.disabled(model.running || model.resolving)
            Divider()
            Button { showGuide = true } label: { Label("iPod 同步指南", systemImage: "questionmark.circle") }
                .buttonStyle(.plain).font(.caption)
            Text("0.1 · 为口袋里的音乐而做").font(.system(size: 10)).foregroundStyle(.tertiary)
        }
        .padding(24)
        .frame(width: 220, alignment: .leading)
        .background(accent.opacity(0.035))
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 6) {
                Text("让音乐，再次随身。")
                    .font(.system(size: 27, weight: .semibold, design: .rounded))
                Text("链接下载 / 本地导入 → NCM 解码 → AAC → 音乐资料库")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 6) {
                if model.loggedIn {
                    Menu { Button("退出登录", action: model.logout) } label: { Label("已登录", systemImage: "checkmark.seal") }
                        .disabled(model.running || model.resolving)
                } else {
                    Button { showLogin = true; model.beginLogin() } label: { Label("网易云登录", systemImage: "qrcode") }
                        .disabled(model.running || model.resolving)
                }
                Text(model.accountStatus).font(.system(size: 10)).foregroundStyle(.secondary)
            }
        }
    }

    private var sourceCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("从这里开始", systemImage: "music.note").font(.system(size: 13, weight: .semibold))
                Spacer()
                Button(action: model.chooseFiles) { Label("添加本地文件 / 文件夹", systemImage: "folder.badge.plus") }
            }
            HStack(alignment: .center, spacing: 12) {
                TextEditor(text: $model.links)
                    .font(.system(size: 12))
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .frame(height: 55)
                    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(alignment: .topLeading) {
                        if model.links.isEmpty {
                            Text("粘贴网易云歌曲或歌单链接，每行一条…")
                                .font(.system(size: 12)).foregroundStyle(.tertiary).padding(11).allowsHitTesting(false)
                        }
                    }
                    .accessibilityLabel("网易云歌曲或歌单链接")
                Button(action: model.resolveLinks) {
                    if model.resolving { ProgressView().controlSize(.small).frame(width: 68) }
                    else { Text("加入队列").frame(width: 68) }
                }.disabled(model.links.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.resolving)
            }
            Text("也可以把音乐拖进窗口。下载以账号权限为准；不把试听片段当作完整歌曲。")
                .font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .padding(16)
        .background(.background, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary))
        .disabled(model.running || model.resolving)
    }

    private var queue: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("音乐队列").font(.system(size: 13, weight: .semibold))
                Text("\(model.items.count)").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("清空队列") { model.items.removeAll(); model.status = "把喜欢的音乐，带回口袋。" }
                    .buttonStyle(.link).font(.caption).disabled(model.running || model.resolving || model.items.isEmpty)
            }
            if model.items.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "music.note.house").font(.system(size: 38, weight: .ultraLight)).foregroundStyle(accent.opacity(0.65))
                    Text("下一站，你的 iPod").font(.system(size: 17, weight: .medium, design: .rounded))
                    Text("添加链接，或拖入 NCM、FLAC、MP3 等音乐文件。")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(model.items.enumerated()), id: \.element.id) { index, item in
                            HStack(alignment: .top, spacing: 12) {
                                Text(String(format: "%02d", index + 1)).font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(.tertiary).frame(width: 24).padding(.top, 4)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(item.title).font(.system(size: 13, weight: .medium)).lineLimit(1)
                                    Text(item.subtitle).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                                    if !item.message.isEmpty {
                                        Text(item.message).font(.system(size: 11)).foregroundStyle(item.stage == .failed ? Color.red : .secondary)
                                            .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                                    }
                                }
                                Spacer(minLength: 4)
                                Text(item.stage.rawValue).font(.system(size: 11)).foregroundStyle(item.stage.color).padding(.top, 3)
                                if let output = item.output {
                                    Button { NSWorkspace.shared.activateFileViewerSelecting([output]) } label: { Image(systemName: "folder") }
                                        .buttonStyle(.plain).help("在 Finder 中显示输出文件")
                                }
                                if !model.running && !model.resolving {
                                    Button { model.items.removeAll { $0.id == item.id } } label: { Image(systemName: "xmark").font(.system(size: 10)) }
                                        .buttonStyle(.plain).foregroundStyle(.tertiary).help("移出队列，保留文件")
                                }
                            }.padding(.vertical, 13)
                            Divider()
                        }
                    }
                }
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider()
            HStack(spacing: 12) {
                if model.running { ProgressView().controlSize(.small) }
                Text(model.status).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
                Spacer()
                if model.running {
                    Button("停止") { model.task?.cancel(); model.status = "正在停止，当前转换完成后退出…" }
                } else {
                    Button(action: model.run) {
                        Label(model.importMusic ? "转换并导入音乐" : "转换为 AAC", systemImage: "play.fill")
                            .padding(.horizontal, 6).padding(.vertical, 3)
                    }.buttonStyle(.borderedProminent).disabled(model.pending == 0 || model.resolving)
                }
            }
            HStack {
                Label("iPod 最后一步：在 Finder 选择 NanoBridge 播放列表并同步。", systemImage: "info.circle")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
                Spacer()
                Button("查看步骤") { showGuide = true }.buttonStyle(.link).font(.system(size: 10))
            }
        }
    }

    private var login: some View {
        VStack(spacing: 18) {
            Text("登录网易云音乐").font(.title2.weight(.semibold))
            Text("使用手机扫码，凭证只保存在本机钥匙串。").font(.caption).foregroundStyle(.secondary)
            if let image = model.qrImage {
                Image(nsImage: image).interpolation(.none).resizable().scaledToFit().frame(width: 240, height: 240)
                    .padding(12).background(.white, in: RoundedRectangle(cornerRadius: 12))
            } else { ProgressView().frame(width: 264, height: 264) }
            Text(model.loginMessage).font(.callout).multilineTextAlignment(.center).frame(maxWidth: 360)
            HStack {
                Button("刷新二维码", action: model.beginLogin)
                Button("关闭") { showLogin = false }.keyboardShortcut(.cancelAction)
            }
        }.padding(32).frame(width: 440)
    }

    private var guide: some View {
        VStack(alignment: .leading, spacing: 20) {
            Label("把音乐同步到 iPod nano", systemImage: "ipod").font(.title2.weight(.semibold))
            Text("NanoBridge 自动完成下载、解码、转换和资料库导入。设备传输由 Finder 完成；软件不会显示未经验证的“已传输”。")
                .font(.callout).foregroundStyle(.secondary)
            ForEach(Array([
                "用数据线连接 iPod nano，在 Finder 侧边栏选择它。",
                "打开“音乐”页，选择同步所选播放列表，勾选 NanoBridge。",
                "点击“应用”或“同步”，等待 Finder 报告完成后弹出设备。"
            ].enumerated()), id: \.offset) { index, text in
                HStack(alignment: .top, spacing: 12) {
                    Text("\(index + 1)").font(.callout.weight(.semibold)).frame(width: 24, height: 24).background(accent.opacity(0.1), in: Circle())
                    Text(text).font(.callout).padding(.top, 3)
                }
            }
            Text("首次使用：如果 Finder 提示抹掉并同步，请先确认原资料库和备份；NanoBridge 不会代你确认此操作。")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("打开“音乐”") { NSWorkspace.shared.open(URL(fileURLWithPath: "/System/Applications/Music.app")) }
                Button("打开 Finder") { NSWorkspace.shared.open(URL(fileURLWithPath: "/Volumes")) }
                Spacer()
                Button("完成") { showGuide = false }.keyboardShortcut(.defaultAction)
            }
        }.padding(32).frame(width: 540)
    }
}

@main
struct NanoBridgeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    var body: some Scene {
        WindowGroup { ContentView() }
            .windowStyle(.hiddenTitleBar)
            .defaultSize(width: 1040, height: 760)
            .commands { CommandGroup(replacing: .newItem) {} }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
