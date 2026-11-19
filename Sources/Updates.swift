import AppKit
import Combine
import Sparkle

@MainActor
final class AppUpdater: NSObject, ObservableObject, SPUUpdaterDelegate {
    @Published var canCheck = false
    @Published var automaticallyChecks = false
    @Published var automaticallyDownloads = false
    @Published var installationDeferred = false
    private var controller: SPUStandardUpdaterController!
    private let model: BridgeModel
    private var deferredInstall: (() -> Void)?
    private var activity: AnyCancellable?

    init(model: BridgeModel) {
        self.model = model
        super.init()
        controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
        controller.updater.publisher(for: \.canCheckForUpdates).assign(to: &$canCheck)
        controller.updater.publisher(for: \.automaticallyChecksForUpdates).assign(to: &$automaticallyChecks)
        controller.updater.publisher(for: \.automaticallyDownloadsUpdates).assign(to: &$automaticallyDownloads)
        // Queue entries live in memory. Wait until the user has cleared them before restarting.
        activity = Publishers.CombineLatest3(model.$running, model.$resolving, model.$items)
            .receive(on: RunLoop.main)
            .sink { [weak self] running, resolving, items in
                guard !running, !resolving, items.isEmpty, let self, let install = self.deferredInstall else { return }
                self.deferredInstall = nil
                self.installationDeferred = false
                install()
            }
        controller.startUpdater()
    }

    func checkForUpdates() { controller.checkForUpdates(nil) }
    func setAutomaticChecks(_ enabled: Bool) { controller.updater.automaticallyChecksForUpdates = enabled }
    func setAutomaticDownloads(_ enabled: Bool) { controller.updater.automaticallyDownloadsUpdates = enabled }

    func updater(_ updater: SPUUpdater, mayPerform updateCheck: SPUUpdateCheck) throws {
        guard !model.running, !model.resolving else {
            throw NSError(domain: "NanoBridge.Updates", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "音乐正在处理中，请在任务完成后检查更新。"])
        }
    }

    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem,
                 untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
        guard model.running || model.resolving || !model.items.isEmpty else { return false }
        deferredInstall = installHandler
        installationDeferred = true
        return true
    }
}
