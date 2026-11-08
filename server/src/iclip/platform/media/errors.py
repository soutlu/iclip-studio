class MediaError(RuntimeError):
    pass


class NoAudioStream(MediaError):
    pass


__all__ = ["MediaError", "NoAudioStream"]
