import {
  MAX_ADAPTER_FRAME_BYTES,
  type AdapterProtocolMessage,
} from './protocol';

export class AdapterFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterFrameError';
  }
}

/** Encode one JSON message with ADR-0008's uint32-LE byte-length prefix. */
export function encodeAdapterFrame(message: AdapterProtocolMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.byteLength === 0 || payload.byteLength > MAX_ADAPTER_FRAME_BYTES) {
    throw new AdapterFrameError(
      `Adapter frame length ${payload.byteLength} is outside the allowed range`,
    );
  }
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32LE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

/**
 * Incremental decoder for arbitrarily fragmented/coalesced stream chunks.
 * Invalid length or JSON terminates the owning connection.
 */
export class AdapterFrameDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Uint8Array): AdapterProtocolMessage[] {
    if (chunk.byteLength > 0) {
      this.buffered = this.buffered.byteLength === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buffered, chunk]);
    }

    const messages: AdapterProtocolMessage[] = [];
    while (this.buffered.byteLength >= 4) {
      const length = this.buffered.readUInt32LE(0);
      if (length === 0 || length > MAX_ADAPTER_FRAME_BYTES) {
        throw new AdapterFrameError(
          `Adapter frame length ${length} is outside the allowed range`,
        );
      }
      if (this.buffered.byteLength < 4 + length) break;

      const payload = this.buffered.subarray(4, 4 + length);
      this.buffered = this.buffered.subarray(4 + length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.toString('utf8'));
      } catch {
        throw new AdapterFrameError('Adapter frame is not valid UTF-8 JSON');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new AdapterFrameError('Adapter frame must contain a JSON object');
      }
      messages.push(parsed as AdapterProtocolMessage);
    }
    return messages;
  }
}
