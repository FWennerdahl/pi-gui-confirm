/**
 * Bash Summary: replaces the built-in bash tool with one that also takes a short `summary` of what the
 * command does. pi-gui-confirm.ts shows it as the approval dialog's title, above the exact command.
 * Kept separate from pi-gui-confirm.ts so a failure here can't disable the confirmation dialog.
 */
import { createBashTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SUMMARY_DESCRIPTION =
  "Short plain-language summary of what the command does, shown to the user when asking for approval " +
  '(at most about 80 characters, e.g. "List files changed since the last review").';

export default function (pi: ExtensionAPI) {
  const builtin = createBashTool(process.cwd());

  pi.registerTool({
    ...builtin,
    parameters: Type.Object({
      summary: Type.String({ description: SUMMARY_DESCRIPTION }),
      ...builtin.parameters.properties,
    }),
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const { summary: _summary, ...bashParams } = params;
      // Built per call with the session's folder: pi-gui runs threads for several folders in one process.
      return createBashTool(ctx.cwd).execute(toolCallId, bashParams, signal, onUpdate);
    },
  });
}
