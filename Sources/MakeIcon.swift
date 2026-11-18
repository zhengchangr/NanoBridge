import AppKit
import SwiftUI

let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
try MainActor.assumeIsolated {
    let icon = ZStack {
        RoundedRectangle(cornerRadius: 200)
            .fill(Color(red: 0.97, green: 0.98, blue: 0.975))
            .frame(width: 896, height: 896)
        Image(systemName: "ipod")
            .font(.system(size: 600, weight: .light))
            .foregroundStyle(Color(red: 0.13, green: 0.43, blue: 0.37))
    }.frame(width: 1024, height: 1024).environment(\.colorScheme, .light)
    for size in [16, 32, 128, 256, 512] {
        for scale in [1, 2] {
            let renderer = ImageRenderer(content: icon)
            renderer.scale = CGFloat(size * scale) / 1024
            guard let image = renderer.cgImage else { fatalError("Unable to render app icon") }
            let bitmap = NSBitmapImageRep(cgImage: image)
            let name = "icon_\(size)x\(size)" + (scale == 2 ? "@2x" : "") + ".png"
            try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent(name))
        }
    }
}
