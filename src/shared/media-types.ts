export type NormalizedMediaAttachment = {
  filename?: string;
  contentType?: string;
  buffer: Buffer;
};

/**
 * Canonical `media` facts for the inbound context, sent next to the legacy
 * `MediaPath`/`MediaPaths` fields. OpenClaw 2026.9.7 merges the two forms by
 * position and lists the legacy fields for removal (`media-legacy-projection`,
 * target 2026-10-01); 2026.7.1-2 has no `media` key and ignores it. Returned as
 * a spread so 2026.7.1-2's context type does not reject the extra key.
 */
export function inboundMediaFacts(
  entries: ReadonlyArray<{ path?: string; contentType?: string }>,
): { media?: Array<{ path: string; url: string; contentType?: string }> } {
  const media = entries.flatMap((entry) =>
    entry.path
      ? [{ path: entry.path, url: entry.path, ...(entry.contentType ? { contentType: entry.contentType } : {}) }]
      : [],
  );
  return media.length > 0 ? { media } : {};
}
