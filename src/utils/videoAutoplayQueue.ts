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

// Phones have a hard, low ceiling on how many <video> elements can be
// actively decoding at once (typically low single digits) before playback
// starts glitching or the tab/browser gets killed outright. Desktops have
// far more headroom, so the cap there mainly guards against pathological
// cases (e.g. a very wide, multi-column grid with several rows in view).
const DEFAULT_MAX_CONCURRENT = isMobileDevice ? 2 : 6;

class VideoAutoplayQueue {
  private queue: QueueItem[] = [];
  private isProcessing = false;
  private delay = isMobileDevice ? 400 : 250;

  private loadQueue: QueueItem[] = [];
  private isLoadProcessing = false;
  private loadDelay = isMobileDevice ? 120 : 50;

  // Videos currently allowed to be playing, oldest first. Used to enforce
  // a hard cap on simultaneous decoders — the actual source of the mobile
  // crashes/glitches, since without a cap a fast scroll can leave many
  // off-screen videos quietly still playing in the background.
  //
  // Only autoplaying grid tiles are registered here (see VideoThumbnail,
  // which skips register/unregisterActive for the showreel). The showreel
  // is started by an explicit click, not autoplay, so it must never be
  // silently paused just because several grid tiles happened to come into
  // view around the same time.
  private activeVideos: HTMLVideoElement[] = [];
  private maxConcurrent = DEFAULT_MAX_CONCURRENT;

  // The one video (if any) currently allowed to play with sound. Unmuting a
  // tile calls requestAudio, which mutes whichever tile previously held
  // this slot — otherwise scrolling past an unmuted tile, or unmuting a
  // second one, would stack multiple audible videos at once.
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

  // Call once a video actually starts playing. Enforces maxConcurrent by
  // pausing the least-recently-activated video(s) over the cap. Pausing
  // fires that video's own onPause handler, which keeps its component
  // state (isPlaying, etc.) in sync automatically.
  registerActive(video: HTMLVideoElement) {
    this.activeVideos = this.activeVideos.filter(v => v !== video);
    this.activeVideos.push(video);
    while (this.activeVideos.length > this.maxConcurrent) {
      const victim = this.activeVideos.shift();
      if (victim && victim !== video && !victim.paused) {
        victim.pause();
      }
    }
  }

  unregisterActive(video: HTMLVideoElement) {
    this.activeVideos = this.activeVideos.filter(v => v !== video);
  }

  // Call when a video becomes unmuted (or starts playing already unmuted,
  // e.g. the showreel). Mutes whichever other video previously held the
  // "audible" slot, then claims it for this one.
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

  setMaxConcurrent(n: number) {
    this.maxConcurrent = n;
  }
}

export const videoAutoplayQueue = new VideoAutoplayQueue();
