/** Table rendering modes used when markdown tables need plaintext-safe output. */
export const MARKDOWN_TABLE_MODES = ["off", "bullets", "code", "block"] as const;
export type MarkdownTableMode = (typeof MARKDOWN_TABLE_MODES)[number];
