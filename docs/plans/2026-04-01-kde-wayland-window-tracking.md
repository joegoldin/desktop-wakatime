# KDE Wayland Window Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable desktop-wakatime to track active windows on KDE Plasma Wayland by using a KWin script + D-Bus bridge, since x-win only supports GNOME.

**Architecture:** Detect KDE Wayland at runtime. Load a KWin compositor script via D-Bus that watches `workspace.windowActivated` and calls back into a D-Bus service hosted by the Electron app. Map KWin window data to the same `WindowInfo` shape used by x-win so all downstream tracking logic remains unchanged.

**Tech Stack:** TypeScript, Electron, dbus-next (pure JS D-Bus client), KWin scripting API

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `electron/watchers/kde-wayland.ts` | Create | KDE watcher: D-Bus service, KWin script lifecycle, WindowInfo mapping |
| `electron/watchers/kwin-script.js` | Create | KWin script source loaded into compositor at runtime |
| `electron/watchers/watcher.ts` | Modify | Detect KDE Wayland, delegate to KDE watcher or x-win |
| `electron/main.ts` | Modify | Use KDE watcher for `openWindowsAsync` in IPC handlers |
| `package.json` | Modify | Add `dbus-next` dependency |

## Tasks

### 1. Add dbus-next dependency

- [ ] Run `npm install dbus-next` in the fork repo
- [ ] Verify `package.json` has `dbus-next` in dependencies
- [ ] Commit: `feat: add dbus-next dependency for KDE D-Bus communication`

### 2. Create the KWin script

This is the script that runs inside KDE's compositor. It has access to the KWin scripting API (`workspace`, `callDBus`).

- [ ] Create `electron/watchers/kwin-script.js` with this content:

```javascript
// KWin script: reports active window changes to desktop-wakatime via D-Bus
// Loaded at runtime via org.kde.KWin.Scripting

function reportWindow(window) {
    if (!window) return;
    callDBus(
        "com.wakatime.WindowTracker",
        "/WindowTracker",
        "com.wakatime.WindowTracker",
        "WindowActivated",
        window.caption || "",
        window.resourceClass || "",
        window.resourceName || "",
        window.pid || 0
    );
}

// Report on window activation
workspace.windowActivated.connect(reportWindow);

// Report initial active window
reportWindow(workspace.activeWindow);
```

- [ ] Commit: `feat: add KWin script for window activation tracking`

### 3. Create the KDE Wayland watcher module

This is the main new module. It:
- Hosts a D-Bus service that receives `WindowActivated` calls from the KWin script
- Loads/unloads the KWin script via `org.kde.KWin.Scripting` D-Bus interface
- Maps KWin window data to x-win's `WindowInfo` shape
- Exposes `subscribeActiveWindow` and `getOpenWindows` for use by `watcher.ts` and `main.ts`

- [ ] Create `electron/watchers/kde-wayland.ts`
- [ ] Implement `isKdeWayland()` detection function:
  - Check `process.env.WAYLAND_DISPLAY` is set
  - Check `process.env.XDG_CURRENT_DESKTOP` contains `KDE`
  - Export this function for use by `watcher.ts` and `main.ts`
- [ ] Implement `KdeWaylandWatcher` class with:
  - `private bus: MessageBus` — session bus connection via dbus-next
  - `private scriptId: number | null` — KWin script handle for cleanup
  - `private callback: ((info: WindowInfo) => void) | null` — window change callback
  - `async start(callback: (info: WindowInfo) => void): Promise<void>`:
    1. Connect to session bus via `dbus.sessionBus()`
    2. Request name `com.wakatime.WindowTracker`
    3. Export an object at `/WindowTracker` with interface `com.wakatime.WindowTracker` that has a `WindowActivated` method accepting `(title: string, appId: string, resourceName: string, pid: number)`
    4. When `WindowActivated` is called, construct a `WindowInfo`-compatible object and invoke the callback
    5. Write kwin-script.js content to a temp file
    6. Call `org.kde.KWin` → `org.kde.kwin.Scripting` → `loadScript(tempPath, "wakatime-window-tracker")` to get script ID
    7. Call `run()` on the returned script object to start it
  - `async stop(): Promise<void>`:
    1. Unload KWin script via `org.kde.kwin.Scripting.unloadScript("wakatime-window-tracker")`
    2. Clean up temp file
    3. Release D-Bus name, disconnect bus
  - `async getOpenWindows(): Promise<WindowInfo[]>`:
    1. Load a temporary KWin script that enumerates all windows and calls back via D-Bus
    2. Collect results, unload script, return array
- [ ] Map KWin data to `WindowInfo` shape. The x-win `WindowInfo` has `info.name`, `info.path`, `info.processId`, `info.execName`. Map from KWin: `caption` → `name`, `resourceClass` → `execName`, `pid` → `processId`, resolve PID to exe path via `/proc/{pid}/exe` → `path`
- [ ] Commit: `feat: add KDE Wayland watcher with D-Bus bridge`

### 4. Modify watcher.ts to support KDE path

- [ ] Add import: `import { isKdeWayland, KdeWaylandWatcher } from "./kde-wayland";`
- [ ] Add private field: `private kdeWatcher: KdeWaylandWatcher | null = null;`
- [ ] Extract existing x-win `subscribeActiveWindow` logic from `start()` into a private `startXWin()` method
- [ ] Add private `startKde()` method that:
  1. Creates `KdeWaylandWatcher` instance
  2. Calls `kdeWatcher.start()` with callback that sets `this.activeWindow` and calls `handleActivity()`
- [ ] Modify `start()` to: check `isKdeWayland()` → call `startKde()`, else call `startXWin()`. Keep the idle timer for both paths.
- [ ] Modify `stop()` to also call `kdeWatcher?.stop()` if active
- [ ] Commit: `feat: integrate KDE watcher into watcher.ts`

### 5. Modify main.ts IPC handlers for KDE

- [ ] Add import: `import { isKdeWayland, KdeWaylandWatcher } from "./watchers/kde-wayland";`
- [ ] Add a module-level `let kdeWatcher: KdeWaylandWatcher | null = null;` initialized during app setup when `isKdeWayland()` is true
- [ ] Modify `IpcKeys.getOpenApps` handler: if KDE, use `kdeWatcher.getOpenWindows()` instead of `openWindowsAsync()`
- [ ] Modify `IpcKeys.getAllAvailableApps` handler: same KDE branch
- [ ] Commit: `feat: use KDE watcher for open windows IPC`

### 6. Test on KDE Wayland

- [ ] Build the app: `npm run build` (with electron-builder skip)
- [ ] Launch on KDE Wayland
- [ ] Verify: no crash on startup
- [ ] Verify: switching windows triggers watcher log messages (`App changed from X to Y`)
- [ ] Verify: settings UI shows open apps list
- [ ] Verify: heartbeats sent to wakapi for monitored apps
- [ ] Verify: stopping the app unloads the KWin script (check `qdbus org.kde.KWin /Scripting`)

### 7. Update Nix package

- [ ] Update `hosts/common/system/pkgs/desktop-wakatime.nix` to build from `joegoldin/desktop-wakatime` fork instead of upstream
- [ ] Remove x-win v3 upgrade patches (no longer needed — KDE uses D-Bus, GNOME still uses x-win v2)
- [ ] Add `dbus` system library to `buildInputs` if dbus-next needs it at runtime
- [ ] Recompute hashes
- [ ] Build and test
- [ ] Commit: `feat: build desktop-wakatime from fork with KDE support`
