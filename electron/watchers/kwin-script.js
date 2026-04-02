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
