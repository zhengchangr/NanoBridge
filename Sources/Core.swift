import Foundation
import AVFoundation
import Security
import CryptoKit

struct BridgeError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

enum Crypto {
    static func aes(_ data: Data, key: String, decrypt: Bool = false) throws -> Data {
        let keyData = Data(key.utf8)
        guard keyData.count == 16, !data.isEmpty else { throw BridgeError("加密数据不完整") }
        var output = Data(count: data.count + 16)
        var count = 0
        let capacity = output.count
        let status = output.withUnsafeMutableBytes { out in
            data.withUnsafeBytes { input in
                keyData.withUnsafeBytes { keyBytes in
                    CCCrypt(CCOperation(decrypt ? kCCDecrypt : kCCEncrypt), CCAlgorithm(kCCAlgorithmAES),
                            CCOptions(kCCOptionECBMode | kCCOptionPKCS7Padding), keyBytes.baseAddress,
                            16, nil, input.baseAddress, data.count, out.baseAddress, capacity, &count)
                }
            }
        }
        guard status == kCCSuccess else { throw BridgeError("解码失败：文件损坏或不支持此格式（\(status)）") }
        output.count = count
        return output
    }

    static func md5(_ data: Data) -> String {
        // Required by NetEase's wire protocol; content deduplication uses SHA-256.
        Insecure.MD5.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func fingerprint(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var context = CC_SHA256_CTX()
        CC_SHA256_Init(&context)
        while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty {
            try Task.checkCancellation()
            _ = chunk.withUnsafeBytes { CC_SHA256_Update(&context, $0.baseAddress, CC_LONG(chunk.count)) }
        }
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        CC_SHA256_Final(&digest, &context)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

struct Tags {
    var title = ""
    var artist = ""
    var album = ""
    var artwork: Data? = nil

    static func load(_ url: URL) async throws -> Tags {
        var result = Tags(title: url.deletingPathExtension().lastPathComponent)
        for item in try await AVURLAsset(url: url).load(.commonMetadata) {
            switch item.commonKey {
            case .commonKeyTitle: result.title = (try? await item.load(.stringValue)) ?? result.title
            case .commonKeyArtist: result.artist = (try? await item.load(.stringValue)) ?? ""
            case .commonKeyAlbumName: result.album = (try? await item.load(.stringValue)) ?? ""
            case .commonKeyArtwork: result.artwork = try? await item.load(.dataValue)
            default: break
            }
        }
        return result
    }

    var items: [AVMetadataItem] {
        var items: [AVMetadataItem] = []
        for (key, value) in [(AVMetadataKey.commonKeyTitle, title), (.commonKeyArtist, artist), (.commonKeyAlbumName, album)] where !value.isEmpty {
            let item = AVMutableMetadataItem()
            item.keySpace = .common
            item.key = key as NSString
            item.value = value as NSString
            items.append(item)
        }
        if let artwork, !artwork.isEmpty {
            let item = AVMutableMetadataItem()
            item.keySpace = .common
            item.key = AVMetadataKey.commonKeyArtwork as NSString
            item.value = artwork as NSData
            items.append(item)
        }
        return items
    }
}

enum NCM {
    // NCM has a fixed 256-byte keystream; preserve phase across streaming reads.
    static func mask(key: Data) throws -> [UInt8] {
        guard !key.isEmpty else { throw BridgeError("NCM 音频密钥为空") }
        let bytes = [UInt8](key)
        var box = Array(0...255)
        var last = 0
        for i in 0..<256 {
            last = (box[i] + last + Int(bytes[i % bytes.count])) & 255
            box.swapAt(i, last)
        }
        return (0..<256).map { index in
            let j = (index + 1) & 255
            return UInt8(box[(box[j] + box[(box[j] + j) & 255]) & 255])
        }
    }

    static func decode(_ source: URL, into directory: URL) throws -> (URL, Tags) {
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        func read(_ count: Int) throws -> Data {
            guard count >= 0, count <= 32 * 1_048_576 else { throw BridgeError("NCM 数据块长度异常") }
            let data = try input.read(upToCount: count) ?? Data()
            guard data.count == count else { throw BridgeError("NCM 文件被截断") }
            return data
        }
        func uint() throws -> Int {
            let b = [UInt8](try read(4))
            return Int(b[0]) | Int(b[1]) << 8 | Int(b[2]) << 16 | Int(b[3]) << 24
        }
        guard try read(8) == Data("CTENFDAM".utf8) else { throw BridgeError("不是有效的 NCM 文件") }
        _ = try read(2)
        let encryptedKey = try read(uint()).map { $0 ^ 0x64 }
        let decodedKey = try Crypto.aes(Data(encryptedKey), key: "hzHRAmso5kInbaxW", decrypt: true)
        guard decodedKey.starts(with: Data("neteasecloudmusic".utf8)), decodedKey.count > 17 else {
            throw BridgeError("NCM 密钥格式不支持")
        }
        let stream = try mask(key: Data(decodedKey.dropFirst(17)))
        let metadata = try read(uint())
        var tags = Tags(title: source.deletingPathExtension().lastPathComponent)
        if !metadata.isEmpty {
            let clear = Data(metadata.map { $0 ^ 0x63 })
            guard clear.count > 22, let base64 = String(data: clear.dropFirst(22), encoding: .utf8),
                  let encrypted = Data(base64Encoded: base64) else { throw BridgeError("NCM 标签数据损坏") }
            let json = try Crypto.aes(encrypted, key: "#14ljk_!\\]&0U<'(", decrypt: true)
            guard json.starts(with: Data("music:".utf8)),
                  let object = try JSONSerialization.jsonObject(with: json.dropFirst(6)) as? [String: Any] else {
                throw BridgeError("NCM 标签格式不支持")
            }
            tags.title = object["musicName"] as? String ?? tags.title
            tags.album = object["album"] as? String ?? ""
            tags.artist = (object["artist"] as? [[Any]] ?? []).compactMap { $0.first as? String }.joined(separator: " / ")
        }
        _ = try read(5) // CRC32 and image version.
        let coverFrame = try uint()
        let coverLength = try uint()
        guard coverLength <= coverFrame, coverFrame <= 32 * 1_048_576 else { throw BridgeError("NCM 封面长度异常") }
        let cover = try read(coverLength)
        if !cover.isEmpty { tags.artwork = cover }
        _ = try read(coverFrame - coverLength)
        var first = true
        var offset = 0
        var destination: URL?
        var output: FileHandle?
        defer { try? output?.close() }
        while let chunk = try input.read(upToCount: 65_536), !chunk.isEmpty {
            try Task.checkCancellation()
            var bytes = [UInt8](chunk)
            for i in bytes.indices { bytes[i] ^= stream[(offset + i) & 255] }
            offset += bytes.count
            if first {
                let isFLAC = bytes.starts(with: Array("fLaC".utf8))
                let isMP3 = bytes.starts(with: Array("ID3".utf8)) || (bytes.count >= 2 && bytes[0] == 255 && bytes[1] & 0xE0 == 0xE0)
                guard isFLAC || isMP3 else { throw BridgeError("NCM 内部音频不是支持的 MP3 / FLAC") }
                let url = directory.appendingPathComponent("decoded.\(isFLAC ? "flac" : "mp3")")
                guard FileManager.default.createFile(atPath: url.path, contents: nil) else { throw BridgeError("无法创建解码文件") }
                output = try FileHandle(forWritingTo: url)
                destination = url
                first = false
            }
            try output?.write(contentsOf: Data(bytes))
        }
        guard let destination else { throw BridgeError("NCM 没有音频内容") }
        return (destination, tags)
    }
}

enum AAC {
    static func convert(_ source: URL, tags: Tags, destination: URL, bitrate: Int, temporary: URL) async throws {
        try Task.checkCancellation()
        let encoded = temporary.appendingPathComponent("encoded.m4a")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/afconvert")
        process.arguments = [source.path, encoded.path, "-f", "m4af", "-d", "aac@44100", "-c", "2", "-b", String(bitrate * 1000), "-q", "127", "-s", "0"]
        let pipe = Pipe()
        process.standardError = pipe
        process.standardOutput = FileHandle.nullDevice
        try process.run()
        let diagnostic = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        try Task.checkCancellation()
        guard process.terminationStatus == 0 else {
            throw BridgeError("AAC 转换失败：\(String(data: diagnostic, encoding: .utf8) ?? "无法读取此音频格式")")
        }
        guard let session = AVAssetExportSession(asset: AVURLAsset(url: encoded), presetName: AVAssetExportPresetPassthrough) else {
            throw BridgeError("无法创建音频标签写入器")
        }
        session.metadata = tags.items
        try await session.export(to: destination, as: .m4a)
        try Task.checkCancellation()
        let asset = AVURLAsset(url: destination)
        guard try await asset.load(.duration).seconds > 0,
              !(try await asset.loadTracks(withMediaType: .audio)).isEmpty else {
            throw BridgeError("输出音频校验失败")
        }
    }

    static func filename(_ title: String) -> String {
        let forbidden = CharacterSet(charactersIn: "/:\0\n\r").union(.controlCharacters)
        let clean = title.components(separatedBy: forbidden).joined(separator: "_").trimmingCharacters(in: .whitespacesAndNewlines)
        return String((clean.isEmpty ? "Untitled" : clean).prefix(80))
    }
}

struct Song: Identifiable {
    let id: Int64
    let title: String
    let artist: String
    let album: String
    let cover: URL?
}

struct MusicLink: Equatable {
    let kind: String
    let id: Int64
    static func parse(_ text: String) throws -> MusicLink {
        let detector = try NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        let candidates = detector.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap(\.url)
        for url in candidates {
            guard ["music.163.com", "y.music.163.com"].contains(url.host?.lowercased() ?? "") else { continue }
            let route: URLComponents?
            if let fragment = url.fragment, fragment.hasPrefix("/") {
                route = URLComponents(string: "https://music.163.com" + fragment)
            } else { route = URLComponents(url: url, resolvingAgainstBaseURL: false) }
            guard let route else { continue }
            let path = route.path
            let kind = path.contains("playlist") ? "playlist" : (path.contains("song") ? "song" : "")
            var idText = route.queryItems?.first(where: { $0.name == "id" })?.value
            if idText == nil, let last = path.split(separator: "/").last { idText = String(last) }
            if !kind.isEmpty, let idText, let id = Int64(idText), id > 0 { return MusicLink(kind: kind, id: id) }
        }
        throw BridgeError("请粘贴网易云的完整歌曲或歌单链接（music.163.com）；短链接请先在浏览器打开后复制完整地址。")
    }
}

enum Credential {
    static let service = "local.caoyun.nanobridge.netease"
    static var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "MUSIC_U"] }
    static func load() -> String {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &value) == errSecSuccess, let data = value as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }
    static func save(_ token: String) throws {
        let data = Data(token.utf8)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var q = query
            q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw BridgeError("登录凭证无法保存到钥匙串") }
        } else if status != errSecSuccess { throw BridgeError("无法更新钥匙串凭证（\(status)）") }
    }
    static func clear() { SecItemDelete(query as CFDictionary) }
}

actor NetEase {
    var token = ""
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 600
        config.httpShouldSetCookies = false
        return URLSession(configuration: config)
    }()
    func setToken(_ token: String) { self.token = token }

    func request(_ path: String, _ parameters: [String: Any]) async throws -> ([String: Any], HTTPURLResponse) {
        var header = ["os": "osx", "appver": "3.1.10.5100", "osver": "15.5", "deviceId": "nanobridge-desktop", "requestId": String(Int64(Date().timeIntervalSince1970 * 1000)), "__csrf": ""]
        if !token.isEmpty { header["MUSIC_U"] = token }
        var body = parameters
        body["header"] = header
        body["e_r"] = false
        let jsonData = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .withoutEscapingSlashes])
        let json = String(decoding: jsonData, as: UTF8.self)
        let hash = Crypto.md5(Data("nobody\(path)use\(json)md5forencrypt".utf8))
        let payload = Data("\(path)-36cd479b6b5-\(json)-36cd479b6b5-\(hash)".utf8)
        let encrypted = try Crypto.aes(payload, key: "e82ckenh8dichen8").map { String(format: "%02X", $0) }.joined()
        let url = URL(string: "https://interface.music.163.com/eapi/" + path.dropFirst(5))!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.httpBody = Data("params=\(encrypted)".utf8)
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.setValue("https://music.163.com/", forHTTPHeaderField: "Referer")
        req.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36", forHTTPHeaderField: "User-Agent")
        req.setValue(header.map { "\($0.key)=\($0.value)" }.joined(separator: "; "), forHTTPHeaderField: "Cookie")
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { throw BridgeError("网易云网络请求失败") }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw BridgeError("网易云返回了无法识别的数据，请稍后重试")
        }
        let code = object["code"] as? Int ?? 200
        guard code == 200 || (800...803).contains(code) else {
            throw BridgeError("网易云：\(object["message"] as? String ?? object["msg"] as? String ?? "请求失败")（\(code)）")
        }
        return (object, http)
    }

    func loginKey() async throws -> String {
        let (body, _) = try await request("/api/login/qrcode/unikey", ["type": 3])
        guard let key = body["unikey"] as? String else { throw BridgeError("未取得登录二维码，请稍后重试") }
        return key
    }

    func checkLogin(_ key: String) async throws -> (Int, String?) {
        let (body, response) = try await request("/api/login/qrcode/client/login", ["key": key, "type": 3])
        let fields = response.allHeaderFields.reduce(into: [String: String]()) { $0[String(describing: $1.key)] = String(describing: $1.value) }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: fields, for: response.url!)
        let credential = cookies.first(where: { $0.name == "MUSIC_U" })?.value
        return (body["code"] as? Int ?? 0, credential)
    }

    func details(_ ids: [Int64]) async throws -> [Song] {
        guard !ids.isEmpty else { return [] }
        let c = "[" + ids.map { "{\"id\":\($0)}" }.joined(separator: ",") + "]"
        let (body, _) = try await request("/api/v3/song/detail", ["c": c])
        guard let songs = body["songs"] as? [[String: Any]] else { throw BridgeError("无法读取歌曲信息") }
        let result = songs.compactMap { item -> Song? in
            guard let id = (item["id"] as? NSNumber)?.int64Value, let title = item["name"] as? String else { return nil }
            let album = item["al"] as? [String: Any] ?? [:]
            let artists = (item["ar"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }.joined(separator: " / ")
            return Song(id: id, title: title, artist: artists, album: album["name"] as? String ?? "", cover: (album["picUrl"] as? String).flatMap(URL.init(string:)))
        }
        let lookup = Dictionary(result.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return ids.compactMap { lookup[$0] }
    }

    func songs(_ link: MusicLink) async throws -> [Song] {
        if link.kind == "song" { return try await details([link.id]) }
        let (body, _) = try await request("/api/v6/playlist/detail", ["id": String(link.id), "n": 100000, "s": 0])
        guard let playlist = body["playlist"] as? [String: Any], let tracks = playlist["trackIds"] as? [[String: Any]] else {
            throw BridgeError("无法读取歌单；私密歌单需要先登录")
        }
        let ids = tracks.compactMap { ($0["id"] as? NSNumber)?.int64Value }
        guard !ids.isEmpty else { throw BridgeError("歌单为空或当前账号没有访问权限") }
        var result: [Song] = []
        for start in stride(from: 0, to: ids.count, by: 200) {
            try Task.checkCancellation()
            result += try await details(Array(ids[start..<min(start + 200, ids.count)]))
        }
        return result
    }

    static func downloadURL(_ body: [String: Any]) throws -> URL {
        guard let item = body["data"] as? [String: Any],
              (item["code"] as? Int ?? 200) == 200,
              (item["freeTrialInfo"] == nil || item["freeTrialInfo"] is NSNull),
              let text = item["url"] as? String, !text.isEmpty,
              var components = URLComponents(string: text), let host = components.host,
              ["music.126.net", "music.163.com"].contains(where: { host == $0 || host.hasSuffix("." + $0) }),
              ["http", "https"].contains(components.scheme ?? "") else {
            throw BridgeError("此歌曲没有可下载的完整音源，请检查账号权限或使用客户端已下载文件")
        }
        components.scheme = "https"
        guard let url = components.url else { throw BridgeError("下载地址无效") }
        return url
    }

    func download(_ song: Song, into directory: URL) async throws -> (URL, Tags) {
        let (body, _) = try await request("/api/song/enhance/download/url/v1", ["id": String(song.id), "level": "exhigh", "immerseType": "c51"])
        let url = try Self.downloadURL(body)
        // Separate media request: never attach account credentials to CDN downloads.
        let (file, response) = try await session.download(from: url)
        defer { try? FileManager.default.removeItem(at: file) }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw BridgeError("歌曲音频下载失败") }
        let data = body["data"] as? [String: Any] ?? [:]
        if let size = (data["size"] as? NSNumber)?.int64Value, size > 0 {
            let actual = (try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.int64Value ?? 0
            guard actual == size else { throw BridgeError("下载文件大小不符，请重试") }
        }
        let ext = data["type"] as? String ?? "mp3"
        guard ["mp3", "flac", "m4a", "aac"].contains(ext.lowercased()) else { throw BridgeError("下载音频格式暂不支持：\(ext)") }
        let target = directory.appendingPathComponent("download.\(ext.lowercased())")
        try FileManager.default.moveItem(at: file, to: target)
        var tags = Tags(title: song.title, artist: song.artist, album: song.album)
        if let cover = song.cover, let host = cover.host, host.hasSuffix(".music.126.net") {
            var parts = URLComponents(url: cover, resolvingAgainstBaseURL: false)!
            parts.scheme = "https"
            parts.query = "param=600y600"
            if let coverURL = parts.url, let (bytes, response) = try? await session.data(from: coverURL),
               (response as? HTTPURLResponse)?.statusCode == 200, bytes.count < 8 * 1_048_576 {
                tags.artwork = bytes
            }
        }
        return (target, tags)
    }
}

enum MusicLibrary {
    // Paths are argv values, never interpolated into AppleScript source.
    static let script = """
    on run argv
        tell application "Music"
            if not (exists user playlist "NanoBridge") then
                make new user playlist with properties {name:"NanoBridge"}
            end if
            set targetList to user playlist "NanoBridge"
            repeat with filePath in argv
                set mediaFile to POSIX file (contents of filePath) as alias
                set matchedTracks to (every file track of targetList whose location is mediaFile)
                if (count of matchedTracks) is 0 then
                    set libraryMatches to (every file track of library playlist 1 whose location is mediaFile)
                    if (count of libraryMatches) > 0 then
                        duplicate (item 1 of libraryMatches) to targetList
                    else
                        add mediaFile to targetList
                    end if
                end if
            end repeat
        end tell
    end run
    """

    static func add(_ files: [URL]) throws {
        guard !files.isEmpty else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script] + files.map(\.path)
        let pipe = Pipe()
        process.standardError = pipe
        process.standardOutput = FileHandle.nullDevice
        try process.run()
        let diagnostic = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw BridgeError("文件已转换，但导入“音乐”失败。请在系统设置 → 隐私与安全性 → 自动化中允许 NanoBridge 控制“音乐”。\n\(String(data: diagnostic, encoding: .utf8) ?? "")")
        }
    }
}
