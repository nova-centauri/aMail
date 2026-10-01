import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_STAGE_MAX_BYTES,
  attachmentDownloadKey,
  beginDownload,
  canStageAttachment,
  createDownloadLane,
  runWithConcurrency,
  stageableAttachments,
} from './attachment-download.js';

describe('createDownloadLane', () => {
  it('runs one task while a download for that attachment is in flight', async () => {
    const lane = createDownloadLane();
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const task = () => {
      calls += 1;
      return gate;
    };
    const first = lane.start('message:0', task);
    const second = lane.start('message:0', task);
    expect(calls).toBe(1);
    expect(lane.has('message:0')).toBe(true);
    release('saved');
    await expect(Promise.all([first, second])).resolves.toEqual(['saved', 'saved']);
    expect(lane.has('message:0')).toBe(false);
  });

  it('starts again after the in-flight download finishes or fails', async () => {
    const lane = createDownloadLane();
    let calls = 0;
    const task = () => {
      calls += 1;
      return Promise.resolve(calls);
    };
    await expect(lane.start('message:1', task)).resolves.toBe(1);
    await expect(lane.start('message:1', () => Promise.reject(new Error('failed')))).rejects.toThrow('failed');
    await expect(lane.start('message:1', task)).resolves.toBe(2);
    expect(calls).toBe(2);
  });

  it('ignores a repeat click while the same key is busy', () => {
    const busy = new Set();
    expect(beginDownload(busy, 'message:0')).toBe(true);
    expect(beginDownload(busy, 'message:0')).toBe(false);
    busy.delete('message:0');
    expect(beginDownload(busy, 'message:0')).toBe(true);
  });
});

describe('stageableAttachments', () => {
  it('stages only the open message attachments under the size cap', () => {
    const items = stageableAttachments([
      {
        id: 'open-message',
        attachments: [
          { url: '/api/content/attachment?token=a', size: 1200, index: 0 },
          { url: '/api/content/attachment?token=b', size: ATTACHMENT_STAGE_MAX_BYTES + 1, index: 1 },
          { name: 'no-url.pdf', size: 40, index: 2 },
        ],
      },
      {
        id: 'also-open',
        attachments: [{ url: '/api/content/attachment?token=c', size: '2048', index: 0 }],
      },
    ]);
    expect(items.map((item) => item.key)).toEqual([
      attachmentDownloadKey('open-message', { index: 0 }, 0),
      attachmentDownloadKey('also-open', { index: 0 }, 0),
    ]);
    expect(canStageAttachment({ url: '/file', size: '124 KB' })).toBe(true);
    expect(canStageAttachment({ preview: true, name: 'invoice.pdf' })).toBe(false);
  });

  it('caps how many attachment fetches run at once', async () => {
    let active = 0;
    let maxActive = 0;
    const items = [1, 2, 3, 4];
    await runWithConcurrency(items, 2, () => new Promise((resolve) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        active -= 1;
        resolve();
      }, 15);
    }));
    expect(maxActive).toBe(2);
  });
});
