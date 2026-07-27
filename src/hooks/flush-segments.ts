export interface SegmentSink {
  pushIngestQueue(transcript: string, meta: object): Promise<void>;
}

export interface FlushMeta {
  readonly project: string;
  readonly branch: string;
  readonly sessionId: string;
  readonly baseSegment: number;
}

/**
 * Push tail segments to the ingest queue, numbering them after the segments
 * the Stop hook already queued. Swallows a mid-loop failure and reports how
 * far it got: SessionEnd fires exactly once, so an escaped exception here
 * would skip both the drain spawn and cleanup, stranding everything already
 * queued this session.
 */
export async function flushSegments(
  client: SegmentSink,
  segments: readonly string[],
  meta: FlushMeta,
): Promise<{ pushed: number; failed: boolean }> {
  let pushed = 0;
  for (const segment of segments) {
    try {
      await client.pushIngestQueue(segment, {
        project: meta.project,
        branch: meta.branch,
        timestamp: new Date().toISOString(),
        sessionId: meta.sessionId,
        segment: meta.baseSegment + pushed,
      });
    } catch (err) {
      console.error(
        `[betterdb] flush failed after ${pushed}/${segments.length} segments:`,
        err instanceof Error ? err.message : String(err),
      );
      return { pushed, failed: true };
    }
    pushed++;
  }
  return { pushed, failed: false };
}
