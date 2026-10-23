import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Chat needs command and welcome copy before opening discovery surfaces.
const enChatDiscovery = {
  chat: {
    welcome: {
      hintBeforeShortcut: "Type a message below ·",
      hintAfterShortcut: "for commands",
      recentSessions: "Recent chats",
      suggestions: {
        whatCanYouDo: en.chat.welcome.suggestions.whatCanYouDo,
        summarizeRecentSessions: "Summarize my recent sessions",
        configureChannel: "Help me configure a channel",
        checkSystemHealth: "Check system health",
      },
    },
    commands: {
      arguments: "Command arguments",
      menu: "Slash commands",
      optionCount: "{count} options",
      clearDescription: "Clear chat history",
      redirectDescription: "Abort and restart with a new message",
      steerDescription: "Inject a message into the active run",
      exportDescription: "Download this conversation as Markdown",
      categories: {
        session: "Session",
        model: "Model",
        agents: "Agents",
        tools: "Tools",
      },
    },
  },
} satisfies TranslationMap;

export const registerChatDiscoveryEnglish = Object.assign(
  () => {
    Object.assign(en.chat.welcome, enChatDiscovery.chat.welcome);
    Object.assign(en.chat.commands, enChatDiscovery.chat.commands);
  },
  { catalog: enChatDiscovery },
);
