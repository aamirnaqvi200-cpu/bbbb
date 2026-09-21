type Task = () => Promise<void>;
// Returns true if the tile this task belongs to is no longer worth running
// (e.g. it's been scrolled out of view while it was still waiting its turn).
type StaleCheck = () => boolean;

interface QueueItem {
  task: Task;
  isStale: StaleCheck;
}

const isMobileDevice =
  typeof window !== 'undefined' && window.innerWidth < 768;

class VideoAutoplayQueue {
  private queue: QueueItem[] = [];
  private isProcessing = false;
  private delay = isMobileDevice ? 400 : 250;

  private loadQueue: QueueItem[] = [];
  private isLoadProcessing = false;
  private loadDelay = isMobileDevice ? 120 : 50;

  private audibleVideo: HTMLVideoElement | null = null;

  add(playFunction: Task, isStale: StaleCheck = () => false) {
    this.queue.push({ task: playFunction, isStale });
    if (!this.isProcessing) {
      this.process();
    }
  }

  addLoad(loadFunction: Task, isStale: StaleCheck = () => false) {
    this.loadQueue.push({ task: loadFunction, isStale });
    if (!this.isLoadProcessing) {
      this.processLoad();
    }
  }

  private async process() {
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item) {
        // Skip work for tiles that have already scrolled away while they
        // were waiting in line — running it anyway is exactly what used to
        // leave invisible videos playing in the background.
        if (!item.isStale()) {
          try {
            await item.task();
          } catch (error) {
            console.error('Error in autoplay queue:', error);
          }
          await new Promise(resolve => setTimeout(resolve, this.delay));
        }
      }
    }

    this.isProcessing = false;
  }

  private async processLoad() {
    this.isLoadProcessing = true;

    while (this.loadQueue.length > 0) {
      const item = this.loadQueue.shift();
      if (item) {
        if (!item.isStale()) {
          try {
            await item.task();
          } catch (error) {
            console.error('Error in load queue:', error);
          }
          await new Promise(resolve => setTimeout(resolve, this.loadDelay));
        }
      }
    }

    this.isLoadProcessing = false;
  }

  requestAudio(video: HTMLVideoElement) {
    if (this.audibleVideo && this.audibleVideo !== video && !this.audibleVideo.paused) {
      this.audibleVideo.muted = true;
    }
    this.audibleVideo = video;
  }

  // Call when a video is muted, paused, ended, or unmounted. Only clears
  // the slot if this video is the one currently holding it, so releasing a
  // video that already lost the slot to a newer one is a harmless no-op.
  releaseAudio(video: HTMLVideoElement) {
    if (this.audibleVideo === video) {
      this.audibleVideo = null;
    }
  }

  setDelay(ms: number) {
    this.delay = ms;
  }

  setLoadDelay(ms: number) {
    this.loadDelay = ms;
  }

}

export const videoAutoplayQueue = new VideoAutoplayQueue();
