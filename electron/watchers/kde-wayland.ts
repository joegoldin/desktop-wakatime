import fs from "fs";
import os from "os";
import path from "path";

import dbus from "dbus-next";
import type { WindowInfo } from "@miniben90/x-win";

const DBUS_SERVICE_NAME = "com.wakatime.WindowTracker";
const DBUS_OBJECT_PATH = "/WindowTracker";
const DBUS_INTERFACE_NAME = "com.wakatime.WindowTracker";

const KWIN_SCRIPT_NAME = "wakatime-window-tracker";

// Embedded KWin script content — sent to the compositor at runtime.
// Must use callDBus which is a KWin scripting global.
const KWIN_ACTIVATE_SCRIPT = `\
function reportWindow(window) {
    if (!window) return;
    callDBus(
        "${DBUS_SERVICE_NAME}",
        "${DBUS_OBJECT_PATH}",
        "${DBUS_INTERFACE_NAME}",
        "WindowActivated",
        window.caption || "",
        window.resourceClass || "",
        window.resourceName || "",
        window.pid || 0
    );
}
workspace.windowActivated.connect(reportWindow);
reportWindow(workspace.activeWindow);
`;

const KWIN_LIST_WINDOWS_SCRIPT = `\
var windows = workspace.windowList();
for (var i = 0; i < windows.length; i++) {
    var w = windows[i];
    if (w && w.pid) {
        callDBus(
            "${DBUS_SERVICE_NAME}",
            "${DBUS_OBJECT_PATH}",
            "${DBUS_INTERFACE_NAME}",
            "WindowActivated",
            w.caption || "",
            w.resourceClass || "",
            w.resourceName || "",
            w.pid || 0
        );
    }
}
`;

/**
 * Returns true when running on KDE Plasma under Wayland.
 */
export function isKdeWayland(): boolean {
  const desktop = (process.env.XDG_CURRENT_DESKTOP || "").toUpperCase();
  const isKde = desktop.includes("KDE");
  const isWayland =
    !!process.env.WAYLAND_DISPLAY ||
    process.env.XDG_SESSION_TYPE === "wayland";
  // Fallback: if env vars are missing (e.g. launched from a terminal without
  // session vars), check if KWin is running as a Wayland compositor
  if (!isKde || !isWayland) {
    try {
      const kwinPid = fs
        .readdirSync("/proc")
        .find((entry) => {
          try {
            const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf-8");
            return cmdline.includes("kwin_wayland");
          } catch {
            return false;
          }
        });
      if (kwinPid) return true;
    } catch {
      // ignore
    }
  }
  return isKde && isWayland;
}

/**
 * Resolve a PID to an executable path via /proc.
 */
function exePathForPid(pid: number): string {
  try {
    return fs.readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return "";
  }
}

/**
 * Build a WindowInfo-compatible plain object from KWin window data.
 * The position/usage/icon fields are stubbed because the heartbeat
 * logic only uses `title`, `info.*`, and `url`.
 */
function buildWindowInfo(
  title: string,
  appId: string,
  resourceName: string,
  pid: number,
): WindowInfo {
  const exePath = exePathForPid(pid);

  const info = {
    processId: pid,
    path: exePath,
    name: appId,
    execName: path.basename(exePath) || resourceName,
  };

  // We return a plain object that satisfies the WindowInfo shape.
  // The class is native (NAPI-RS) and cannot be instantiated from JS,
  // so we duck-type it instead.
  return {
    id: pid,
    os: "linux",
    title,
    position: { x: 0, y: 0, width: 0, height: 0, isFullScreen: false },
    info,
    usage: { memory: 0 },
    url: "",
    getIcon: () => ({ data: "", height: 0, width: 0 }),
    getIconAsync: async () => ({ data: "", height: 0, width: 0 }),
  } as unknown as WindowInfo;
}

// ---------------------------------------------------------------------------
// D-Bus interface definition for dbus-next (using configureMembers instead
// of decorators, since experimentalDecorators is not enabled).
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const DbusInterface: typeof dbus.interface.Interface =
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  require("dbus-next").interface.Interface;

type WindowActivatedHandler = (
  title: string,
  appId: string,
  resourceName: string,
  pid: number,
) => void;

class WindowTrackerInterface extends DbusInterface {
  onWindowActivated: WindowActivatedHandler | null = null;

  WindowActivated(
    title: string,
    appId: string,
    resourceName: string,
    pid: number,
  ): void {
    if (this.onWindowActivated) {
      this.onWindowActivated(title, appId, resourceName, pid);
    }
  }
}

// Register the D-Bus method via the static configureMembers API.
WindowTrackerInterface.configureMembers({
  methods: {
    WindowActivated: {
      inSignature: "sssi",
      outSignature: "",
    },
  },
});

/**
 * Watcher that bridges KWin window activation events to desktop-wakatime
 * via a D-Bus service + KWin scripting API.
 */
export class KdeWaylandWatcher {
  private bus: dbus.MessageBus | null = null;
  private scriptId: number | null = null;
  private tmpDir: string | null = null;
  private scriptingIface: dbus.ClientInterface | null = null;
  private callback: ((info: WindowInfo) => void) | null = null;

  /**
   * Start listening for window activation events.
   *
   * 1. Set up a D-Bus service to receive events from KWin
   * 2. Load a KWin script into the compositor that emits those events
   */
  async start(callback: (info: WindowInfo) => void): Promise<void> {
    this.callback = callback;

    try {
      // --- D-Bus service ---------------------------------------------------
      this.bus = dbus.sessionBus();

      await this.bus.requestName(DBUS_SERVICE_NAME, 0);

      const iface = new WindowTrackerInterface(DBUS_INTERFACE_NAME);
      iface.onWindowActivated = (
        title: string,
        appId: string,
        resourceName: string,
        pid: number,
      ) => {
        try {
          const windowInfo = buildWindowInfo(title, appId, resourceName, pid);
          if (this.callback) {
            this.callback(windowInfo);
          }
        } catch (err) {
          console.error("[kde-wayland] Error in WindowActivated handler:", err);
        }
      };

      this.bus.export(DBUS_OBJECT_PATH, iface);

      // --- KWin script ------------------------------------------------------
      this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wakatime-kwin-"));
      const scriptFile = path.join(this.tmpDir, "kwin-script.js");
      fs.writeFileSync(scriptFile, KWIN_ACTIVATE_SCRIPT, "utf-8");

      const kwinProxy = await this.bus.getProxyObject(
        "org.kde.KWin",
        "/Scripting",
      );
      this.scriptingIface = kwinProxy.getInterface("org.kde.kwin.Scripting");

      this.scriptId = await this.scriptingIface.loadScript(
        scriptFile,
        KWIN_SCRIPT_NAME,
      );

      // Run the script
      const scriptProxy = await this.bus.getProxyObject(
        "org.kde.KWin",
        `/Scripting/Script${this.scriptId}`,
      );
      const scriptIface = scriptProxy.getInterface("org.kde.kwin.Script");
      await scriptIface.run();
    } catch (err) {
      console.error("[kde-wayland] Failed to start watcher:", err);
      // Clean up partial state
      await this.stop();
      throw err;
    }
  }

  /**
   * Stop the watcher: unload the KWin script, release D-Bus name, clean up.
   */
  async stop(): Promise<void> {
    try {
      if (this.scriptingIface && this.scriptId !== null) {
        try {
          await this.scriptingIface.unloadScript(KWIN_SCRIPT_NAME);
        } catch (err) {
          console.error("[kde-wayland] Error unloading KWin script:", err);
        }
        this.scriptId = null;
      }
    } catch {
      // ignore
    }

    if (this.tmpDir) {
      try {
        fs.rmSync(this.tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      this.tmpDir = null;
    }

    if (this.bus) {
      try {
        await this.bus.releaseName(DBUS_SERVICE_NAME);
      } catch {
        // ignore
      }
      try {
        this.bus.disconnect();
      } catch {
        // ignore
      }
      this.bus = null;
    }

    this.scriptingIface = null;
    this.callback = null;
  }

  /**
   * Enumerate all open windows by loading a temporary KWin script
   * that iterates workspace.windowList() and reports each via D-Bus.
   */
  async getOpenWindows(): Promise<WindowInfo[]> {
    if (!this.bus || !this.scriptingIface) {
      return [];
    }

    const collected: WindowInfo[] = [];
    const prevCallback = this.callback;

    return new Promise<WindowInfo[]>((resolve) => {
      let listTmpDir: string | null = null;

      const cleanup = async () => {
        this.callback = prevCallback;
        try {
          if (this.scriptingIface) {
            await this.scriptingIface.unloadScript("wakatime-list-windows");
          }
        } catch {
          // ignore
        }
        if (listTmpDir) {
          try {
            fs.rmSync(listTmpDir, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }
      };

      const timeout = setTimeout(async () => {
        await cleanup();
        resolve(collected);
      }, 500);

      // Temporarily replace callback to collect results
      this.callback = (info: WindowInfo) => {
        collected.push(info);
        if (prevCallback) {
          prevCallback(info);
        }
      };

      (async () => {
        try {
          listTmpDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "wakatime-kwin-list-"),
          );
          const scriptFile = path.join(listTmpDir, "kwin-list.js");
          fs.writeFileSync(scriptFile, KWIN_LIST_WINDOWS_SCRIPT, "utf-8");

          const scriptId = await this.scriptingIface!.loadScript(
            scriptFile,
            "wakatime-list-windows",
          );

          const scriptProxy = await this.bus!.getProxyObject(
            "org.kde.KWin",
            `/Scripting/Script${scriptId}`,
          );
          const scriptIface = scriptProxy.getInterface("org.kde.kwin.Script");
          await scriptIface.run();
        } catch (err) {
          console.error("[kde-wayland] Error listing open windows:", err);
          clearTimeout(timeout);
          await cleanup();
          resolve(collected);
        }
      })();
    });
  }
}
