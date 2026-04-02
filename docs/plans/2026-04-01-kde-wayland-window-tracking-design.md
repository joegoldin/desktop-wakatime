# KDE Wayland Window Tracking

## Problem

x-win's Wayland support is GNOME-only. On KDE Plasma Wayland, `openWindowsAsync()` and `subscribeActiveWindow()` silently return empty results because the GNOME Shell D-Bus extension doesn't exist. This makes desktop-wakatime unable to track which applications are being used.

## Solution

Event-driven KWin script bridge that uses KDE's compositor scripting API to watch window activations and report them back to the Electron app over D-Bus.

## Architecture

### Detection

Check environment at watcher startup:
- `WAYLAND_DISPLAY` is set (Wayland session)
- `XDG_CURRENT_DESKTOP` contains `KDE`

If both true, use KDE watcher. Otherwise fall back to x-win (GNOME Wayland / X11).

### KWin Script

A small JavaScript file loaded into KWin at runtime via D-Bus. KWin scripts have access to `workspace.windowActivated` signals and window properties (title, resourceClass, pid).

On each window activation, the script calls `callDBus()` to invoke a method on `com.wakatime.WindowTracker` — a D-Bus service hosted by the Electron app.

```javascript
workspace.windowActivated.connect(function(window) {
    if (!window) return;
    callDBus(
        "com.wakatime.WindowTracker",
        "/com/wakatime/WindowTracker",
        "com.wakatime.WindowTracker",
        "WindowActivated",
        window.caption || "",
        window.resourceClass || "",
        window.pid || 0
    );
});
```

### Electron D-Bus Service

Uses `dbus-next` (pure JS D-Bus client, no native compilation) to:

1. Register `com.wakatime.WindowTracker` service on the session bus
2. Expose a `WindowActivated(title: string, appId: string, pid: number)` method
3. When called by KWin script, map the data to the existing `WindowInfo` shape and invoke the same `handleActivity()` callback the x-win path uses

### Script Lifecycle

- **Load:** On watcher `start()`, write the KWin script to a temp file, then call `org.kde.KWin.Scripting.loadScript(path, "wakatime-window-tracker")` followed by `run()` on the returned script object
- **Unload:** On watcher `stop()`, call `org.kde.KWin.Scripting.unloadScript("wakatime-window-tracker")` and clean up the temp file
- **Crash safety:** If the Electron app crashes, KWin automatically unloads scripts from disconnected D-Bus clients

### Watcher Integration

`electron/watchers/watcher.ts` changes:

```
start() {
    this.stop();
    if (isKdeWayland()) {
        this.startKdeWatcher();
    } else {
        this.startXWinWatcher();  // existing code
    }
    // idle timer stays the same for both paths
}
```

The KDE watcher produces the same `WindowInfo`-compatible data, so `handleActivity()`, `MonitoredApp`, and all downstream tracking logic remains unchanged.

### Open Windows

For `openWindowsAsync()` (used by IPC handlers `getOpenApps` and `getAllAvailableApps`): on KDE, evaluate a KWin script that returns the current window list via D-Bus. This is a synchronous query rather than event-driven, called on demand from the IPC handlers.

## Files

| File | Purpose |
|------|---------|
| `electron/watchers/kde-wayland.ts` | KDE Wayland watcher: D-Bus service, KWin script loading, WindowInfo mapping |
| `electron/watchers/kwin-script.js` | KWin script source (loaded into compositor) |
| `electron/watchers/watcher.ts` | Modified to detect KDE and delegate |
| `electron/main.ts` | Modified IPC handlers for open windows on KDE |

## Dependencies

- `dbus-next` — pure JS D-Bus client for session bus communication. No native compilation, works in Electron without rebuilding.

## Fallback Chain

1. KDE Wayland → KWin script bridge
2. GNOME Wayland → x-win (existing, unchanged)
3. X11 → x-win (existing, unchanged)
