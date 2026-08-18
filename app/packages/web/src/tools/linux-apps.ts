/**
 * Driving a resource's Linux desktop applications as agent tools.
 *
 * The host streams one app window per session; these tools let the model
 * launch an application, see it (a screenshot the model can look at, or the
 * accessibility tree a screen reader would read), and act on it (click, type,
 * scroll, keys). Everything reaches customer infrastructure and synthesises
 * input, so they carry `resources:execute` — the same permission the SSH
 * terminal and `ssh_exec` need — and are audit-logged.
 *
 * A window is addressed by its numeric id, which `launch_app` and
 * `list_app_windows` return; the coordinates a screenshot shows, a click
 * takes, and the accessibility tree reports are the same buffer-pixel space.
 */
import { z } from "zod";
import type { A11yNode } from "@infrawrench/appstream-core";

import { getHeadlessSession, endHeadlessSession, AppsHostError } from "@/services/apps-headless";
import { logAudit } from "@/services/audit";
import { ok, okImage, okText, err, type ToolAuthContext, type ToolDefinition } from "./types";

const PERMISSION = "resources:execute" as const;

function sessionRef(
  resourceId: string,
  auth: ToolAuthContext,
  extra: { sshKeyId?: string | undefined; username?: string | undefined },
) {
  return {
    organizationId: auth.organizationId,
    resourceId,
    ...(auth.userId ? { userId: auth.userId } : {}),
    ...(extra.sshKeyId ? { sshKeyId: extra.sshKeyId } : {}),
    ...(extra.username ? { username: extra.username } : {}),
  };
}

/** Turn a host error into a tool error the model can act on, not a stack. */
function toErr(error: unknown): ReturnType<typeof err> {
  if (error instanceof AppsHostError) return err(error.message);
  return err(error instanceof Error ? error.message : String(error));
}

/** Strip the tree to the fields worth spending tokens on, keeping structure. */
function trimTree(node: A11yNode): Record<string, unknown> {
  const out: Record<string, unknown> = { role: node.role };
  if (node.name) out["name"] = node.name;
  if (node.description) out["description"] = node.description;
  if (node.text) out["text"] = node.text;
  if (node.value !== undefined) out["value"] = node.value;
  if (node.states && node.states.length) out["states"] = node.states;
  if (node.bounds) {
    out["bounds"] = node.bounds;
    out["center"] = {
      x: node.bounds.x + Math.floor(node.bounds.width / 2),
      y: node.bounds.y + Math.floor(node.bounds.height / 2),
    };
  }
  if (node.actions && node.actions.length) out["actions"] = node.actions;
  if (node.children && node.children.length) out["children"] = node.children.map(trimTree);
  return out;
}

const targetShape = {
  resourceId: z.string().describe("The resource whose host runs the applications."),
  sshKeyId: z
    .string()
    .optional()
    .describe(
      "Org SSH key id (see list_ssh_keys). Required for VM resources; omit for hosts whose plugin supplies SSH natively (Fly, Hetzner).",
    ),
  username: z.string().optional().describe("SSH login, if not the resource's default."),
};

export function linuxAppTools(): ToolDefinition[] {
  return [
    {
      name: "list_apps_on_host",
      title: "List host applications",
      description:
        "List the graphical applications installed on a resource's host, as launchable {id, name}. The host provides the applications; Infrawrench brings the display.",
      inputSchema: { ...targetShape },
      risk: "read",
      permission: PERMISSION,
      handler: async (input, auth) => {
        const { resourceId, sshKeyId, username } = input as {
          resourceId: string;
          sshKeyId?: string;
          username?: string;
        };
        try {
          const client = await getHeadlessSession(
            sessionRef(resourceId, auth, { sshKeyId, username }),
          );
          const apps = await client.listApps();
          return ok(
            apps
              .filter((app) => !app.needsTerminal)
              .map((app) => ({ id: app.id, name: app.name, comment: app.comment })),
          );
        } catch (error) {
          return toErr(error);
        }
      },
    },

    {
      name: "launch_app",
      title: "Launch an application",
      description:
        "Launch a graphical application on the host and return its window (windowId, title, size). Pass appId from list_apps_on_host, or exec for a raw command. The window is streaming and ready to screenshot or act on.",
      inputSchema: {
        ...targetShape,
        appId: z.string().optional().describe("Desktop-entry id from list_apps_on_host."),
        exec: z.string().optional().describe("A raw command, when no desktop entry fits."),
      },
      risk: "write",
      permission: PERMISSION,
      handler: async (input, auth) => {
        const { resourceId, sshKeyId, username, appId, exec } = input as {
          resourceId: string;
          sshKeyId?: string;
          username?: string;
          appId?: string;
          exec?: string;
        };
        if (!appId && !exec) return err("Pass appId (from list_apps_on_host) or exec.");
        try {
          const client = await getHeadlessSession(
            sessionRef(resourceId, auth, { sshKeyId, username }),
          );
          const target: { appId?: string; exec?: string } = {};
          if (appId) target.appId = appId;
          if (exec) target.exec = exec;
          const window = await client.launch(target);
          void logAudit({
            organizationId: auth.organizationId,
            ...(auth.userId ? { userId: auth.userId } : {}),
            action: "linux_app.launch",
            entityType: "resource",
            entityId: resourceId,
            metadata: { appId, exec, windowId: window.windowId, source: auth.source },
          });
          return ok({
            windowId: window.windowId,
            title: window.title,
            width: window.width,
            height: window.height,
          });
        } catch (error) {
          return toErr(error);
        }
      },
    },

    {
      name: "list_app_windows",
      title: "List open app windows",
      description:
        "List the windows currently open in the resource's app session, with their ids and titles.",
      inputSchema: { ...targetShape },
      risk: "read",
      permission: PERMISSION,
      handler: async (input, auth) => {
        const { resourceId, sshKeyId, username } = input as {
          resourceId: string;
          sshKeyId?: string;
          username?: string;
        };
        try {
          const client = await getHeadlessSession(
            sessionRef(resourceId, auth, { sshKeyId, username }),
          );
          return ok(
            client.windows().map((w) => ({
              windowId: w.windowId,
              title: w.title,
              width: w.width,
              height: w.height,
              ...(w.parentWindowId !== undefined ? { parentWindowId: w.parentWindowId } : {}),
            })),
          );
        } catch (error) {
          return toErr(error);
        }
      },
    },

    {
      name: "screenshot_app_window",
      title: "Screenshot an app window",
      description:
        "Capture a window as a PNG the model can see. Waits for the window to finish repainting first, so the shot reflects the latest action. Pixel coordinates in the image match those click_app_window and the accessibility tree use.",
      inputSchema: {
        ...targetShape,
        windowId: z.number().int().describe("Window id from launch_app or list_app_windows."),
      },
      risk: "read",
      permission: PERMISSION,
      handler: async (input, auth) => {
        const { resourceId, sshKeyId, username, windowId } = input as {
          resourceId: string;
          sshKeyId?: string;
          username?: string;
          windowId: number;
        };
        try {
          const client = await getHeadlessSession(
            sessionRef(resourceId, auth, { sshKeyId, username }),
          );
          const shot = await client.screenshot(windowId);
          return okImage(
            shot.png.toString("base64"),
            "image/png",
            `Window ${windowId}, ${shot.width}×${shot.height}px.`,
          );
        } catch (error) {
          return toErr(error);
        }
      },
    },

    {
      name: "read_app_accessibility_tree",
      title: "Read a window's accessibility tree",
      description:
        "Read a window's accessibility tree — what a screen reader would see: every element's role, name, text, state, and on-screen bounds. Each element with bounds carries a `center` you can pass straight to click_app_window. Cheaper and more reliable than reading a screenshot when the app exposes accessibility (most GTK/Qt apps do).",
      inputSchema: {
        ...targetShape,
        windowId: z.number().int().describe("Window id from launch_app or list_app_windows."),
      },
      risk: "read",
      permission: PERMISSION,
      handler: async (input, auth) => {
        const { resourceId, sshKeyId, username, windowId } = input as {
          resourceId: string;
          sshKeyId?: string;
          username?: string;
          windowId: number;
        };
        try {
          const client = await getHeadlessSession(
            sessionRef(resourceId, auth, { sshKeyId, username }),
          );
          const result = await client.a11yTree(windowId);
          return ok({
            ...(result.caveat ? { note: result.caveat } : {}),
            tree: trimTree(result.tree),
          });
        } catch (error) {
          return toErr(error);
        }
      },
    },

    {
      name: "click_app_window",
      title: "Click in an app window",
      description:
        "Click at a pixel position in a window — the same coordinate space as a screenshot and the accessibility tree's `center`. Optionally right/middle button, or a double-click.",
      inputSchema: {
        ...targetShape,
        windowId: z.number().int(),
        x: z.number().int().describe("X in window pixels."),
        y: z.number().int().describe("Y in window pixels."),
        button: z.enum(["left", "right", "middle"]).optional(),
        doubleClick: z.boolean().optional(),
      },
      risk: "write",
      permission: PERMISSION,
      handler: async (input, auth) => {
        const { resourceId, sshKeyId, username, windowId, x, y, button, doubleClick } = input as {
          resourceId: string;
          sshKeyId?: string;
          username?: string;
          windowId: number;
          x: number;
          y: number;
          button?: "left" | "right" | "middle";
          doubleClick?: boolean;
        };
        try {
          const client = await getHeadlessSession(
            sessionRef(resourceId, auth, { sshKeyId, username }),
          );
          client.click(windowId, x, y, {
            ...(button ? { button } : {}),
            ...(doubleClick ? { clicks: 2 } : {}),
          });
          return okText(
            `Clicked ${button ?? "left"} at ${x},${y}${doubleClick ? " (double)" : ""}.`,
          );
        } catch (error) {
          return toErr(error);
        }
      },
    },

    {
      name: "type_in_app_window",
      title: "Type into an app window",
      description:
        "Type text into the window's focused widget, character by character — click or tab to the field first. Handles any character a keyboard could produce, including accented ones.",
      inputSchema: {
        ...targetShape,
        windowId: z.number().int(),
        text: z.string().describe("The literal text to type."),
      },
      risk: "write",
      permission: PERMISSION,
      handler: async (input, auth) => {
        const { resourceId, sshKeyId, username, windowId, text } = input as {
          resourceId: string;
          sshKeyId?: string;
          username?: string;
          windowId: number;
          text: string;
        };
        try {
          const client = await getHeadlessSession(
            sessionRef(resourceId, auth, { sshKeyId, username }),
          );
          client.typeText(windowId, text);
          return okText(`Typed ${text.length} character(s).`);
        } catch (error) {
          return toErr(error);
        }
      },
    },

    {
      name: "press_keys_in_app_window",
      title: "Press a key combination",
      description:
        'Press a key or chord in a window, e.g. "Enter", "Tab", "Escape", "ctrl+s", "ctrl+shift+t", "alt+F4". The last token is the key; earlier tokens are modifiers (ctrl, shift, alt, meta).',
      inputSchema: {
        ...targetShape,
        windowId: z.number().int(),
        keys: z.string().describe('A key or "+"-joined chord.'),
      },
      risk: "write",
      permission: PERMISSION,
      handler: async (input, auth) => {
        const { resourceId, sshKeyId, username, windowId, keys } = input as {
          resourceId: string;
          sshKeyId?: string;
          username?: string;
          windowId: number;
          keys: string;
        };
        try {
          const client = await getHeadlessSession(
            sessionRef(resourceId, auth, { sshKeyId, username }),
          );
          client.pressKeys(windowId, keys);
          return okText(`Pressed ${keys}.`);
        } catch (error) {
          return toErr(error);
        }
      },
    },

    {
      name: "scroll_app_window",
      title: "Scroll in an app window",
      description:
        "Scroll by wheel notches at a position. Positive notches scroll down (or right, with horizontal:true), like a mouse wheel.",
      inputSchema: {
        ...targetShape,
        windowId: z.number().int(),
        x: z.number().int(),
        y: z.number().int(),
        notches: z.number().int().describe("Wheel notches; positive scrolls down/right."),
        horizontal: z.boolean().optional(),
      },
      risk: "write",
      permission: PERMISSION,
      handler: async (input, auth) => {
        const { resourceId, sshKeyId, username, windowId, x, y, notches, horizontal } = input as {
          resourceId: string;
          sshKeyId?: string;
          username?: string;
          windowId: number;
          x: number;
          y: number;
          notches: number;
          horizontal?: boolean;
        };
        try {
          const client = await getHeadlessSession(
            sessionRef(resourceId, auth, { sshKeyId, username }),
          );
          client.scroll(windowId, x, y, notches, { ...(horizontal ? { horizontal } : {}) });
          return okText(`Scrolled ${notches} notch(es).`);
        } catch (error) {
          return toErr(error);
        }
      },
    },

    {
      name: "close_app_window",
      title: "Close an app window",
      description:
        "Ask a window to close (the app may prompt to save). Set endSession:true instead to close every window and stop the whole app session on the host.",
      inputSchema: {
        ...targetShape,
        windowId: z
          .number()
          .int()
          .optional()
          .describe("The window to close; omit with endSession."),
        endSession: z.boolean().optional().describe("Close everything and end the host session."),
      },
      risk: "write",
      permission: PERMISSION,
      handler: async (input, auth) => {
        const { resourceId, sshKeyId, username, windowId, endSession } = input as {
          resourceId: string;
          sshKeyId?: string;
          username?: string;
          windowId?: number;
          endSession?: boolean;
        };
        try {
          if (endSession) {
            const had = endHeadlessSession(auth.organizationId, resourceId);
            return okText(had ? "Ended the app session." : "No app session was open.");
          }
          if (windowId === undefined) return err("Pass windowId, or endSession:true.");
          const client = await getHeadlessSession(
            sessionRef(resourceId, auth, { sshKeyId, username }),
          );
          client.closeWindow(windowId);
          return okText(`Asked window ${windowId} to close.`);
        } catch (error) {
          return toErr(error);
        }
      },
    },
  ];
}
