import { describe, expect, it } from 'vitest';
import {
  AdapterFrameDecoder,
  AdapterFrameError,
  encodeAdapterFrame,
} from '../../../src/adapter/ipc/framing';
import { MAX_ADAPTER_FRAME_BYTES } from '../../../src/adapter/ipc/protocol';

describe('Adapter IPC framing', () => {
  it('decodes fragmented and coalesced uint32-LE JSON frames', () => {
    const hello = encodeAdapterFrame({
      type: 'hello',
      token: 'a'.repeat(64),
      protocolVersion: 1,
      projectHash: 'b'.repeat(64),
    });
    const event = encodeAdapterFrame({
      type: 'event',
      capability: 'material-context',
      event: 'selection-changed',
    });
    const bytes = Buffer.concat([hello, event]);
    const decoder = new AdapterFrameDecoder();

    expect(decoder.push(bytes.subarray(0, 2))).toEqual([]);
    expect(decoder.push(bytes.subarray(2, hello.byteLength + 3))).toEqual([
      {
        type: 'hello',
        token: 'a'.repeat(64),
        protocolVersion: 1,
        projectHash: 'b'.repeat(64),
      },
    ]);
    expect(decoder.push(bytes.subarray(hello.byteLength + 3))).toEqual([
      {
        type: 'event',
        capability: 'material-context',
        event: 'selection-changed',
      },
    ]);
  });

  it('rejects zero and oversized frames before reading a payload', () => {
    for (const length of [0, MAX_ADAPTER_FRAME_BYTES + 1]) {
      const frame = Buffer.alloc(4);
      frame.writeUInt32LE(length);
      expect(() => new AdapterFrameDecoder().push(frame))
        .toThrow(AdapterFrameError);
    }
  });

  it('rejects non-object JSON payloads', () => {
    const bytes = Buffer.from('null', 'utf8');
    const frame = Buffer.alloc(4 + bytes.byteLength);
    frame.writeUInt32LE(bytes.byteLength);
    bytes.copy(frame, 4);

    expect(() => new AdapterFrameDecoder().push(frame))
      .toThrow('must contain a JSON object');
  });
});
