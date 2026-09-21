// Thumbnails are small static jpgs, not video decoders, so — unlike the
// video queue — a little concurrency here is cheap and just makes the grid
// fill in faster instead of one tile waiting behind every tile before it.
const MAX_PARALLEL =
  typeof window !== 'undefined' && window.innerWidth < 768 ? 3 : 6;

class ThumbnailLoadQueue {
  private queue: Array<() => Promise<void>> = [];
  private activeCount = 0;

  async add(loadFunction: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          await loadFunction();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      this.pump();
    });
  }

  private pump() {
    while (this.activeCount < MAX_PARALLEL && this.queue.length > 0) {
      const loadFunction = this.queue.shift();
      if (!loadFunction) continue;
      this.activeCount++;
      loadFunction().finally(() => {
        this.activeCount--;
        this.pump();
      });
    }
  }
}

export const thumbnailLoadQueue = new ThumbnailLoadQueue();
