// Нарезка видео на кадры JPEG, чтобы прогонять ролики через модель без <video>
// (в скрытой вкладке Chrome видео не играет, а картинки грузятся). Страница прогона: tests/replay.html.
// Swift уже есть в macOS (Command Line Tools), ничего ставить не нужно.
//
// Запуск: swift tools/frames.swift <видео> <папка> [fps=15] [maxWidth=960]
// В папке: f00001.jpg, f00002.jpg, ... и index.json { source, fps, count, width, height, duration }.

import AVFoundation
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 3 else {
    print("usage: swift tools/frames.swift <video> <outDir> [fps=15] [maxWidth=960]")
    exit(1)
}
let src = URL(fileURLWithPath: args[1])
let out = URL(fileURLWithPath: args[2])
let fps = args.count > 3 ? (Double(args[3]) ?? 15) : 15
let maxW = args.count > 4 ? (Double(args[4]) ?? 960) : 960

try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
let asset = AVURLAsset(url: src)
let duration = CMTimeGetSeconds(asset.duration)
let gen = AVAssetImageGenerator(asset: asset)
gen.appliesPreferredTrackTransform = true
gen.requestedTimeToleranceBefore = .zero
gen.requestedTimeToleranceAfter = .zero
gen.maximumSize = CGSize(width: maxW, height: maxW)

let count = Int(floor(duration * fps))
var width = 0
var height = 0
for i in 0..<count {
    let time = CMTime(seconds: Double(i) / fps, preferredTimescale: 600)
    let image = try gen.copyCGImage(at: time, actualTime: nil)
    width = image.width
    height = image.height
    let url = out.appendingPathComponent(String(format: "f%05d.jpg", i + 1))
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
        print("не удалось создать \(url.path)")
        exit(1)
    }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    CGImageDestinationFinalize(dest)
}

let index: [String: Any] = [
    "source": src.lastPathComponent, "fps": fps, "count": count,
    "width": width, "height": height, "duration": duration,
]
let json = try JSONSerialization.data(withJSONObject: index, options: [.prettyPrinted, .sortedKeys])
try json.write(to: out.appendingPathComponent("index.json"))
print("кадров: \(count), \(width)x\(height), \(fps) fps → \(out.path)")
