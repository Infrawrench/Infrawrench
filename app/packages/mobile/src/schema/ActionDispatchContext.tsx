import { createContext, useContext } from "react";
import { Alert, Linking } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { HostAction } from "@infrawrench/plugin-base";

/**
 * Replaces the web renderer's DOM CustomEvent dispatch: schema `action` nodes
 * call `dispatch(action)`, and the resource-detail screen provides handlers
 * for the resource-bound actions (reroll, plugin-action, refresh, …).
 * `open-url` and `copy-to-clipboard`-by-value work anywhere.
 */

export interface ActionHandlers {
  /** Resolve a fieldKey to its (secret) value for copy-to-clipboard. */
  resolveFieldValue?: (fieldKey: string) => Promise<string | null>;
  rerollSecret?: (fieldKey: string) => Promise<void>;
  rerollParentOutput?: (outputKey: string) => Promise<void>;
  navigateToResource?: (target: {
    pluginId: string;
    resourceTypeId: string;
    resourceId: string;
  }) => void;
  refreshResource?: () => void;
  invokePluginAction?: (actionId: string, successMessage?: string) => Promise<void>;
  promptNoSqlCommand?: (action: Extract<HostAction, { type: "prompt-nosql-command" }>) => void;
}

const ActionContext = createContext<ActionHandlers>({});

export const ActionDispatchProvider = ActionContext.Provider;

export function useActionDispatch(): (action: HostAction) => void {
  const handlers = useContext(ActionContext);

  return (action: HostAction) => {
    const run = async () => {
      switch (action.type) {
        case "open-url":
          await Linking.openURL(action.url);
          break;
        case "copy-to-clipboard": {
          const value = await handlers.resolveFieldValue?.(action.fieldKey);
          if (value != null) {
            await Clipboard.setStringAsync(value);
            Alert.alert("Copied", "Value copied to clipboard.");
          }
          break;
        }
        case "reroll-secret":
          confirmThen("Reroll this secret? Existing credentials stop working.", () =>
            handlers.rerollSecret?.(action.fieldKey),
          );
          break;
        case "reroll-parent-output":
          confirmThen(
            action.confirmMessage ?? "Reissue this credential from its source resource?",
            () => handlers.rerollParentOutput?.(action.outputKey),
          );
          break;
        case "navigate-to-resource":
          handlers.navigateToResource?.(action);
          break;
        case "refresh-resource":
          handlers.refreshResource?.();
          break;
        case "plugin-action": {
          const invoke = () =>
            handlers.invokePluginAction?.(action.actionId, action.successMessage);
          if (action.confirmMessage) confirmThen(action.confirmMessage, invoke);
          else void invoke()?.catch(showError);
          break;
        }
        case "prompt-nosql-command":
          handlers.promptNoSqlCommand?.(action);
          break;
      }
    };
    void run().catch(showError);
  };
}

function showError(e: unknown) {
  Alert.alert("Action failed", e instanceof Error ? e.message : String(e));
}

function confirmThen(message: string, fn: (() => Promise<void> | void) | undefined) {
  Alert.alert("Confirm", message, [
    { text: "Cancel", style: "cancel" },
    {
      text: "Continue",
      style: "destructive",
      onPress: () => void Promise.resolve(fn?.()).catch(showError),
    },
  ]);
}
