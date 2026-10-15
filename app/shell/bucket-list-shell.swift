// bucket-list-shell.swift — a native macOS window (NSWindow + WKWebView) that
// hosts the Bucket List app. Same pattern as HQ's shell: it starts the bundled
// Node server as a CHILD process on launch and TERMINATES it on quit, so
// nothing leaks. Export downloads land wherever the user picks in a save panel.
//
// Compiled into "Bucket List.app/Contents/MacOS/bucket-list" by
// scripts/make-macos-app.sh.
import AppKit
import WebKit

let PORT = 3011
let URLSTR = "http://localhost:\(PORT)/"

// GUI apps get a minimal PATH: check the usual install locations, then ask the
// user's login shell (covers nvm, fnm, volta, asdf).
func resolveNode() -> String? {
    let fm = FileManager.default
    for c in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
        if fm.isExecutableFile(atPath: c) { return c }
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-lic", "command -v node"]
    let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
    do { try p.run() } catch { return nil }
    p.waitUntilExit()
    let path = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .split(separator: "\n").last.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
    return fm.isExecutableFile(atPath: path) ? path : nil
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
                         WKNavigationDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?

    func engineDir() -> String {
        (Bundle.main.resourcePath ?? ".") + "/engine"
    }

    // Spawn the bundled server. GUI apps get a minimal PATH, so node is resolved
    // by absolute path and PATH is widened so the server can find `aws`.
    func startServer() {
        killPort(PORT)   // reclaim the port from any orphaned server so a fresh
                         // launch always serves the current bundle
        guard let node = resolveNode() else {
            let a = NSAlert()
            a.messageText = "Bucket List needs Node.js"
            a.informativeText = "Install Node.js 18 or later (nodejs.org, or `brew install node`), then open Bucket List again. The AWS CLI is required too."
            a.addButton(withTitle: "Quit")
            a.runModal()
            NSApp.terminate(nil)
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = ["server.js"]
        p.currentDirectoryURL = URL(fileURLWithPath: engineDir())
        var env = ProcessInfo.processInfo.environment
        env["BUCKET_LIST_PORT"] = String(PORT)
        env["HOSTNAME"] = "127.0.0.1"
        let nodeDir = (node as NSString).deletingLastPathComponent
        env["PATH"] = "\(nodeDir):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        p.environment = env
        do { try p.run(); server = p } catch { NSLog("Bucket List: server start failed: \(error)") }
    }

    func buildWindow() {
        let vis = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let w = min(1240, vis.width * 0.82)
        let h = min(860, vis.height * 0.88)
        let rect = NSRect(x: 0, y: 0, width: w, height: h)
        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Bucket List"
        window.contentMinSize = NSSize(width: 720, height: 520)
        window.setFrameAutosaveName("BucketListWindow")
        window.center()
        window.delegate = self
        webView = WKWebView(frame: rect, configuration: WKWebViewConfiguration())
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.pageZoom = max(0.5, min(3.0, (UserDefaults.standard.object(forKey: "bucketListZoom") as? Double) ?? 1.0))
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
    }

    // Poll the server until it answers, then load it (no flash of error while
    // node is still booting).
    func waitForServerThenLoad(reload: Bool = false) {
        guard let url = URL(string: URLSTR) else { return }
        DispatchQueue.global().async {
            for _ in 0..<60 {
                var req = URLRequest(url: url); req.timeoutInterval = 1.5
                let sem = DispatchSemaphore(value: 0); var ok = false
                URLSession.shared.dataTask(with: req) { _, resp, _ in
                    if let h = resp as? HTTPURLResponse, h.statusCode == 200 { ok = true }
                    sem.signal()
                }.resume()
                _ = sem.wait(timeout: .now() + 2)
                if ok { break }
                Thread.sleep(forTimeInterval: 0.3)
            }
            DispatchQueue.main.async {
                if reload { self.webView.reloadFromOrigin() } else { self.webView.load(URLRequest(url: url)) }
            }
        }
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        startServer()
        buildWindow()
        waitForServerThenLoad()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ note: Notification) {
        server?.terminate()   // no leaked background server
    }

    // --- downloads: Export HTML -> save panel --------------------------------
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let h = navigationResponse.response as? HTTPURLResponse,
           let cd = h.value(forHTTPHeaderField: "Content-Disposition"), cd.lowercased().hasPrefix("attachment") {
            decisionHandler(.download)
        } else {
            decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.canCreateDirectories = true
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.beginSheetModal(for: window) { resp in
            guard resp == .OK, let url = panel.url else { return completionHandler(nil) }
            try? FileManager.default.removeItem(at: url)   // the panel already confirmed replace
            completionHandler(url)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        NSLog("Bucket List: export failed: \(error)")
    }

    // --- menu actions -----------------------------------------------------------
    @objc func reload() { webView?.reloadFromOrigin() }

    @objc func openInBrowser() { NSWorkspace.shared.open(URL(string: URLSTR)!) }

    func killPort(_ port: Int) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "lsof -ti tcp:\(port) | xargs kill -9 2>/dev/null || true"]
        p.environment = ["PATH": "/usr/sbin:/usr/bin:/bin"]
        try? p.run()
        p.waitUntilExit()
    }

    @objc func restartServer() {
        server?.terminate()
        startServer()
        waitForServerThenLoad(reload: true)
    }

    @objc func zoomIn()    { setZoom(webView.pageZoom + 0.1) }
    @objc func zoomOut()   { setZoom(webView.pageZoom - 0.1) }
    @objc func zoomReset() { setZoom(1.0) }
    func setZoom(_ z: CGFloat) {
        let clamped = max(0.5, min(3.0, z))
        webView.pageZoom = clamped
        UserDefaults.standard.set(Double(clamped), forKey: "bucketListZoom")
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()

let mainMenu = NSMenu()
let appItem = NSMenuItem(); mainMenu.addItem(appItem)
let appMenu = NSMenu()
let reloadItem = NSMenuItem(title: "Reload", action: #selector(AppDelegate.reload), keyEquivalent: "r")
reloadItem.target = delegate
appMenu.addItem(reloadItem)
let restartItem = NSMenuItem(title: "Restart Server", action: #selector(AppDelegate.restartServer), keyEquivalent: "r")
restartItem.keyEquivalentModifierMask = [.command, .shift]
restartItem.target = delegate
appMenu.addItem(restartItem)
let browserItem = NSMenuItem(title: "Open in Browser", action: #selector(AppDelegate.openInBrowser), keyEquivalent: "b")
browserItem.target = delegate
appMenu.addItem(browserItem)
appMenu.addItem(NSMenuItem.separator())
appMenu.addItem(withTitle: "Hide Bucket List", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
appMenu.addItem(withTitle: "Quit Bucket List", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
appItem.submenu = appMenu

// Edit menu so ⌘A/⌘C/⌘V/⌘X/⌘Z work in the search box.
let editItem = NSMenuItem(); mainMenu.addItem(editItem)
let editMenu = NSMenu(title: "Edit")
editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
let redoItem = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
redoItem.keyEquivalentModifierMask = [.command, .shift]
editMenu.addItem(redoItem)
editMenu.addItem(NSMenuItem.separator())
editMenu.addItem(withTitle: "Cut", action: Selector(("cut:")), keyEquivalent: "x")
editMenu.addItem(withTitle: "Copy", action: Selector(("copy:")), keyEquivalent: "c")
editMenu.addItem(withTitle: "Paste", action: Selector(("paste:")), keyEquivalent: "v")
editMenu.addItem(withTitle: "Select All", action: Selector(("selectAll:")), keyEquivalent: "a")
editItem.submenu = editMenu

let viewItem = NSMenuItem(); mainMenu.addItem(viewItem)
let viewMenu = NSMenu(title: "View")
let zin = NSMenuItem(title: "Zoom In", action: #selector(AppDelegate.zoomIn), keyEquivalent: "+"); zin.target = delegate
let zout = NSMenuItem(title: "Zoom Out", action: #selector(AppDelegate.zoomOut), keyEquivalent: "-"); zout.target = delegate
let zreset = NSMenuItem(title: "Actual Size", action: #selector(AppDelegate.zoomReset), keyEquivalent: "0"); zreset.target = delegate
viewMenu.addItem(zin); viewMenu.addItem(zout); viewMenu.addItem(zreset)
viewItem.submenu = viewMenu

app.mainMenu = mainMenu
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
