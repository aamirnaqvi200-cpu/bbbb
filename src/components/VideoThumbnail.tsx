import React, { useRef, useState, useEffect } from "react";
import { Maximize2, X, Play, Pause, Volume2, VolumeX, ExternalLink } from 'lucide-react';
import { thumbnailLoadQueue } from "../utils/thumbnailLoadQueue";
import { videoAutoplayQueue } from "../utils/videoAutoplayQueue";

// Some browsers (notably Safari on iOS/macOS) cannot decode WebM video at all.
// Detect this once so we can gracefully fall back instead of showing a dead/blank tile.
const canPlayWebm = (() => {
  if (typeof document === 'undefined') return true;
  try {
    const v = document.createElement('video');
    return !!(v.canPlayType && (v.canPlayType('video/webm; codecs="vp9"') || v.canPlayType('video/webm')));
  } catch {
    return true;
  }
})();

interface ThumbnailImageProps {
  src: string; alt: string; isFullscreen: boolean;
  isPlaying: boolean; onLoad: () => void; onError: () => void;
}

function ThumbnailImage({ src, alt, isFullscreen, isPlaying, onLoad, onError }: ThumbnailImageProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  useEffect(() => {
    thumbnailLoadQueue.add(() => new Promise<void>((res, rej) => {
      const img = new Image();
      img.onload = () => { setImageSrc(src); onLoad(); res(); };
      img.onerror = () => { onError(); rej(new Error(`Failed to load thumbnail: ${src}`)); };
      img.src = src;
    })).catch(() => {}); // errors are already surfaced via onError; avoid an unhandled rejection
  }, [src, onLoad, onError]);
  if (!imageSrc) return null;
  return (
    <img src={imageSrc} alt={alt} decoding="async"
      className={`absolute inset-0 w-full h-full ${isFullscreen ? 'object-contain' : 'object-cover'} transition-opacity duration-300 ${isPlaying ? 'opacity-0' : 'opacity-100'}`} />
  );
}

interface VideoThumbnailProps {
  src: string; title: string; aspectRatio?: "video" | "vertical";
  className?: string; isShowreel?: boolean; thumbnailIndex?: number;
  category?: string;
}

export function VideoThumbnail({ src, title, aspectRatio = "video", className = "", isShowreel = false, thumbnailIndex, category }: VideoThumbnailProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isInView, setIsInView] = useState(false);
  const [videoLoaded, setVideoLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [thumbnailLoaded, setThumbnailLoaded] = useState(false);
  const [hasStartedPlaying, setHasStartedPlaying] = useState(false);
  // Showreel is started by an explicit click (a user gesture), so sound is allowed and expected.
  // Grid videos autoplay on scroll with no gesture, so browsers require them to start muted.
  const [isMuted, setIsMuted] = useState(!isShowreel ? true : false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const progressBarRef = useRef<HTMLDivElement>(null);

  // Live mirrors of state read inside the long-lived IntersectionObserver
  // callbacks below. Reading these refs instead of the state variables lets
  // those effects skip isPlaying/isFullscreen/videoLoaded in their
  // dependency arrays, so the observer for a tile is created once and left
  // alone instead of being torn down and recreated on every play/pause —
  // with ~20 tiles on the page, that churn was real, avoidable work on
  // every scroll.
  const isPlayingRef = useRef(isPlaying);
  const isFullscreenRef = useRef(isFullscreen);
  const videoLoadedRef = useRef(videoLoaded);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { isFullscreenRef.current = isFullscreen; }, [isFullscreen]);
  useEffect(() => { videoLoadedRef.current = videoLoaded; }, [videoLoaded]);

  const aspectClasses = aspectRatio === "vertical" ? "aspect-[9/16]" : "aspect-video";
  const getThumbnailPath = () => thumbnailIndex ? `/thumbnails/${thumbnailIndex}.jpg` : null;

  // This particular file is a format the current browser can't decode at all (e.g. WebM on Safari).
  const isUnsupportedFormat = /\.webm(\?|$)/i.test(src) && !canPlayWebm;

  // Tracks whether this tile has ever been loaded, across later unload/
  // reload cycles (a plain ref so it doesn't trigger re-renders itself).
  const hasLoadedOnceRef = useRef(false);

  // Live "is this tile still near the viewport" flag, kept up to date by
  // the IntersectionObservers below. A plain ref (not state) so it can be
  // read synchronously from inside a queued task that may run well after
  // it was scheduled — e.g. the user scrolled straight past this tile
  // during a fast scroll. Without this check, a queued load/play used to
  // fire anyway once its turn came up, silently starting playback on a
  // tile that was no longer even on screen. Multiplied across a fast
  // scroll through the grid, that's what was piling up invisible playing
  // videos in the background and crashing the tab on mobile.
  const nearViewRef = useRef(false);

  const startLoadingAndPlaying = () => {
    if (isShowreel || !videoRef.current) return;
    const isStale = () => !nearViewRef.current;
    videoAutoplayQueue.addLoad(async () => {
      // A manual click (see handleClick) may have already loaded/started this
      // video while it was still waiting its turn in the queue — don't call
      // .load() again, since that would reset an already-playing video.
      if (videoRef.current && !videoRef.current.src) {
        videoRef.current.src = src;
        videoRef.current.muted = true;
        videoRef.current.load();
        hasLoadedOnceRef.current = true;
        setVideoLoaded(true);
      }
    }, isStale);
    videoAutoplayQueue.add(async () => {
      if (videoRef.current && nearViewRef.current) {
        setIsLoading(true);
        try { await videoRef.current.play(); } catch { setIsLoading(false); }
      }
    }, isStale);
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (isUnsupportedFormat) return; // don't even try to load a format this browser can't play

    // Loading (setting .src + calling .load()) used to happen right here, on
    // mount, for every tile — meaning all ~21 grid videos started fetching +
    // decoding at once as soon as the page rendered, regardless of whether
    // they were anywhere near the viewport. That flood of simultaneous
    // video downloads/decoders is what was causing the lag, crashes, and
    // glitches on mobile (phones have far tighter decoder/memory limits
    // than desktop). It's now deferred to this "near viewport" check, so a
    // tile only starts loading once it's actually about to be seen.
    // A smaller margin on mobile means fewer tiles start loading/decoding
    // at once on first paint or a fast scroll — the initial burst of
    // simultaneous video loads was a big part of the original lag.
    const isMobileNow = typeof window !== 'undefined' && window.innerWidth < 768;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setIsInView(true);
        nearViewRef.current = true;
        observer.disconnect();
        startLoadingAndPlaying();
      }
    }, { rootMargin: isMobileNow ? '80px' : '200px', threshold: 0.01 });
    observer.observe(container);
    return () => observer.disconnect();
  }, [isShowreel, src, isUnsupportedFormat]);

  useEffect(() => {
    // The IntersectionObserver above is never created for unsupported formats
    // (it returns early), so isInView would otherwise stay false forever and
    // the thumbnail — our only visible fallback — would never appear.
    if (isUnsupportedFormat) setIsInView(true); // still show the thumbnail even without a playable video
  }, [isUnsupportedFormat]);

  // Pause videos that scroll out of view, and resume (or, if it was fully
  // unloaded by the effect below, reload) them when scrolled back in. On
  // mobile, keeping many videos decoding simultaneously is a primary cause
  // of freezing and crashes, so we free the decoder as soon as the tile
  // leaves the viewport.
  useEffect(() => {
    if (isUnsupportedFormat || isShowreel) return;
    const container = containerRef.current;
    if (!container) return;
    const isMobileNow = typeof window !== 'undefined' && window.innerWidth < 768;
    const visibilityObserver = new IntersectionObserver(([entry]) => {
      // Keep the live "near view" flag in sync — this is what the queue
      // checks before running a still-pending load/play for this tile.
      nearViewRef.current = entry.isIntersecting;

      if (!entry.isIntersecting && videoRef.current && !isFullscreenRef.current) {
        videoRef.current.pause();
        setIsPlaying(false);
      } else if (entry.isIntersecting && videoRef.current && !isPlayingRef.current && !isFullscreenRef.current) {
        if (videoLoadedRef.current) {
          // Resume autoplay when scrolled back into view.
          videoRef.current.play().catch(() => {});
        } else if (hasLoadedOnceRef.current) {
          // Was fully unloaded (see the mobile-only effect below) to free
          // memory while off-screen — load it back in.
          startLoadingAndPlaying();
        }
      }
    }, { rootMargin: isMobileNow ? '50px' : '100px', threshold: 0.01 });
    visibilityObserver.observe(container);
    return () => visibilityObserver.disconnect();
  }, [isUnsupportedFormat, isShowreel]);

  // Mobile-only: fully release a tile's video (clear its buffered data,
  // not just pause it) once it has scrolled well out of view. Pausing
  // alone still leaves the decoded/buffered data sitting in memory, and
  // with 21 grid videos on this page that adds up fast on a phone over
  // the course of one scroll through the section — a likely contributor
  // to crashes on longer sessions. It reloads automatically (see the
  // effect above) once scrolled back near the viewport. Left out on
  // desktop, which has plenty of memory headroom and shouldn't behave
  // any differently.
  useEffect(() => {
    if (isUnsupportedFormat || isShowreel || !videoLoaded) return;
    if (typeof window === 'undefined' || window.innerWidth >= 768) return;
    const container = containerRef.current;
    if (!container) return;
    const unloadObserver = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting && videoRef.current && !isFullscreenRef.current && !isPlayingRef.current) {
        videoAutoplayQueue.unregisterActive(videoRef.current);
        videoAutoplayQueue.releaseAudio(videoRef.current);
        videoRef.current.removeAttribute('src');
        videoRef.current.load();
        setVideoLoaded(false);
        setHasStartedPlaying(false);
      }
    }, { rootMargin: '800px', threshold: 0 });
    unloadObserver.observe(container);
    return () => unloadObserver.disconnect();
  }, [isUnsupportedFormat, isShowreel, videoLoaded]);

  const handleClick = async () => {
    if (isUnsupportedFormat) {
      // Can't play this format here — open the original file instead of showing a dead tile.
      window.open(src, '_blank', 'noopener,noreferrer');
      return;
    }
    if (!videoRef.current) return;
    if (isPlaying) { videoRef.current.pause(); setIsPlaying(false); }
    else {
      if (!videoLoaded) { setIsLoading(true); videoRef.current.src = src; videoRef.current.load(); hasLoadedOnceRef.current = true; }
      try { setVideoError(false); await videoRef.current.play(); setIsPlaying(true); }
      catch { setIsLoading(false); setVideoError(true); }
    }
  };

  // Make sure a tile never keeps a "slot" in the concurrency cap after it
  // leaves the page (e.g. navigating away mid-play).
  useEffect(() => {
    return () => {
      if (videoRef.current) {
        videoAutoplayQueue.unregisterActive(videoRef.current);
        videoAutoplayQueue.releaseAudio(videoRef.current);
      }
    };
  }, []);

  const toggleFullscreen = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isFullscreen) containerRef.current?.requestFullscreen?.();
    else document.exitFullscreen();
  };

  useEffect(() => {
    const h = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);

  const thumbnailPath = getThumbnailPath();
  const showThumbnail = thumbnailPath && isInView && !hasStartedPlaying;

  return (
    <div
      ref={containerRef}
      className={`relative group cursor-pointer ${aspectClasses} overflow-hidden transition-all duration-300 ${
        isFullscreen
          ? 'fixed inset-0 z-[9999] !rounded-none !aspect-auto w-screen h-screen bg-black'
          : 'video-card'
      } ${className}`}
      style={isFullscreen ? {} : {}}
      onClick={handleClick}
    >
      {/* Thumbnail */}
      {showThumbnail && (
        <ThumbnailImage src={thumbnailPath} alt={`${title} thumbnail`} isFullscreen={isFullscreen}
          isPlaying={false} onLoad={() => setThumbnailLoaded(true)}
          onError={() => setThumbnailLoaded(false)} />
      )}

      {/* Fallback placeholder — shown any time we don't yet have a visible thumbnail or playing video */}
      {!thumbnailLoaded && !hasStartedPlaying && (
        <div className="absolute inset-0 flex items-center justify-center"
             style={{ background: 'linear-gradient(135deg, #1a1a1a 0%, #111 100%)' }}>
          <div className="w-6 h-6 border border-white/20 border-t-white/50 rounded-full animate-spin" />
        </div>
      )}

      {/* Video */}
      {!isUnsupportedFormat && (
        <video ref={videoRef}
          className={`absolute inset-0 w-full h-full ${isFullscreen ? 'object-contain' : 'object-cover'} transition-opacity duration-300 ${hasStartedPlaying ? 'opacity-100' : 'opacity-0'}`}
          loop playsInline preload="auto" muted={isMuted}
          onLoadedData={() => setVideoLoaded(true)}
          onPlay={() => {
            setIsPlaying(true); setHasStartedPlaying(true); setIsLoading(false); setVideoError(false);
            // Counts this tile against the concurrent-decoder cap, evicting
            // (pausing) the oldest active tile if it's now over the limit.
            // The showreel is excluded — it's started by an explicit click,
            // not autoplay, and must never be silently paused just because
            // grid tiles happened to autoplay into view around it.
            if (videoRef.current && !isShowreel) videoAutoplayQueue.registerActive(videoRef.current);
          }}
          onPause={() => {
            setIsPlaying(false);
            if (videoRef.current && !isShowreel) videoAutoplayQueue.unregisterActive(videoRef.current);
          }}
          onEnded={() => {
            setIsPlaying(false);
            if (videoRef.current && !isShowreel) videoAutoplayQueue.unregisterActive(videoRef.current);
          }}
          onVolumeChange={() => {
            // Fires whenever .muted changes — from the mute button, from
            // this tile's own load sequence, or from another tile's
            // requestAudio() muting this one. Keeping it as the single
            // place that syncs state + the shared "audible" slot means
            // only one video on the page can ever play with sound.
            if (!videoRef.current) return;
            const muted = videoRef.current.muted;
            setIsMuted(muted);
            if (muted) videoAutoplayQueue.releaseAudio(videoRef.current);
            else videoAutoplayQueue.requestAudio(videoRef.current);
          }}
          onTimeUpdate={() => {
            if (!videoRef.current || isDragging) return;
            // Throttle to ~4fps — the progress bar doesn't need pixel-perfect
            // updates, and firing setCurrentTime on every frame (~60fps)
            // means 60 React re-renders/sec per visible video tile. With several
            // tiles visible on mobile, that's hundreds of re-renders/sec.
            const now = videoRef.current.currentTime;
            if (Math.abs(now - currentTime) < 0.25) return;
            setCurrentTime(now);
          }}
          onLoadedMetadata={() => { if (videoRef.current) setDuration(videoRef.current.duration); }}
          onError={() => {
            setIsLoading(false); setIsPlaying(false); setVideoError(true);
            if (videoRef.current && !isShowreel) videoAutoplayQueue.unregisterActive(videoRef.current);
          }}
        />
      )}

      {/* Loading */}
      {isLoading && !isUnsupportedFormat && (
        <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-20">
          <div className="w-10 h-10 border border-white/20 border-t-white/70 rounded-full animate-spin" />
        </div>
      )}

      {/* Gradient overlay — always on for mobile (where the title/controls above are always visible too, and need the contrast); hover-reveal only on desktop */}
      {!isFullscreen && (
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-300 z-10" />
      )}

      {/* Unsupported-format / playback-error badge */}
      {(isUnsupportedFormat || videoError) && (
        <div className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-center gap-1.5 py-2 px-2 text-center"
             style={{ background: 'rgba(0,0,0,0.55)' }}>
          <ExternalLink size={11} className="text-white/70 flex-shrink-0" />
          <span className="text-white/80 text-[10px] ibm-font uppercase tracking-wide">
            Preview unavailable here — tap to open
          </span>
        </div>
      )}

      {/* Play/Pause */}
      {!isUnsupportedFormat && (
        <div className="absolute inset-0 flex items-center justify-center z-20">
          <div className={`rounded-full flex items-center justify-center backdrop-blur-sm transition-all duration-300 border border-white/20
            ${aspectRatio === 'vertical' ? (isFullscreen ? 'w-20 h-20' : 'w-11 h-11') : (isFullscreen ? 'w-24 h-24' : 'w-14 h-14')}
            ${(isPlaying && !isLoading) ? 'opacity-0 group-hover:opacity-100 bg-black/40' : 'opacity-100 bg-black/35'}
          `}>
            {isPlaying
              ? <Pause className={`text-white ${aspectRatio === 'vertical' ? (isFullscreen ? 'w-8 h-8' : 'w-4 h-4') : (isFullscreen ? 'w-10 h-10' : 'w-5 h-5')}`} />
              : <Play className={`text-white ml-0.5 ${aspectRatio === 'vertical' ? (isFullscreen ? 'w-8 h-8' : 'w-4 h-4') : (isFullscreen ? 'w-10 h-10' : 'w-5 h-5')}`} />
            }
          </div>
        </div>
      )}

      {/* Top controls */}
      {!isFullscreen && !isUnsupportedFormat && (
        <div className={`absolute top-3 right-3 flex gap-2 z-30 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-300`}>
          <button onClick={(e) => { e.stopPropagation(); if (videoRef.current) videoRef.current.muted = !videoRef.current.muted; }}
            className="w-8 h-8 rounded-full bg-black/60 backdrop-blur-sm flex items-center justify-center border border-white/15 hover:bg-black/80 transition-colors">
            {isMuted ? <VolumeX size={13} className="text-white" /> : <Volume2 size={13} className="text-white" />}
          </button>
          <button onClick={toggleFullscreen}
            className="w-8 h-8 rounded-full bg-black/60 backdrop-blur-sm flex items-center justify-center border border-white/15 hover:bg-black/80 transition-colors">
            <Maximize2 size={13} className="text-white" />
          </button>
        </div>
      )}

      {/* Fullscreen close */}
      {isFullscreen && (
        <button onClick={toggleFullscreen}
          className="absolute top-6 right-6 w-12 h-12 bg-black/60 rounded-full flex items-center justify-center z-30 border border-white/20">
          <X size={20} className="text-white" />
        </button>
      )}

      {/* Progress bar */}
      {videoLoaded && !isUnsupportedFormat && (
        <div ref={progressBarRef}
          className={`absolute left-0 right-0 cursor-pointer z-30 group/bar ${isFullscreen ? 'bottom-16 h-1.5' : 'bottom-0 h-1.5 opacity-100 md:h-0.5 md:opacity-0 md:group-hover:opacity-100'} transition-all duration-300`}
          style={{ background: 'rgba(255,255,255,0.15)', touchAction: 'none' }}
          onClick={(e) => { e.stopPropagation(); }}
          onPointerDown={(e) => {
            e.stopPropagation();
            if (!videoRef.current || !progressBarRef.current) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            setIsDragging(true);
            const r = progressBarRef.current.getBoundingClientRect();
            const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
            videoRef.current.currentTime = p * videoRef.current.duration;
            setCurrentTime(videoRef.current.currentTime);
          }}
          onPointerMove={(e) => {
            if (!isDragging || !videoRef.current || !progressBarRef.current) return;
            e.stopPropagation();
            const r = progressBarRef.current.getBoundingClientRect();
            const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
            videoRef.current.currentTime = p * videoRef.current.duration;
            setCurrentTime(videoRef.current.currentTime);
          }}
          onPointerUp={(e) => { e.stopPropagation(); setIsDragging(false); }}
          onPointerCancel={(e) => { e.stopPropagation(); setIsDragging(false); }}
        >
          <div className="h-full transition-colors group-hover/bar:bg-amber-400"
               style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%`, background: 'rgba(255,255,255,0.8)' }} />
        </div>
      )}

      {/* Title badge */}
      <div className={`absolute bottom-3 left-3 z-20 transition-all duration-300 ${isFullscreen ? 'opacity-100 bottom-8 left-8' : 'opacity-100 md:opacity-0 md:group-hover:opacity-100'}`}>
        <span className="syne text-white text-xs font-semibold bg-black/55 backdrop-blur-sm px-2.5 py-1 rounded-full tracking-wide uppercase border border-white/10">
          {title}
        </span>
        {category && (
          <span className="ml-1.5 text-white/60 text-xs ibm-font hidden sm:inline">{category}</span>
        )}
      </div>
    </div>
  );
}

export default VideoThumbnail;
