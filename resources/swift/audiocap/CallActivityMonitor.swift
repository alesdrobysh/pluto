import AppKit
import ApplicationServices
import CoreAudio
import Foundation
import CryptoKit

/// Passive metadata monitor. This mode never opens a microphone or creates a tap.
final class CallActivityMonitor {
    private let epoch = UUID().uuidString
    private var sequence = 0
    private var timer: Timer?
    private var listeners: [(AudioObjectID, AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []
    private var listenedProcesses = Set<AudioObjectID>()
    private var observers: [NSObjectProtocol] = []
    private var terminated: [String] = []
    private var instanceIds: [pid_t: String] = [:]
    private var discontinuity = true
    private var windows: [(AXUIElement, String)] = []
    private var signals: [DispatchSourceSignal] = []
    private var parentWatch: DispatchSourceProcess?
    private let parent = getppid()
    private let names = [
        "com.google.Chrome": "Google Chrome", "us.zoom.xos": "Zoom",
        "com.microsoft.teams2": "Microsoft Teams", "com.tinyspeck.slackmacgap": "Slack"
    ]

    private func identity(_ app: NSRunningApplication) -> String? {
        guard let bundle = app.bundleIdentifier, let launch = app.launchDate else { return nil }
        return "\(bundle):\(app.processIdentifier):\(launch.timeIntervalSince1970)"
    }
    private func canonical(_ bundle: String) -> String? {
        names.keys.first { bundle == $0 || bundle.hasPrefix($0 + ".") }
    }
    private func owningApplication(_ pid: pid_t, _ instances: [pid_t: String]) -> String? {
        var current = pid
        var visited = Set<pid_t>()
        for _ in 0..<16 {
            if let owner = instances[current] { return owner }
            guard current > 1, visited.insert(current).inserted else { return nil }
            var info = proc_bsdinfo()
            let size = Int32(MemoryLayout<proc_bsdinfo>.size)
            guard proc_pidinfo(current, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
            current = pid_t(info.pbi_ppid)
        }
        return nil
    }
    private func scalar<T>(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value = initial
        var size = UInt32(MemoryLayout<T>.size)
        let status = withUnsafeMutablePointer(to: &value) {
            AudioObjectGetPropertyData(id, &address, 0, nil, &size, $0)
        }
        return status == noErr ? value : nil
    }
    private func processIDs() -> [AudioObjectID]? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return nil }
        if size == 0 { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return nil }
        return ids
    }
    private func bundleID(_ id: AudioObjectID) -> String? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyBundleID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: UnsafeMutableRawPointer?
        var size = UInt32(MemoryLayout<UnsafeMutableRawPointer?>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr,
              let value else { return nil }
        return Unmanaged<CFString>.fromOpaque(value).takeRetainedValue() as String
    }
    private func emit(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        do { try FileHandle.standardOutput.write(contentsOf: data + Data([10])) }
        catch { exit(1) }
    }
    private func listen(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector, route: Bool = false) {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self else { return }
            if route { self.discontinuity = true }
            self.snapshot()
        }
        if AudioObjectAddPropertyListenerBlock(id, &address, .main, block) == noErr {
            listeners.append((id, address, block))
        }
        // Reconciliation reads remain authoritative even if a listener fails.
    }
    private func snapshot() {
        let ids = processIDs()
        let current = Set(ids ?? [])
        if ids != nil {
            for (id, var address, block) in listeners where id != kAudioObjectSystemObject && !current.contains(id) {
                AudioObjectRemovePropertyListenerBlock(id, &address, .main, block)
            }
            listeners.removeAll { $0.0 != kAudioObjectSystemObject && !current.contains($0.0) }
            for id in current.subtracting(listenedProcesses) {
                for selector in [kAudioProcessPropertyIsRunning, kAudioProcessPropertyIsRunningInput, kAudioProcessPropertyIsRunningOutput] { listen(id, selector) }
            }
            listenedProcesses = current
        }
        let running = NSWorkspace.shared.runningApplications
        let callApps = running.compactMap { app -> (NSRunningApplication, String)? in
            guard let bundle = app.bundleIdentifier, names[bundle] != nil,
                  let id = identity(app) else { return nil }
            return (app, id)
        }
        for (app, id) in callApps { instanceIds[app.processIdentifier] = id }
        let instances = Dictionary(uniqueKeysWithValues: callApps.map { ($0.0.processIdentifier, $0.1) })
        var activity: [String: [(AudioObjectID, Bool?, Bool?)]] = [:]
        var ambiguousBundles = Set<String>()
        var healthy = ids != nil
        for id in ids ?? [] {
            guard let pid: pid_t = scalar(id, kAudioProcessPropertyPID, pid_t(0)) else { healthy = false; continue }
            if pid == parent || pid == getpid() { continue }
            guard let bundle = bundleID(id) else { healthy = false; continue }
            // The allowlist excludes every Pluto/Electron/capture/runtime helper.
            guard let canonicalBundle = canonical(bundle) else { continue }
            let owned = owningApplication(pid, instances)
            let matching = callApps.filter { $0.0.bundleIdentifier == canonicalBundle }
            let app = owned ?? (matching.count == 1 ? matching[0].1 : nil)
            guard let app else {
                ambiguousBundles.insert(canonicalBundle)
                continue
            }
            let input: UInt32? = scalar(id, kAudioProcessPropertyIsRunningInput, UInt32(0))
            let output: UInt32? = scalar(id, kAudioProcessPropertyIsRunningOutput, UInt32(0))
            activity[app, default: []].append((id, input.map { $0 != 0 }, output.map { $0 != 0 }))
        }
        var sources: [[String: Any]] = []
        for (app, id) in callApps {
            guard let bundle = app.bundleIdentifier, let name = names[bundle] else { continue }
            let values = activity[id] ?? []
            let known = ids != nil && !ambiguousBundles.contains(bundle) && values.allSatisfy { $0.1 != nil && $0.2 != nil }
            let version = app.bundleURL.flatMap { Bundle(url: $0)?.infoDictionary?["CFBundleShortVersionString"] as? String } ?? "unknown"
            sources.append([
                "id": id, "bundleId": bundle, "pid": app.processIdentifier, "name": name, "version": version,
                "input": known ? values.contains { $0.1 == true } as Any : NSNull(),
                "output": known ? values.contains { $0.2 == true } as Any : NSNull(),
                "audioGeneration": values.map { String($0.0) }.sorted().joined(separator: ",")
            ])
        }
        sequence += 1
        emit(["kind": "activity", "version": 1, "epoch": epoch, "sequence": sequence,
              "healthy": healthy, "discontinuity": discontinuity, "sources": sources, "terminated": terminated])
        terminated.removeAll()
        discontinuity = false
    }

    private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }
    private func opaqueElement(_ element: AXUIElement) -> String {
        if let match = windows.first(where: { CFEqual($0.0, element) }) { return match.1 }
        let id = UUID().uuidString
        windows.append((element, id))
        if windows.count > 128 { windows.removeFirst() }
        return id
    }
    /// Emits only allowlisted UI tokens, never arbitrary AX text or raw URLs.
    private func inspect(_ command: [String: Any]) {
        guard let request = command["requestId"] as? String,
              let source = command["sourceId"] as? String else { return }
        var result: [String: Any] = ["kind": "inspection", "version": 1, "requestId": request,
            "sourceId": source, "trusted": AXIsProcessTrusted(), "healthy": false, "windows": []]
        defer { emit(result) }
        guard AXIsProcessTrusted(), let app = NSWorkspace.shared.runningApplications.first(where: { identity($0) == source }),
              let bundle = app.bundleIdentifier, names[bundle] != nil else { return }
        let root = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 0.2)
        guard let allWindows = attribute(root, kAXWindowsAttribute) as? [AXUIElement] else { return }
        let tokenLabels: [String: String] = [
            "Leave call": "leave_call", "Leave meeting": "leave_meeting",
            "Leave huddle": "leave_huddle", "Hang up": "hang_up",
            "You left the meeting": "left_meeting", "You left the call": "left_call",
            "The meeting has ended": "meeting_ended", "This meeting has been ended by host": "host_ended",
            "You've left the huddle": "left_huddle", "You left the huddle": "left_huddle",
            "The huddle has ended": "huddle_ended"
        ]
        var observations: [[String: Any]] = []
        let deadline = ProcessInfo.processInfo.systemUptime + 0.8
        for window in allWindows.prefix(16) {
            var stack: [(AXUIElement, Bool)] = [(window, bundle != "com.google.Chrome")]
            var count = 0
            var markers: [[String: String]] = []
            var callPages: [String] = []
            while let (element, inCallPage) = stack.popLast() {
                count += 1
                guard count <= 1500 && ProcessInfo.processInfo.systemUptime < deadline else { return }
                guard let role = attribute(element, kAXRoleAttribute) as? String else { return }
                let rawURL = attribute(element, "AXURL")
                let urlString = (rawURL as? URL)?.absoluteString ?? (rawURL as? String)
                let url = urlString.flatMap { URL(string: $0) }
                let path = url?.path.split(separator: "/").map(String.init) ?? []
                let meetPage = bundle == "com.google.Chrome" && role == "AXWebArea" &&
                    url?.host == "meet.google.com" && path.count == 1 &&
                    path[0].range(of: "^[a-z]{3}-[a-z]{4}-[a-z]{3}$", options: .regularExpression) != nil
                if meetPage { callPages.append(opaqueElement(element)) }
                if (inCallPage || meetPage), ["AXButton", "AXStaticText", "AXHeading", "AXGroup", "AXWebArea"].contains(role) {
                    let labels = [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute]
                        .compactMap { attribute(element, $0) as? String }
                    let identifier = (attribute(element, kAXIdentifierAttribute) as? String) ?? ""
                    let digest = SHA256.hash(data: Data(identifier.utf8)).map { String(format: "%02x", $0) }.joined()
                    for token in Set(labels.compactMap { tokenLabels[$0] }) {
                        // Emit only allowlisted states and hashed identifiers, never UI text.
                        markers.append(["role": role, "identifier": digest, "token": token])
                    }
                }
                if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
                    stack.append(contentsOf: children.map { ($0, inCallPage || meetPage) })
                }
            }
            let windowId = opaqueElement(window)
            // A browser window alone isn't a call identity. Multiple/unknown pages abstain.
            if bundle == "com.google.Chrome" && callPages.count != 1 { continue }
            observations.append(["id": windowId + (callPages.first.map { ":" + $0 } ?? ""), "markers": markers])
        }
        result["windows"] = observations
        result["healthy"] = true
    }
    func run() {
        let center = NSWorkspace.shared.notificationCenter
        observers.append(center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let self, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  let bundle = app.bundleIdentifier, self.names[bundle] != nil,
                  let id = self.instanceIds.removeValue(forKey: app.processIdentifier) ?? self.identity(app) else { return }
            self.terminated.append(id)
            self.snapshot()
        })
        for notification in [NSWorkspace.didWakeNotification, NSWorkspace.willSleepNotification] {
            observers.append(center.addObserver(forName: notification, object: nil, queue: .main) { [weak self] _ in
                self?.discontinuity = true; self?.snapshot()
            })
        }
        listen(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList)
        for selector in [kAudioHardwarePropertyDefaultInputDevice, kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyServiceRestarted] {
            listen(AudioObjectID(kAudioObjectSystemObject), selector, route: true)
        }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.snapshot() }
        for sig in [SIGINT, SIGTERM] {
            signal(sig, SIG_IGN)
            let signalSource = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            signalSource.setEventHandler { exit(0) }; signalSource.resume(); signals.append(signalSource)
        }
        if parent <= 1 { exit(1) }
        parentWatch = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: .main)
        parentWatch?.setEventHandler { exit(0) }; parentWatch?.resume()
        DispatchQueue.global().async { [weak self] in
            while let line = readLine() {
                guard line.utf8.count < 4096, let data = line.data(using: .utf8),
                      let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                      command["kind"] as? String == "inspect" else { continue }
                DispatchQueue.main.async { self?.inspect(command) }
            }
            exit(0)
        }
        snapshot()
        RunLoop.main.run()
    }
}
