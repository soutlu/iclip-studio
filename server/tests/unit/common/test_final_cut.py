from __future__ import annotations

from iclip.common.final_cut import MediaAddress, media_addresses

CLIP_URL = "https://media.iclip.test/videos/clip.mp4"
AUDIO_URL = "https://media.iclip.test/audio/music.mp3"


def test_lists_video_and_audio_sources_once_in_order() -> None:
    html = (
        '<!doctype html><html><head><script src="vendor/npm/gsap.min.js"></script></head><body>'
        '<div id="root" data-composition-id="film" data-width="720" data-height="1280">'
        f'<video id="clip-1" class="clip" src="{CLIP_URL}" data-start="0" data-duration="2"'
        " muted playsinline></video>"
        f'<audio id="music-1" class="clip" src="{AUDIO_URL}" data-start="0" data-duration="2"'
        ' data-hidden="true"></audio>'
        f'<video id="clip-2" class="clip" src="{CLIP_URL}" data-start="2" data-duration="2"></video>'
        '<img src="https://media.iclip.test/poster.png">'
        "</div></body></html>"
    )

    assert media_addresses(html) == (
        MediaAddress(url=CLIP_URL, kind="video"),
        MediaAddress(url=AUDIO_URL, kind="audio"),
    )


def test_recognizes_sources_written_by_hand_with_html_escapes() -> None:
    written = (
        '<!doctype html><html><head><!-- 注释 --></head><body><div id="r">'
        "<audio src='https://a.test/x.mp3?a=1&amp;b=2' data-start=\"0\"></audio></div></body></html>"
    )

    assert media_addresses(written) == (
        MediaAddress(url="https://a.test/x.mp3?a=1&b=2", kind="audio"),
    )


def test_keeps_raw_ampersands_that_look_like_entity_names() -> None:
    url = "https://a.test/x.mp4?a=1&timestamp=2&region=cn&copy=3"

    assert media_addresses(f'<video src="{url}"></video>') == (MediaAddress(url=url, kind="video"),)


def test_lists_dubs_of_every_locale_as_audio() -> None:
    english = "https://media.iclip.test/dubbings/en.m4a"
    german = "https://media.iclip.test/dubbings/de.m4a"
    html = (
        '<div data-composition-id="film" data-voice-modes='
        '"{&quot;en&quot;:{&quot;mode&quot;:&quot;dub&quot;,&quot;voice&quot;:null}}">'
        f'<video src="{CLIP_URL}" muted></video>'
        f'<audio src="{english}" data-locale="en" data-dub-of="cap-a1"></audio>'
        f'<audio src="{german}" data-locale="de" data-dub-of="cap-a1"></audio>'
        "</div>"
    )

    assert media_addresses(html) == (
        MediaAddress(url=CLIP_URL, kind="video"),
        MediaAddress(url=english, kind="audio"),
        MediaAddress(url=german, kind="audio"),
    )
