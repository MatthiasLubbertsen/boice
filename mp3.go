package main

import (
	"bytes"
	"errors"
	"io"
)

// All clips are stored in one fixed format — MPEG-1 Layer III, 44.1 kHz, mono —
// which the browser produces when recording. Because every clip shares the
// format and each one starts with an empty bit reservoir, an export is just the
// clips' frames written back to back, with hand-built silent frames between
// them. No decoder, encoder or ffmpeg needed on the server.

const (
	mp3SampleRate      = 44100
	mp3SamplesPerFrame = 1152
)

var mp3Bitrates = [16]int{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0}

// silentFrame is a valid 32 kbps mono frame whose side info is all zeros,
// which decodes to 26 ms of digital silence.
var silentFrame = func() []byte {
	f := make([]byte, 104)
	copy(f, []byte{0xFF, 0xFB, 0x10, 0xC4})
	return f
}()

var errBadAudio = errors.New("audio must be an MP3 recorded at 44.1 kHz mono")

// frameLen returns the length of the frame starting at b, or 0 if b does not
// start with a header in the expected format.
func frameLen(b []byte) int {
	if len(b) < 4 || b[0] != 0xFF || b[1]&0xFE != 0xFA { // MPEG-1 Layer III
		return 0
	}
	kbps := mp3Bitrates[b[2]>>4]
	if kbps == 0 || (b[2]>>2)&3 != 0 || b[3]>>6 != 3 { // 44.1 kHz, mono
		return 0
	}
	return 144000*kbps/mp3SampleRate + int(b[2]>>1&1)
}

// cleanMP3 validates an uploaded clip and returns only its audio frames
// (ID3 tags, encoder info frames and junk removed) plus its duration in ms.
func cleanMP3(data []byte) (frames []byte, ms int, err error) {
	// Skip an ID3v2 tag.
	if len(data) > 10 && string(data[:3]) == "ID3" {
		size := int(data[6]&0x7F)<<21 | int(data[7]&0x7F)<<14 | int(data[8]&0x7F)<<7 | int(data[9]&0x7F)
		if 10+size < len(data) {
			data = data[10+size:]
		}
	}
	out := make([]byte, 0, len(data))
	n, junk := 0, 0
	for i := 0; i+4 <= len(data); {
		l := frameLen(data[i:])
		if l == 0 || i+l > len(data) {
			i++
			junk++
			continue
		}
		frame := data[i : i+l]
		i += l
		// The first frame may be a Xing/Info header rather than audio.
		if n == 0 && l > 25 && (bytes.Equal(frame[21:25], []byte("Xing")) || bytes.Equal(frame[21:25], []byte("Info"))) {
			continue
		}
		out = append(out, frame...)
		n++
	}
	if n < 4 || junk > len(data)/4 {
		return nil, 0, errBadAudio
	}
	return out, n * mp3SamplesPerFrame * 1000 / mp3SampleRate, nil
}

func writeSilence(w io.Writer, ms int) error {
	n := (ms*mp3SampleRate/1000 + mp3SamplesPerFrame/2) / mp3SamplesPerFrame
	for ; n > 0; n-- {
		if _, err := w.Write(silentFrame); err != nil {
			return err
		}
	}
	return nil
}
