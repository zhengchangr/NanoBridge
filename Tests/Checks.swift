import Foundation
import AVFoundation

func check(_ condition: Bool, _ message: String) throws {
    if !condition { throw BridgeError("CHECK FAILED: " + message) }
}

@main
struct Checks {
    static func main() async {
        do { try await run() }
        catch { fputs("FAIL: \(error.localizedDescription)\n", stderr); exit(1) }
    }
    static func run() async throws {
        if CommandLine.arguments.contains("--live") {
            let api = NetEase()
            let key = try await api.loginKey()
            try check(!key.isEmpty, "live QR key")
            let songs = try await api.details([347230])
            try check(songs.count == 1 && !songs[0].title.isEmpty, "live song metadata")
            let (code, _) = try await api.checkLogin(key)
            try check([801, 802].contains(code), "live QR polling")
            let (body, _) = try await api.request("/api/song/enhance/download/url/v1", ["id": "347230", "level": "exhigh", "immerseType": "c51"])
            if let url = try? NetEase.downloadURL(body) {
                try check(url.scheme == "https", "HTTPS download")
                let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                defer { try? FileManager.default.removeItem(at: folder) }
                let (file, tags) = try await api.download(songs[0], into: folder)
                try check(FileManager.default.fileExists(atPath: file.path) && !tags.title.isEmpty, "live download")
                try await AAC.convert(file, tags: tags, destination: folder.appendingPathComponent("live.m4a"), bitrate: 256, temporary: folder)
                print("PASS: real QR creation/polling, song metadata, full audio download, AAC conversion")
            } else {
                print("PASS: real QR creation/polling, song metadata, download endpoint; test song needs account permission")
            }
            return
        }
        let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let fixture = root.appendingPathComponent("fixture.ncm")
        let decoded = root.appendingPathComponent("decoded")
        try FileManager.default.createDirectory(at: decoded, withIntermediateDirectories: true)
        let (audio, tags) = try NCM.decode(fixture, into: decoded)
        try check(try Data(contentsOf: audio) == Data(contentsOf: root.appendingPathComponent("tone.flac")), "NCM audio bytes")
        try check(tags.title == "测试音乐 / Test" && tags.artist == "Nano Artist" && tags.album == "Synthetic", "NCM tags")
        try check(tags.artwork == Data(contentsOf: root.appendingPathComponent("cover.png")), "NCM padded cover")
        let source = try Data(contentsOf: fixture)
        for length in [0, 7, 10, 13, 20, 100] {
            let truncated = root.appendingPathComponent("broken.ncm")
            try source.prefix(length).write(to: truncated)
            do { _ = try NCM.decode(truncated, into: decoded); throw BridgeError("Accepted truncated NCM") }
            catch let error as BridgeError { try check(!error.message.hasPrefix("Accepted"), "truncated NCM rejected") }
        }
        var invalid = source
        invalid.replaceSubrange(10..<14, with: [255, 255, 255, 255])
        let malformed = root.appendingPathComponent("malformed.ncm")
        try invalid.write(to: malformed)
        do { _ = try NCM.decode(malformed, into: decoded); throw BridgeError("Accepted oversized block") }
        catch let error as BridgeError { try check(!error.message.hasPrefix("Accepted"), "oversized blocks rejected") }

        for (text, expected) in [
            ("https://music.163.com/#/song?id=347230", MusicLink(kind: "song", id: 347230)),
            ("分享歌单 https://music.163.com/playlist?id=123&userid=1", MusicLink(kind: "playlist", id: 123)),
            ("https://y.music.163.com/m/song/347230/?userid=1", MusicLink(kind: "song", id: 347230))
        ] { try check(try MusicLink.parse(text) == expected, "NetEase link parser") }
        for text in ["https://evil.example/song?id=1", "https://music.163.com.evil.example/song?id=1", "https://music.163.com/song?id=-1", "https://music.163.com/song?id=0"] {
            do { _ = try MusicLink.parse(text); throw BridgeError("Accepted invalid link") }
            catch let error as BridgeError { try check(!error.message.hasPrefix("Accepted"), "invalid links rejected") }
        }
        try check(AAC.filename("../a:b\nc") == ".._a_b_c", "safe filename")
        let permissionFailures: [[String: Any]] = [
            ["data": ["url": NSNull()]],
            ["data": ["url": "https://m7.music.126.net/song.mp3", "freeTrialInfo": ["start": 0]]],
            ["data": ["url": "https://evil.example/song.mp3"]],
            ["data": ["url": "https://m7.music.126.net/song.mp3", "code": 404]]
        ]
        for body in permissionFailures {
            do { _ = try NetEase.downloadURL(body); throw BridgeError("Accepted unavailable download") }
            catch let error as BridgeError { try check(!error.message.hasPrefix("Accepted"), "unavailable/trial download rejected") }
        }
        let encrypted = try Crypto.aes(Data("cipher roundtrip".utf8), key: "0123456789abcdef")
        try check(try Crypto.aes(encrypted, key: "0123456789abcdef", decrypt: true) == Data("cipher roundtrip".utf8), "AES roundtrip")
        try check(try Crypto.fingerprint(audio) == Crypto.fingerprint(root.appendingPathComponent("tone.flac")), "content fingerprint")
        let output = root.appendingPathComponent("test-output.m4a")
        try await AAC.convert(audio, tags: tags, destination: output, bitrate: 256, temporary: root)
        let written = try await Tags.load(output)
        try check(written.title == tags.title && written.artist == tags.artist && written.album == tags.album, "M4A tags preserved")
        try check(written.artwork == tags.artwork, "M4A cover preserved")
        let asset = AVURLAsset(url: output)
        let tracks = try await asset.loadTracks(withMediaType: .audio)
        let descriptions = try await tracks[0].load(.formatDescriptions)
        let format = CMAudioFormatDescriptionGetStreamBasicDescription(descriptions[0])!.pointee
        try check(format.mFormatID == kAudioFormatMPEG4AAC && format.mSampleRate == 44100 && format.mChannelsPerFrame == 2, "iPod AAC format")
        try check(abs(try await asset.load(.duration).seconds - 1) < 0.1, "audio duration")
        let scriptFile = root.appendingPathComponent("import.applescript")
        try MusicLibrary.script.write(to: scriptFile, atomically: true, encoding: .utf8)
        let compiler = Process()
        compiler.executableURL = URL(fileURLWithPath: "/usr/bin/osacompile")
        compiler.arguments = ["-o", root.appendingPathComponent("import.scpt").path, scriptFile.path]
        try compiler.run()
        compiler.waitUntilExit()
        try check(compiler.terminationStatus == 0, "Music AppleScript compiles")
        print("PASS: independent NCM fixture, malformed inputs, links, download permissions, AAC-LC format, duration, tags, cover, import script syntax")
    }
}
